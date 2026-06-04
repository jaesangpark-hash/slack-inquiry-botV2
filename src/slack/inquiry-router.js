/**
 * inquiry-router.js — 문의 분류 라우터 (단일 책임: inquiry_type → flow 디스패치)
 *
 * C-1 결정 = (a) 현행 보존: reaction/message divergence 6건(UD-1·2·6·7·8·9)은
 * ctx.source 플래그로 보존. 동작 0변경.
 *
 * @param {object} deps — DI 주입 (진입점 단일 인스턴스)
 * @returns {{ routeInquiry: function }}
 */
module.exports = function createInquiryRouter(deps) {
  const {
    // 분석
    parseScheduleInquiry,
    parseFileInquiry,
    // 매칭
    matchWorkTitleWithCandidates,
    matchWorkTitleFromSheet,
    matchWorkTitleByTokens,
    // 납품일
    fetchDeliveryDate,
    // APM 이름 → Slack ID 매핑
    resolveApmUserId,
    // 유틸
    generateDraftId,
    // 공유 상태 (진입점 단일 인스턴스 — 복제 금지)
    draftStore,
    // 블록 빌더
    buildFileInquiryBlocks,
    buildFileInquiryReason,
    buildDraftPreviewBlocks,
    buildDraftPreviewText,
    buildOtherInquirySummary,
    buildProgressText,
    // flow
    flows: {
      handleScheduleExt,
      handleMultipleInquiry,
      handleWorkerRelay,
      handleRetakeInquiry,
      handleFileOrderInquiry,
    },
    // RETAKE 채널 Set (진입점에서 주입)
    retakeChannels,
    // RETAKE 스레드 작품명 추출용 AI 분석기 (UD-1, reaction only)
    analyzeInquiryWithAI,
  } = deps;

  /**
   * routeInquiry — inquiry_type ladder 1벌 수행
   *
   * @param {object} ctx — 어댑터가 빌드한 정규화 컨텍스트
   * @param {string}  ctx.source               — "reaction" | "message" (divergence 보존용)
   * @param {object}  ctx.client               — Slack WebClient
   * @param {string}  ctx.dmChannel            — DM 채널 id
   * @param {{ ts: string }} ctx.progressMsg   — progress 메시지
   * @param {function} ctx.updateP             — (step, label?) => updateProgress 클로저
   * @param {object}  ctx.analysis             — analyzeInquiryWithAI 결과
   * @param {string}  ctx.originalText         — cleanSlackText 적용 원문
   * @param {boolean} ctx.hasThreadContext
   * @param {string}  ctx.threadContextText
   * @param {string}  ctx.sourceLink           — permalink (R) | linkInfo.url (M)
   * @param {{ channelId: string, ts: string }} ctx.sourceMeta
   * @param {Array}   ctx.files                — targetMsg.files (R) | linkedMessage.files (M)
   * @param {string}  ctx.requesterUserId      — 문의 작성자 userId
   * @param {string}  ctx.requesterName        — 표시용 이름 (R=실명, M="" — UD-2 보존)
   * @param {string}  ctx.userId               — draft 소유자 (이모지 소환자 / 메시지 작성자)
   * @returns {Promise<void>}  — 부수효과(flow 호출·draftStore.set·chat.update). 오류는 throw.
   */
  async function routeInquiry(ctx) {
    const {
      source,
      client,
      dmChannel,
      progressMsg,
      analysis,
      originalText,
      hasThreadContext,
      threadContextText,
      sourceLink,
      sourceMeta,
      files,
      requesterUserId,
      requesterName,
      userId,
    } = ctx;

    const { channelId, ts } = sourceMeta;

    // ── UD-1: RETAKE 채널 선행분기 (reaction만) ─────────────────────
    // message 어댑터는 linkInfo 기반이라 RETAKE 채널 소환이 구조상 불가 → 의도적 부재 보존
    if (source === "reaction" && retakeChannels.has(channelId)) {
      await client.chat.update({ channel: dmChannel, ts: progressMsg.ts, text: "🔄 내부 수정 채널 감지 — 태스크생성봇으로 처리 중..." });
      let retakeRequesterName = requesterUserId || "";
      try {
        const userInfo = await client.users.info({ user: requesterUserId });
        retakeRequesterName = userInfo.user?.profile?.display_name || userInfo.user?.real_name || retakeRequesterName;
      } catch (_) {}

      // 스레드 맥락이 있으면 AI 분석하여 작품명/회차 추출
      let retakeAnalysis = { title_ja: null, title_ko: null, episode: null };
      if (hasThreadContext) {
        const contextAnalysis = await analyzeInquiryWithAI(threadContextText, true);
        retakeAnalysis = {
          title_ja: contextAnalysis.title_ja || null,
          title_ko: contextAnalysis.title_ko || null,
          episode:  contextAnalysis.episode  || null,
        };
        console.log(`[retake-context] 스레드에서 추출 — title_ja: ${retakeAnalysis.title_ja} | title_ko: ${retakeAnalysis.title_ko} | episode: ${retakeAnalysis.episode}`);
      }

      // 복수 항목 감지: 대괄호 작품명 또는 글머리기호가 2개 이상 별도 줄이면 복수
      const lines     = originalText.split("\n").map(l => l.trim()).filter(l => l);
      const itemLines = lines.filter(l => /^\[.+\]|^\*\s|^・|^•/.test(l));
      if (itemLines.length >= 2) {
        await handleMultipleInquiry(client, dmChannel, originalText, sourceLink, channelId, ts, retakeRequesterName, null, "리테이크", requesterUserId || null);
      } else {
        await handleRetakeInquiry(client, dmChannel, retakeAnalysis, { url: sourceLink }, originalText, retakeRequesterName);
      }
      return;
    }

    // ── ① 스케줄 문의 ────────────────────────────────────────────
    if (analysis.inquiry_type === "스케줄 문의") {
      let parsed, matchedTitle, workNameKo, delivery;
      try {
        const msgDate = new Date(parseInt(ts.split(".")[0]) * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 10);
        parsed = await parseScheduleInquiry(originalText, msgDate);

        const candResult = await matchWorkTitleWithCandidates(parsed.work_title_ja, parsed.work_title_ko).catch(() => null);
        if (candResult?.single) {
          matchedTitle = candResult.single;
        } else if (candResult?.multiple) {
          const pendingId = `sched_pending_${Date.now()}`;
          draftStore.set(pendingId, { type: "schedule_pending", parsed, sourceLink, originalText });
          await client.chat.update({ channel: dmChannel, ts: progressMsg.ts,
            text: `작품명 *${parsed.work_title_ko || parsed.work_title_ja || "-"}* 후보가 여러 개야. 선택해줘.` });
          await client.chat.postMessage({ channel: dmChannel, text: "작품을 선택해줘.",
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: `*작품 후보 ${candResult.multiple.length}건* — 해당하는 작품을 선택해줘.` }},
              { type: "actions", elements: candResult.multiple.map((r, i) => ({
                type: "button", action_id: `schedule_token_pick_${i}`,
                text: { type: "plain_text", text: r.projectName || r.jaDisplay || `후보 ${i+1}` },
                value: JSON.stringify({ pendingId, pivoId: r.pivoId, projectName: r.projectName }),
              }))},
            ],
          });
          return;
        } else if (candResult?.tooMany) {
          const pendingId = `sched_pending_${Date.now()}`;
          draftStore.set(pendingId, { type: "schedule_pending", parsed, sourceLink, originalText });
          await client.chat.update({ channel: dmChannel, ts: progressMsg.ts,
            text: `*${parsed.work_title_ko || parsed.work_title_ja || "-"}* 와 일치하는 작품이 너무 많아. 더 정확한 작품명을 입력해줘.` });
          await client.chat.postMessage({ channel: dmChannel, text: "작품명을 직접 입력해줘.",
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: `AI 추출 작품명: \`${parsed.work_title_ja || parsed.work_title_ko || "없음"}\`` }},
              { type: "actions", elements: [{ type: "button", action_id: "open_schedule_title_modal", text: { type: "plain_text", text: "작품명 직접 입력" }, style: "primary", value: pendingId }]},
            ],
          });
          return;
        } else {
          // null → 토큰 매칭 시도
          const tokenResult = await matchWorkTitleByTokens(parsed.work_title_ko, parsed.work_title_ja).catch(() => null);
          if (tokenResult?.single) {
            matchedTitle = tokenResult.single;
            console.log("[match-token] 단건 자동 선택:", matchedTitle.projectName);
          } else if (tokenResult?.multiple) {
            const pendingId = `sched_pending_${Date.now()}`;
            draftStore.set(pendingId, { type: "schedule_pending", parsed, sourceLink, originalText });
            await client.chat.update({ channel: dmChannel, ts: progressMsg.ts,
              text: `작품명 *${parsed.work_title_ko || parsed.work_title_ja || "-"}* 후보가 여러 개야. 선택해줘.` });
            await client.chat.postMessage({ channel: dmChannel, text: "작품을 선택해줘.",
              blocks: [
                { type: "section", text: { type: "mrkdwn", text: `*작품 후보 ${tokenResult.multiple.length}건* — 해당하는 작품을 선택해줘.` }},
                { type: "actions", elements: tokenResult.multiple.slice(0, 5).map((r, i) => ({
                  type: "button", action_id: `schedule_token_pick_${i}`,
                  text: { type: "plain_text", text: r.projectName || r.jaDisplay || `후보 ${i+1}` },
                  value: JSON.stringify({ pendingId, pivoId: r.pivoId, projectName: r.projectName }),
                }))},
              ],
            });
            return;
          }
        }

        workNameKo = matchedTitle?.projectName || null;

        // UD-6: reaction은 delivery null이어도 그대로 진행 / message는 !matchedTitle||!delivery 시 폴백
        if (source === "reaction") {
          delivery = parsed.episode
            ? await fetchDeliveryDate(workNameKo, parsed.episode, "zh-ja", matchedTitle?.projectName || null).catch(() => null)
            : null;
        } else {
          delivery = workNameKo && parsed.episode
            ? await fetchDeliveryDate(workNameKo, parsed.episode, "zh-ja", matchedTitle?.projectName || null).catch(e => { console.error("[DEBUG] fetchDelivery 오류:", e.message); return null; })
            : null;
          console.log("[DEBUG] delivery:", JSON.stringify(delivery));
        }
      } catch (e) {
        if (source === "reaction") {
          await client.chat.update({ channel: dmChannel, ts: progressMsg.ts, text: `오류: ${e.message}` });
        } else {
          await client.chat.update({ channel: dmChannel, ts: progressMsg.ts, text: `스케줄 처리 오류: ${e.message}` });
        }
        return;
      }

      parsed.originalChannelId = channelId;
      // 결함 C 복원: base는 reaction만 requesterUserId 설정 (app-base:450), message는 미설정 (app-base:784-785)
      // message 스케줄에 요청자 멘션이 base에 없었음 — divergence 보존
      if (source === "reaction") {
        parsed.requesterUserId = requesterUserId || null;
      }
      parsed.originalTs        = ts;

      // UD-6 폴백 처리: message만 !matchedTitle||!delivery 시 직접입력 유도
      if (source === "message" && (!matchedTitle || !delivery)) {
        const pendingId = `sched_pending_${Date.now()}`;
        draftStore.set(pendingId, { type: "schedule_pending", parsed, sourceLink, originalText });
        await client.chat.update({ channel: dmChannel, ts: progressMsg.ts,
          text: !matchedTitle ? `작품명 *${parsed.work_title_ja || parsed.work_title_ko || "-"}* 을 시트에서 찾지 못했어.` : `납품 시트에서 찾지 못했어.` });
        await client.chat.postMessage({ channel: dmChannel, text: "작품명을 직접 입력해줘.",
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: `AI 추출 작품명: \`${parsed.work_title_ja || parsed.work_title_ko || "없음"}\`` }},
            { type: "actions", elements: [{ type: "button", action_id: "open_schedule_title_modal", text: { type: "plain_text", text: "작품명 직접 입력" }, style: "primary", value: pendingId }]},
          ],
        });
        return;
      }

      // reaction: delivery 여부 무관 진행
      if (source === "reaction") {
        await client.chat.update({ channel: dmChannel, ts: progressMsg.ts,
          text: delivery ? `납품 시트 확인 완료 — ${delivery.episodeLabel} 납품일: ${delivery.allSame ? delivery.deliveryDate : "회차별 상이"}` : "납품 시트에서 찾지 못했어. 직접 확인해줘." });
        await handleScheduleExt(client, dmChannel, parsed, matchedTitle, delivery, sourceLink);
      } else {
        // message: delivery 존재 시 진행 (폴백은 위에서 처리됨)
        await client.chat.update({ channel: dmChannel, ts: progressMsg.ts,
          text: `납품 시트 확인 완료 — *${delivery.episodeLabel}* 납품일: *${delivery.allSame ? delivery.deliveryDate : delivery.episodes.map(e => `${e.episode}화:${e.deliveryDate}`).join(", ")}*` });
        await handleScheduleExt(client, dmChannel, parsed, matchedTitle, delivery, sourceLink);
      }
      return;
    }

    // ── ② 복수 문의 ──────────────────────────────────────────────
    if (analysis.inquiry_type === "복수 문의") {
      await client.chat.update({ channel: dmChannel, ts: progressMsg.ts, text: "📋 복수 문의 감지 — 항목별로 분석 중..." });
      if (source === "reaction") {
        // UD-2: reaction만 reqName 실명 조회
        let reqName = requesterUserId || "";
        try {
          const ui = await client.users.info({ user: requesterUserId });
          reqName = ui.user?.profile?.display_name || ui.user?.real_name || reqName;
        } catch (_) {}
        await handleMultipleInquiry(client, dmChannel, originalText, sourceLink, channelId, ts, reqName, analysis.multi_items || null, null, requesterUserId || null);
      } else {
        // UD-2: message는 requesterName="" 빈문자 그대로
        await handleMultipleInquiry(client, dmChannel, originalText, sourceLink, channelId, ts, requesterName, analysis.multi_items || null);
      }
      return;
    }

    // ── ③ 기타 ───────────────────────────────────────────────────
    if (analysis.inquiry_type === "기타") {
      const matchedForSummary = await matchWorkTitleFromSheet(analysis.title_ja, analysis.title_ko).catch(() => null);
      const displayName = matchedForSummary?.projectName || analysis.title_ja || analysis.title_ko || "";
      const titleInfo   = { workName: displayName, episode: analysis.episode || "" };
      const btnValue    = JSON.stringify({ sourceLink, workName: displayName, episode: titleInfo.episode });
      await client.chat.update({ channel: dmChannel, ts: progressMsg.ts, text: buildOtherInquirySummary(analysis, titleInfo) });
      await client.chat.postMessage({ channel: dmChannel,
        text: "필요한 봇을 선택해줘.",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "필요한 봇을 선택해줘." }},
          { type: "actions", elements: [
            { type: "button", action_id: "direct_inquiry_btn",    text: { type: "plain_text", text: "문의봇" },      value: btnValue },
            { type: "button", action_id: "direct_resupply_btn",   text: { type: "plain_text", text: "재수급봇" },    value: btnValue },
            { type: "button", action_id: "direct_schedule_btn",   text: { type: "plain_text", text: "스케줄봇" },    value: btnValue },
            { type: "button", action_id: "direct_fileorder_btn",  text: { type: "plain_text", text: "파일순서봇" },  value: btnValue },
            { type: "button", action_id: "direct_retake_btn",     text: { type: "plain_text", text: "태스크생성봇" }, value: btnValue },
          ]},
        ],
      });
      return;
    }

    // ── ③-b 릴레이/PM문의 경계 모호 → 봇 선택 폴백 (자동 오라우팅 방지) ──
    // route_ambiguous=true & 경계 유형(번역계열↔작업관련문의)일 때만 발동.
    // 릴레이는 원문 스레드 맥락(channelId/ts/files)이 필수라 새 모달로 못 만듦 → 맥락을 draftStore에 stash 후
    // route_pick_relay 핸들러가 handleWorkerRelay를 재실행. PM은 route_pick_inquiry가 분석 결과로 draft 생성.
    if (analysis.route_ambiguous &&
        ["번역문 누락", "번역문 확인", "번역문 수정", "작업 관련 문의"].includes(analysis.inquiry_type)) {
      const matchedForSummary = await matchWorkTitleFromSheet(analysis.title_ja, analysis.title_ko).catch(() => null);
      const displayName = matchedForSummary?.projectName || analysis.title_ja || analysis.title_ko || "";
      const relayImageUrls = (files || [])
        .filter(f => f.mimetype?.startsWith("image/"))
        .map(f => f.url_private || f.permalink || null)
        .filter(Boolean);
      const pendingId = `route_pending_${Date.now()}`;
      draftStore.set(pendingId, {
        type:            "route_pending",
        analysis,
        sourceLink,
        channelId,
        ts,
        dmChannel,
        relayText:       hasThreadContext ? threadContextText : originalText,
        relayImageUrls,
        requesterUserId: requesterUserId || null,
        originalText,
      });
      await client.chat.update({ channel: dmChannel, ts: progressMsg.ts,
        text: `⚠️ 작업자 릴레이인지 PM 문의인지 애매해서 자동 분류를 보류했어. (AI 추정: ${analysis.inquiry_type})` });
      await client.chat.postMessage({ channel: dmChannel, text: "릴레이/문의 중 선택해줘.",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `*${displayName || "작품 미상"}*${analysis.episode ? ` ${analysis.episode}화` : ""}\n작업자에게 바로 전달할 *릴레이* 건인지, PM 판단이 필요한 *문의* 건인지 선택해줘.` }},
          { type: "actions", elements: [
            { type: "button", action_id: "route_pick_relay",   text: { type: "plain_text", text: "작업자 릴레이" },   value: pendingId },
            { type: "button", action_id: "route_pick_inquiry", text: { type: "plain_text", text: "PM 문의(문의봇)" }, style: "primary", value: pendingId },
          ]},
        ],
      });
      return;
    }

    // ── ④ 번역계열 (누락/확인/수정) ─────────────────────────────
    if (["번역문 누락", "번역문 확인", "번역문 수정"].includes(analysis.inquiry_type)) {
      if (source === "reaction") {
        await client.chat.update({ channel: dmChannel, ts: progressMsg.ts, text: "📨 작업자 릴레이 처리 중..." });
      } else {
        await client.chat.update({ channel: dmChannel, ts: progressMsg.ts, text: "📨 작업자 릴레이 처리 중..." });
      }
      const relayImageUrls = (files || [])
        .filter(f => f.mimetype?.startsWith("image/"))
        .map(f => f.url_private || f.permalink || null)
        .filter(Boolean);
      // 스레드 맥락이 있으면 전체 텍스트, 없으면 단일 메시지
      const relayText = hasThreadContext ? threadContextText : originalText;
      await handleWorkerRelay(client, dmChannel, analysis, { url: sourceLink, channelId, ts }, relayText, requesterUserId || null, relayImageUrls);
      return;
    }

    // ── ⑤ 수정&리테이크 (reaction만 — UD-7) ─────────────────────
    // message 어댑터에서는 부재 — 의도적 보존
    if (analysis.inquiry_type === "수정&리테이크") {
      if (source === "reaction") {
        await client.chat.update({ channel: dmChannel, ts: progressMsg.ts, text: "🔄 수정·리테이크 요청 처리 중..." });
        let retakeName = requesterUserId || "";
        try {
          const userInfo = await client.users.info({ user: requesterUserId });
          retakeName = userInfo.user?.profile?.display_name || userInfo.user?.real_name || requesterUserId || "";
        } catch (_) {}
        await handleRetakeInquiry(client, dmChannel, analysis, { url: sourceLink }, originalText, retakeName);
      }
      // UD-7: message 경로는 분기 부재 → ⑧ 기본처리로 자동 폴백 (여기서 return 안 함)
      if (source === "reaction") return;
    }

    // ── ⑥ 원본 파일 순서 ─────────────────────────────────────────
    if (analysis.inquiry_type === "원본 파일 순서") {
      if (source === "reaction") {
        await client.chat.update({ channel: dmChannel, ts: progressMsg.ts, text: "📁 파일 순서 문의 처리 중..." });
        await handleFileOrderInquiry(client, dmChannel, analysis, { url: sourceLink, channelId, ts, requesterUserId: requesterUserId || null }, originalText);
      } else {
        await client.chat.update({ channel: dmChannel, ts: progressMsg.ts, text: "📁 파일 순서 문의 처리 중..." });
        // 결함 A 복원: base message ⑥은 { ...linkInfo, requesterUserId } (app-base:846) — linkInfo는 url/channelId/ts 3키
        // sourceLink = linkInfo.url (ctx 빌드 시 message 어댑터가 linkInfo.url을 sourceLink로 전달)
        // sourceMeta = { channelId: linkInfo.channelId, ts: linkInfo.ts }
        // → url을 명시 포함해야 fileOrderFlow.js(:301,332,360)의 linkInfo?.url이 sourceLink를 채울 수 있음
        await handleFileOrderInquiry(client, dmChannel, analysis, { url: sourceLink, ...sourceMeta, requesterUserId: requesterUserId || null }, originalText);
      }
      return;
    }

    // ── ⑦ 원본 파일 확인 ─────────────────────────────────────────
    if (analysis.inquiry_type === "원본 파일 확인") {
      let fileParsed;
      try { fileParsed = await parseFileInquiry(originalText); } catch (e) { fileParsed = {}; }
      const matchedTitle = await matchWorkTitleFromSheet(fileParsed.work_title_ja || analysis.title_ja, fileParsed.work_title_ko || analysis.title_ko).catch(() => null);

      // UD-8: reaction만 수동 입력 모달, message는 "-" draft 진행
      if (source === "reaction" && !matchedTitle) {
        const pendingId = `fi_pending_${Date.now()}`;
        draftStore.set(pendingId, {
          type:        "file_inquiry_pending",
          workName:    fileParsed.work_title_ko || fileParsed.work_title_ja || "",
          episode:     fileParsed.episode || "",
          fileNumbers: fileParsed.file_numbers || [],
          reason:      fileParsed.reason_raw || "",
          sourceLink,
          dmChannelId:       dmChannel,
          originalChannelId: channelId,
          originalTs:        ts,
        });
        await client.chat.update({ channel: dmChannel, ts: progressMsg.ts,
          text: `시트에서 *${fileParsed.work_title_ko || fileParsed.work_title_ja || "작품명"}* 을 찾지 못했어.` });
        await client.chat.postMessage({ channel: dmChannel, text: "작품명을 직접 입력해줘.",
          blocks: [
            { type: "section", text: { type: "mrkdwn",
              text: `*📦 원본 재수급 요청*\n⚠️ 작품명을 시트에서 찾지 못했어.\nAI 추출값: \`${fileParsed.work_title_ko || fileParsed.work_title_ja || "없음"}\`` }},
            { type: "actions", elements: [
              { type: "button", action_id: "open_file_inquiry_modal",
                text: { type: "plain_text", text: "정보 직접 입력" },
                style: "primary", value: pendingId },
            ]},
          ],
        });
        return;
      }

      // 납품일 + APM 조회 (모든 재수급 경로 일관 — 회차 형식 무관, fetchDeliveryDate 내부 parseEpisodeNumbers가 정규화)
      const fiDeliveryQueryName = matchedTitle?.projectName || fileParsed.work_title_ko || fileParsed.work_title_ja || null;
      const fiDeliveryRes = (fetchDeliveryDate && fiDeliveryQueryName && fileParsed.episode)
        ? await fetchDeliveryDate(fiDeliveryQueryName, fileParsed.episode, "zh-ja", matchedTitle?.projectName || null).catch(() => null)
        : null;
      const fiDeliveryDate = fiDeliveryRes
        ? (fiDeliveryRes.allSame ? fiDeliveryRes.deliveryDate : fiDeliveryRes.episodes?.map(e => `${e.episode}화:${e.deliveryDate}`).join(", "))
        : "-";

      // message: matchedTitle?.optional chaining으로 "-" 채워 draft 진행 (UD-8 보존)
      const draftId = generateDraftId();
      const draft = {
        draftId,
        dmChannelId:       dmChannel,
        originalChannelId: channelId,
        originalTs:        ts,
        workName:    matchedTitle?.projectName || matchedTitle?.ko || fileParsed.work_title_ko || fileParsed.work_title_ja || "-",
        jpTitle:     matchedTitle?.jpTitle || "-",
        pivoId:      matchedTitle?.pivoId  || null,
        episode:     fileParsed.episode    || "-",
        fileNumbers: fileParsed.file_numbers || [],
        reason:      buildFileInquiryReason(fileParsed, matchedTitle),
        deliveryDate: fiDeliveryDate,
        apmName:     fiDeliveryRes?.apm || null,
        apmUserId:   (typeof resolveApmUserId === "function") ? resolveApmUserId(fiDeliveryRes?.apm || null) : null,
        sourceLink,
      };
      draftStore.set(draftId, draft);
      await client.chat.update({ channel: dmChannel, ts: progressMsg.ts, text: "원본 파일 재수급 요청 초안을 만들었어." });
      await client.chat.postMessage({ channel: dmChannel, text: "원본 재수급 요청 초안", blocks: buildFileInquiryBlocks(draft) });
      return;
    }

    // ── ⑧ 기본 처리 (매칭 → draft) ──────────────────────────────
    let matchedTitle = null;
    if (analysis.title_ja || analysis.title_ko) {
      const candResult = await matchWorkTitleWithCandidates(analysis.title_ja, analysis.title_ko).catch(() => null);
      if (candResult?.single) {
        matchedTitle = candResult.single;
      } else if (candResult?.multiple || candResult?.tooMany) {
        const pendingId = `pending_${Date.now()}`;
        draftStore.set(pendingId, {
          isPending:      true,
          userId,
          dmChannelId:    dmChannel,
          progressTs:     progressMsg.ts,
          sourceLink,
          originalText,
          titleJa:        analysis.title_ja,
          inquiryType:    analysis.inquiry_type,
          inquiryContent: analysis.translated_ko,
          summary:        analysis.summary_ko,
          actionRequired: analysis.action_required,
          priority:       analysis.priority,
          sourceLang:     analysis.source_lang,
        });
        if (candResult?.multiple) {
          await client.chat.update({ channel: dmChannel, ts: progressMsg.ts,
            text: `작품명 *${analysis.title_ko || analysis.title_ja || "-"}* 후보가 여러 개야. 선택해줘.` });
          await client.chat.postMessage({ channel: dmChannel, text: "작품을 선택해줘.",
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: `*작품 후보 ${candResult.multiple.length}건* — 해당하는 작품을 선택해줘.` }},
              { type: "actions", elements: candResult.multiple.map((r, i) => ({
                type: "button", action_id: `inquiry_cand_pick_${i}`,
                text: { type: "plain_text", text: r.projectName || r.jaDisplay || `후보 ${i+1}` },
                value: JSON.stringify({ pendingId, pivoId: r.pivoId, projectName: r.projectName }),
              }))},
            ],
          });
        } else {
          await client.chat.update({ channel: dmChannel, ts: progressMsg.ts,
            text: `*${analysis.title_ko || analysis.title_ja || "-"}* 와 일치하는 작품이 너무 많아. 더 정확한 작품명을 입력해줘.` });
          await client.chat.postMessage({ channel: dmChannel, text: "작품명을 직접 입력해줘.",
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: `AI 추출 작품명: \`${analysis.title_ja || analysis.title_ko || "없음"}\`` }},
              { type: "actions", elements: [{ type: "button", action_id: "open_manual_title_modal", text: { type: "plain_text", text: "작품명 직접 입력" }, style: "primary", value: pendingId }]},
            ],
          });
        }
        return;
      }
    }

    await client.chat.update({ channel: dmChannel, ts: progressMsg.ts, text: buildProgressText(4, "시트 매칭 완료") });

    if (!matchedTitle) {
      const pendingId = `pending_${Date.now()}`;
      draftStore.set(pendingId, {
        isPending:      true,
        userId,
        dmChannelId:    dmChannel,
        progressTs:     progressMsg.ts,
        sourceLink,
        originalText,
        titleJa:        analysis.title_ja,
        inquiryType:    analysis.inquiry_type,
        inquiryContent: analysis.translated_ko,
        summary:        analysis.summary_ko,
        actionRequired: analysis.action_required,
        priority:       analysis.priority,
        sourceLang:     analysis.source_lang,
      });
      await client.chat.update({ channel: dmChannel, ts: progressMsg.ts, text: `시트에서 *${analysis.title_ja || analysis.title_ko || "작품명"}* 을 찾지 못했어.` });
      await client.chat.postMessage({ channel: dmChannel, text: "작품명을 직접 입력해줘.",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `AI 추출 작품명: \`${analysis.title_ja || analysis.title_ko || "없음"}\`` }},
          { type: "actions", elements: [{ type: "button", action_id: "open_manual_title_modal", text: { type: "plain_text", text: "작품명 직접 입력" }, style: "primary", value: pendingId }]},
        ],
      });
      return;
    }

    const draftId = generateDraftId();
    const draft = {
      draftId,
      userId,
      dmChannelId:      dmChannel,
      progressMessageTs: progressMsg.ts,
      sourceLink,
      originalText,
      originalChannelId: channelId,
      originalTs:        ts,
      workName:      matchedTitle.projectName || matchedTitle.ko || analysis.title_ko || analysis.title_ja || "",
      workNameKo:    matchedTitle.ko || "",
      pivoId:        matchedTitle.pivoId || null,
      episode:       analysis.episode || null,
      inquiryType:   analysis.inquiry_type    || "기타",
      inquiryContent: analysis.translated_ko  || "",
      summary:       analysis.summary_ko      || "",
      actionRequired: analysis.action_required|| "",
      sourceLang:    analysis.source_lang     || "ja",
      // UD-9: hasThreadContext는 reaction ctx만 포함 (message draft에는 필드 없음)
      ...(source === "reaction" ? { hasThreadContext } : {}),
    };
    draftStore.set(draftId, draft);
    await client.chat.update({
      channel: dmChannel,
      ts:      progressMsg.ts,
      text:    buildDraftPreviewText(draft),
      blocks:  buildDraftPreviewBlocks(draft),
    });
  }

  return { routeInquiry };
};
