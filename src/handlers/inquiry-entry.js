/**
 * inquiry-entry.js — 이모지 소환 / 링크 소환 진입 어댑터
 *
 * 단일 책임: reaction/message 진입을 정규화해 inquiryRouter.routeInquiry(ctx)로 위임.
 * 비즈니스 분류 로직은 inquiry-router.js에 있으며 이 모듈은 Slack 이벤트 파싱만 담당한다.
 *
 * @param {App}    app  — Bolt App 인스턴스
 * @param {object} deps — DI 주입 의존성
 */
module.exports = function (app, deps) {
  const {
    inquiryRouter,
    // 공통 유틸
    cleanSlackText,
    analyzeInquiryWithAI,
    buildProgressText,
    updateProgress,
    withTimeout,
    // reaction 어댑터 전용
    checkPermission,
    isTriggerReaction,
    triggerEmoji,
    fetchThreadContext,
    buildThreadContextText,
    markInquiryProcessed,
    // message 어댑터 전용
    extractSlackPermalink,
    fetchSingleLinkedMessage,
    processedMessageTs,
    // RETAKE 채널 선행 판정 (결함 B: 메인 AI 분석 전 skip — base 동작 복원)
    retakeChannels,
  } = deps;

  // ── 이모지 반응 트리거 (reaction 어댑터) ────────────────────────
  app.event("reaction_added", async ({ event, client }) => {
    try {
      const emoji = event.reaction;
      if (!isTriggerReaction(emoji, triggerEmoji)) return;

      const channelId = event.item.channel;
      const ts        = event.item.ts;
      const userId    = event.user;

      // UD-3: 권한 게이트 (reaction만 — message 어댑터에 절대 추가 금지)
      const permResult = await checkPermission(userId);

      if (!permResult.allowed) {
        try {
          await client.chat.postEphemeral({ channel: channelId, user: userId, text: "⚠️ 문의봇은 APM만 사용할 수 있습니다. 문의사항은 담당 APM에게 연락해주세요." });
        } catch (_) {}
        return;
      }

      // 원문 메시지 조회 (채널 히스토리 → 스레드 replies 폴백)
      let targetMsg = null;
      try {
        const res = await client.conversations.history({ channel: channelId, oldest: ts, latest: ts, inclusive: true, limit: 1 });
        targetMsg = res.messages?.[0]?.ts === ts ? res.messages[0] : null;
      } catch (_) {}

      if (!targetMsg) {
        try {
          const threadTs = event.item.thread_ts || ts;
          const replyRes = await client.conversations.replies({ channel: channelId, ts: threadTs, oldest: ts, inclusive: true, limit: 20 });
          targetMsg = replyRes.messages?.find(m => m.ts === ts) || null;
        } catch (_) {}
      }
      if (!targetMsg) return;

      // 스레드 맥락 조회
      const threadTs          = targetMsg.thread_ts || event.item.thread_ts || null;
      const threadMessages    = await fetchThreadContext(client, channelId, ts, threadTs);
      const hasThreadContext  = threadMessages.length > 1;
      const threadContextText = hasThreadContext ? buildThreadContextText(threadMessages) : "";

      console.log(`[thread-context] 소환 위치: ${threadTs ? "스레드 댓글" : "단일 메시지"} | 맥락 메시지: ${threadMessages.length}개 | targetMsg.thread_ts: ${targetMsg.thread_ts || "null"}`);

      const originalText = cleanSlackText(targetMsg.text || "");
      if (!originalText) return;

      const dmRes     = await client.conversations.open({ users: userId });
      const dmChannel = dmRes.channel.id;
      const permalink = `https://slack.com/archives/${channelId}/p${ts.replace(".", "")}`;

      if (isTriggerReaction(emoji, triggerEmoji)) {
        const progressMsg = await client.chat.postMessage({ channel: dmChannel, text: buildProgressText(0, "요청을 받았어.") });

        await withTimeout(async () => {
          // 결함 B 복원: base는 RETAKE 채널 선행분기가 메인 analyzeInquiryWithAI 이전에 early-return (app-base:342-372)
          // RETAKE 채널은 메인 AI 분석 미경유 — router 내부 UD-1 분기(: 89)가 자체 analyzeInquiryWithAI 호출 별도 처리
          // 어댑터에서 RETAKE 채널 판정을 메인 분석 전에 선행해 base 동작(메인 분석 0회) 복원
          const isRetakeChannel = retakeChannels.has(channelId);

          let analysis;
          if (isRetakeChannel) {
            // RETAKE 채널: 메인 analyzeInquiryWithAI 스킵 (base 동작 보존)
            // router UD-1 내부에서 hasThreadContext 시 contextAnalysis 자체 호출
            analysis = { inquiry_type: null };
          } else {
            const analysisText = hasThreadContext ? threadContextText : originalText;
            const msgDate = new Date(parseInt(ts.split(".")[0]) * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 10);
            analysis = await analyzeInquiryWithAI(analysisText, hasThreadContext, msgDate);
            console.log(`[DEBUG] reaction inquiry_type: ${analysis.inquiry_type} | title_ja: ${analysis.title_ja} | title_ko: ${analysis.title_ko} | 스레드맥락: ${hasThreadContext ? "O" : "X"}`);
          }

          const ctx = {
            source:          "reaction",
            client,
            dmChannel,
            progressMsg,
            analysis,
            originalText,
            hasThreadContext,
            threadContextText,
            sourceLink:  permalink,
            sourceMeta:  { channelId, ts },
            files:       targetMsg.files || [],
            requesterUserId: targetMsg.user || null,
            // UD-2: reaction은 router 내부에서 reqName 조회 (requesterName은 "" 초기값)
            requesterName: "",
            userId,
          };

          await inquiryRouter.routeInquiry(ctx);
        }, { dmChannel, client, label: "이모지 소환" });

        // withTimeout 정상 완료 → 대응완료 이모지 부착
        await markInquiryProcessed(client, channelId, ts);
      }

    } catch (error) {
      console.error("reaction_added 오류:", error.message);
    }
  });

  // ── DM 링크 소환 (message 어댑터) ────────────────────────────────
  app.message(async ({ message, say, client }) => {
    try {
      if (message.subtype || message.bot_id) return;
      if (message.channel_type !== "im") return;

      // message dedup (Set 기반 — reaction dedup과 메커니즘 상이)
      const key = message.channel + ":" + message.ts;
      if (processedMessageTs.has(key)) return;
      processedMessageTs.add(key);
      if (processedMessageTs.size > 1000) processedMessageTs.clear();

      const progressMsg = await say(buildProgressText(0, "요청을 받았어."));
      const userText    = cleanSlackText(message.text || "");
      const linkInfo    = extractSlackPermalink(userText);

      // ── DM 직접 소환 키워드 감지 (withTimeout 밖 — message만) ──
      if (!linkInfo) {
        const BOT_KEYWORDS = {
          재수급봇:    { label: "원본 재수급 요청",   action: "direct_resupply_btn" },
          스케줄봇:    { label: "스케줄 조회/변경",   action: "direct_schedule_btn" },
          문의봇:      { label: "일반 문의 초안 작성", action: "direct_inquiry_btn" },
          파일순서봇:  { label: "파일 순서 수정",      action: "direct_fileorder_btn" },
          태스크생성봇: { label: "태스크 재생성",      action: "direct_retake_btn" },
        };
        const matched = Object.entries(BOT_KEYWORDS).find(([kw]) => userText.includes(kw));
        if (matched) {
          const [kw, { label, action }] = matched;
          await app.client.chat.update({ channel: message.channel, ts: progressMsg.ts,
            text: `${kw} 소환됐어. 아래 버튼을 눌러서 정보를 입력해줘.`,
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: `*${kw}* 소환됐어. 버튼을 눌러서 ${label} 정보를 입력해줘.` }},
              { type: "actions", elements: [
                { type: "button", action_id: action, text: { type: "plain_text", text: `${label} 입력하기` }, style: "primary", value: "direct" },
              ]},
            ],
          });
          return;
        }
        await app.client.chat.update({ channel: message.channel, ts: progressMsg.ts, text: "Slack 메시지 링크를 보내줘.\n봇을 직접 소환하려면: `재수급봇` / `스케줄봇` / `문의봇` / `파일순서봇` / `태스크생성봇` 을 입력해줘." });
        return;
      }

      await updateProgress(message.channel, progressMsg.ts, 1, "링크 확인 완료");

      await withTimeout(async () => {
        const linkedMessage = await fetchSingleLinkedMessage(client, linkInfo.channelId, linkInfo.ts);
        if (!linkedMessage) {
          await app.client.chat.update({ channel: message.channel, ts: progressMsg.ts, text: "링크된 메시지를 찾을 수 없어." });
          return;
        }
        await updateProgress(message.channel, progressMsg.ts, 2, "원문 메시지 조회 완료");

        const originalText = cleanSlackText(linkedMessage.text || "");
        if (!originalText) {
          await app.client.chat.update({ channel: message.channel, ts: progressMsg.ts, text: "메시지 내용이 비어 있어." });
          return;
        }

        const msgDate = new Date(parseInt(linkInfo.ts.split(".")[0]) * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 10);
        const analysis = await analyzeInquiryWithAI(originalText, false, msgDate);
        await updateProgress(message.channel, progressMsg.ts, 3, "AI 분석 완료");
        console.log("[DEBUG] inquiry_type:", analysis.inquiry_type, "| title_ja:", analysis.title_ja, "| title_ko:", analysis.title_ko);

        const ctx = {
          source:          "message",
          client:          app.client,
          dmChannel:       message.channel,
          progressMsg,
          analysis,
          originalText,
          hasThreadContext:  false,
          threadContextText: "",
          sourceLink:   linkInfo.url,
          sourceMeta:   { channelId: linkInfo.channelId, ts: linkInfo.ts },
          files:        linkedMessage.files || [],
          requesterUserId: linkedMessage.user || null,
          // UD-2: message는 requesterName="" 빈문자 그대로
          requesterName: "",
          userId:       message.user,
        };

        await inquiryRouter.routeInquiry(ctx);
      }, { dmChannel: message.channel, client: app.client, label: "링크 소환" }).catch(() => {});

    } catch (error) {
      console.error(error);
      await app.client.chat.postMessage({ channel: message.channel, text: "처리 중 오류: " + error.message });
    }
  });
};
