/**
 * inquiry-router.js — 문의 분류 라우터 (단일 책임: inquiry_type → flow 디스패치)
 *
 * C-1 결정 = (a) 현행 보존: reaction/message divergence 6건(UD-1·2·6·7·8·9)은
 * ctx.source 플래그로 보존. 동작 0변경.
 *
 * @param {object} deps — DI 주입 (진입점 단일 인스턴스)
 * @returns {{ routeInquiry: function }}
 */
const { extractPivoIdGuess } = require("../utils/pivo-id");
const { buildCandidateBlocks, buildManualEntryBlocks } = require("./work-picker-blocks");
const { emojiForLangPair } = require("../utils/trigger");

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
    // 소환 이모지 맵 — 「반대 언어였다」 안내에서 이모지 이름을 되찾는 데 쓴다
    triggerEmojis,
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
      // 소환 이모지가 가리킨 언어쌍. 메시지(DM 링크) 경로엔 신호가 없어 null 이다.
      // ★이 값이 있으면 제목 매칭은 **그 언어만** 본다(하드 필터). 반대 언어 작품을 조용히
      //   집지 않는다. 못 찾으면 매처가 wrongLang 으로 알려 주고 아래에서 안내한다.
      //   PIVO ID 조회는 거르지 않는다 — ID 는 그 자체로 작품을 특정한다.
      langPair = null,
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

      // 스레드 맥락이 있으면 AI 분석하여 작품명/회차/PIVO ID 추출
      let retakeAnalysis = { title_ja: null, title_ko: null, episode: null, pivoId: null };
      if (hasThreadContext) {
        const contextAnalysis = await analyzeInquiryWithAI(threadContextText, true);
        retakeAnalysis = {
          title_ja: contextAnalysis.title_ja || null,
          title_ko: contextAnalysis.title_ko || null,
          episode:  contextAnalysis.episode  || null,
          pivoId:   contextAnalysis.pivo_id  || null,
        };
        console.log(`[retake-context] 스레드에서 추출 — title_ja: ${retakeAnalysis.title_ja} | title_ko: ${retakeAnalysis.title_ko} | episode: ${retakeAnalysis.episode} | pivoId: ${retakeAnalysis.pivoId}`);
      }

      // 복수 항목 감지 ① — "{pivoId} | [브랜드] 작품명 / 화수 PIVO 납품" 고정 헤더 템플릿에서
      // 화수를 직접 추출해 헤더가 2개 이상이면 복수(서로 다른 화수 요청이 한 메시지에 묶인 경우).
      // 파일N 라벨 개수와 무관하게 헤더 자체를 세므로, 화수 판단이 실제 화수 정보를 근거로 이뤄짐.
      const lines        = originalText.split("\n").map(l => l.trim()).filter(l => l);
      const HEADER_RE    = /^[-*・•]?\s*(\d+)\s*\|\s*\[.+?\]\s*.+?\/\s*(\d+)\s*PIVO\s*납품/;
      const headerMatches   = lines.map(l => l.match(HEADER_RE)).filter(Boolean);
      let headerEpisodes    = headerMatches.map(m => m[2]);

      // ★위 템플릿("PIVO ID | [브랜드] 작품명 / 회차 PIVO 납품")에 안 맞는 형식이 실제로 더 많다.
      //   납품 스레드엔 PIVO ID 없이 탭으로만 구분된 줄이 섞여 온다(실측 1,500줄+):
      //     [카카오픽코마] 뱀파이어님의 대리식사⇥247 PIVO납품
      //     [카카오픽코마] 19금 로판에 친구와 빙의될 확률 APP⇥⇥51 PIVO 납품
      //   이걸 못 읽으면 AI가 스레드 전체에서 다른 작품의 숫자를 끌어다 쓴다(78화 오독의 원인).
      //   회차는 **작품명 뒤 구분자 다음의 맨 앞 숫자**다 — 납품시트 Job name 928개 고유 패턴을
      //   전수 대조해 확정했다(「164 外伝11」=164, 「178 外伝25 (완결)」=178, 예외 0건).
      //   제목 속 숫자(19금·100가지·11번째)는 구분자 앞이라 안 걸린다.
      if (!headerEpisodes.length) {
        // 구분자는 탭 · 연속공백 · 슬래시 셋 다 온다(실측 비율: 「/」 897 > 탭 10).
        const ALT_RE = /^[-*・•]?\s*\[[^\]]+\]\s*\S.*?(?:\t+|\s{2,}|\s*\/\s*)(\d+(?:\s*[-~]\s*\d+)?)\b/;
        headerEpisodes = lines
          .filter(l => !/^~.*~$/.test(l))                                   // 취소선 = 취소된 건
          .filter(l => !/\[(납품일\s*변경|.*납품\s*예정|홀딩|보류)\]/.test(l))  // 납품 요청 아님
          .filter(l => /PIVO\s*납품/i.test(l))
          .map(l => l.match(ALT_RE)).filter(Boolean)
          .map(m => m[1].replace(/\s+/g, ""));
        if (headerEpisodes.length) console.log(`[retake-header] 탭 구분 형식에서 회차 ${headerEpisodes.length}건 추출: ${headerEpisodes.join(", ")}`);
      }
      // 헤더에서 회차를 찾았는데 AI가 다른 값을 넣었으면 헤더를 믿는다(AI는 스레드 전체를 본다).
      if (headerEpisodes.length === 1 && retakeAnalysis.episode !== headerEpisodes[0]) {
        if (retakeAnalysis.episode) console.log(`[retake-header] 회차 교정: AI "${retakeAnalysis.episode}" → 헤더 "${headerEpisodes[0]}"`);
        retakeAnalysis.episode = headerEpisodes[0];
      }
      // AI가 못 잡았을 때만 헤더 템플릿 선두 숫자(PIVO ID)로 보완 — 단건일 때만 채택
      if (!retakeAnalysis.pivoId && headerMatches.length === 1) {
        retakeAnalysis.pivoId = headerMatches[0][1];
      }
      // 그래도 없으면 원문 전체에서 고립된 6자리 숫자 1건을 최후 추정치로 채택
      if (!retakeAnalysis.pivoId) {
        retakeAnalysis.pivoId = extractPivoIdGuess(originalText);
      }

      // 복수 항목 감지 ② — 위 헤더 템플릿에 안 맞는 메시지용 폴백: 대괄호 작품명 또는
      // 글머리기호가 2개 이상 별도 줄이면 복수. 단, "파일N #M" 류 파일/컷 단위 라벨은 제외
      // — 동일 화수 내 수정 포인트 구분용이지 별도 작품/화수가 아님.
      const itemLines = lines.filter(l => {
        if (!/^\[.+\]|^\*\s|^・|^•/.test(l)) return false;
        const stripped = l.replace(/^[*・•]\s*/, "");
        return !/^파일\s*\d+\s*#?\d*\s*$/.test(stripped);
      });
      if (headerEpisodes.length >= 2 || itemLines.length >= 2) {
        await handleMultipleInquiry(client, dmChannel, originalText, sourceLink, channelId, ts, retakeRequesterName, null, "리테이크", requesterUserId || null, userId, sourceMeta.threadTs, langPair);
      } else {
        // sourceMeta 관통(fileOrder와 동일): 리테이크 감시행이 납품 스레드(watchChannel/watchThreadTs)를 알아야 함
        await handleRetakeInquiry(client, dmChannel, retakeAnalysis, { url: sourceLink, ...sourceMeta }, originalText, retakeRequesterName, requesterUserId || null, userId, langPair);
      }
      return;
    }

    // ── ① 스케줄 문의 ────────────────────────────────────────────
    if (analysis.inquiry_type === "스케줄 문의") {
      let parsed, matchedTitle, workNameKo, delivery;
      try {
        const msgDate = new Date(parseInt(ts.split(".")[0]) * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 10);
        parsed = await parseScheduleInquiry(originalText, msgDate);

        const candResult = await matchWorkTitleWithCandidates(parsed.work_title_ja, parsed.work_title_ko, null, langPair).catch(() => null);
        if (candResult?.single) {
          matchedTitle = candResult.single;
        } else if (candResult?.multiple) {
          const pendingId = `sched_pending_${Date.now()}`;
          draftStore.set(pendingId, { type: "schedule_pending", ownerUserId: userId, parsed, sourceLink, originalText });
          await client.chat.update({ channel: dmChannel, ts: progressMsg.ts,
            text: `작품명 *${parsed.work_title_ko || parsed.work_title_ja || "-"}* 후보가 여러 개야. 선택해줘.` });
          await client.chat.postMessage({ channel: dmChannel, text: "작품을 선택해줘.",
            blocks: buildCandidateBlocks({
              candidates: candResult.multiple, pendingId,
              actionIdPrefix: "schedule_token_pick_",
              manualActionId: "open_schedule_title_modal", manualLabel: "✏️ 직접 입력 (작품명·PIVO ID)",
            }),
          });
          return;
        } else if (candResult?.tooMany) {
          const pendingId = `sched_pending_${Date.now()}`;
          draftStore.set(pendingId, { type: "schedule_pending", ownerUserId: userId, parsed, sourceLink, originalText });
          await client.chat.update({ channel: dmChannel, ts: progressMsg.ts,
            text: `*${parsed.work_title_ko || parsed.work_title_ja || "-"}* 와 일치하는 작품이 너무 많아. 더 정확한 작품명을 입력해줘.` });
          await client.chat.postMessage({ channel: dmChannel, text: "작품명을 직접 입력해줘.",
            blocks: buildManualEntryBlocks({
              pendingId, manualActionId: "open_schedule_title_modal", manualLabel: "✏️ 직접 입력 (작품명·PIVO ID)",
              titleHint: parsed.work_title_ja || parsed.work_title_ko,
            }),
          });
          return;
        } else {
          // null(또는 wrongLang) → 토큰 매칭 시도.
          // ★langPair 를 꼭 넘긴다. 안 넘기면 양쪽 마스터를 다 뒤져서 반대 언어 작품을
          //   조용히 채택한다 — 하드 필터를 둔 이유가 바로 그걸 막으려는 것이다.
          const tokenResult = await matchWorkTitleByTokens(parsed.work_title_ko, parsed.work_title_ja, null, langPair).catch(() => null);
          if (tokenResult?.single) {
            matchedTitle = tokenResult.single;
            console.log("[match-token] 단건 자동 선택:", matchedTitle.koreanProjectName);
          } else if (tokenResult?.multiple) {
            const pendingId = `sched_pending_${Date.now()}`;
            draftStore.set(pendingId, { type: "schedule_pending", ownerUserId: userId, parsed, sourceLink, originalText });
            await client.chat.update({ channel: dmChannel, ts: progressMsg.ts,
              text: `작품명 *${parsed.work_title_ko || parsed.work_title_ja || "-"}* 후보가 여러 개야. 선택해줘.` });
            await client.chat.postMessage({ channel: dmChannel, text: "작품을 선택해줘.",
              blocks: buildCandidateBlocks({
                candidates: tokenResult.multiple, pendingId,
                actionIdPrefix: "schedule_token_pick_",
              manualActionId: "open_schedule_title_modal", manualLabel: "✏️ 직접 입력 (작품명·PIVO ID)",
              }),
            });
            return;
          }
        }

        workNameKo = matchedTitle?.koreanProjectName || null;

        // UD-6: reaction은 delivery null이어도 그대로 진행 / message는 !matchedTitle||!delivery 시 폴백
        if (source === "reaction") {
          delivery = parsed.episode
            ? await fetchDeliveryDate(workNameKo, parsed.episode, matchedTitle?.lang || "zh-ja" /* 납품 탭은 이모지가 아니라 확정된 작품이 고른다 */, matchedTitle?.koreanProjectName || null).catch(() => null)
            : null;
        } else {
          delivery = workNameKo && parsed.episode
            ? await fetchDeliveryDate(workNameKo, parsed.episode, matchedTitle?.lang || "zh-ja" /* 납품 탭은 이모지가 아니라 확정된 작품이 고른다 */, matchedTitle?.koreanProjectName || null).catch(e => { console.error("[DEBUG] fetchDelivery 오류:", e.message); return null; })
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
      parsed.ownerUserId       = userId;
      // 결함 C 복원: base는 reaction만 requesterUserId 설정 (app-base:450), message는 미설정 (app-base:784-785)
      // message 스케줄에 요청자 멘션이 base에 없었음 — divergence 보존
      if (source === "reaction") {
        parsed.requesterUserId = requesterUserId || null;
      }
      parsed.originalTs        = ts;

      // UD-6 폴백 처리: message만 !matchedTitle||!delivery 시 직접입력 유도
      if (source === "message" && (!matchedTitle || !delivery)) {
        const pendingId = `sched_pending_${Date.now()}`;
        draftStore.set(pendingId, { type: "schedule_pending", ownerUserId: userId, parsed, sourceLink, originalText });
        await client.chat.update({ channel: dmChannel, ts: progressMsg.ts,
          text: !matchedTitle ? `작품명 *${parsed.work_title_ja || parsed.work_title_ko || "-"}* 을 시트에서 찾지 못했어.` : `납품 시트에서 찾지 못했어.` });
        await client.chat.postMessage({ channel: dmChannel, text: "작품명을 직접 입력해줘.",
          blocks: buildManualEntryBlocks({
            pendingId, manualActionId: "open_schedule_title_modal", manualLabel: "✏️ 직접 입력 (작품명·PIVO ID)",
            titleHint: parsed.work_title_ja || parsed.work_title_ko,
          }),
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
        await handleMultipleInquiry(client, dmChannel, originalText, sourceLink, channelId, ts, reqName, analysis.multi_items || null, null, requesterUserId || null, userId, sourceMeta.threadTs, langPair);
      } else {
        // UD-2: message는 requesterName="" 빈문자 그대로
        await handleMultipleInquiry(client, dmChannel, originalText, sourceLink, channelId, ts, requesterName, analysis.multi_items || null, null, null, userId, sourceMeta.threadTs, langPair);
      }
      return;
    }

    // ── ③ 기타 ───────────────────────────────────────────────────
    if (analysis.inquiry_type === "기타") {
      const matchedForSummary = await matchWorkTitleFromSheet({ titleJa: analysis.title_ja, titleKo: analysis.title_ko, langPair }).catch(() => null);
      const displayName = matchedForSummary?.koreanProjectName || analysis.title_ja || analysis.title_ko || "";
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
      const matchedForSummary = await matchWorkTitleFromSheet({ titleJa: analysis.title_ja, titleKo: analysis.title_ko, langPair }).catch(() => null);
      const displayName = matchedForSummary?.koreanProjectName || analysis.title_ja || analysis.title_ko || "";
      const relayImageUrls = (files || [])
        .filter(f => f.mimetype?.startsWith("image/"))
        .map(f => f.url_private || f.permalink || null)
        .filter(Boolean);
      const pendingId = `route_pending_${Date.now()}`;
      draftStore.set(pendingId, {
        type:            "route_pending",
        ownerUserId:     userId,
        analysis,
        sourceLink,
        channelId,
        ts,
        dmChannel,
        relayText:       hasThreadContext ? threadContextText : originalText,
        relayImageUrls,
        requesterUserId: requesterUserId || null,
        apmUserId: userId || null,
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
      await handleWorkerRelay(client, dmChannel, analysis, { url: sourceLink, channelId, ts }, relayText, requesterUserId || null, relayImageUrls, userId || null, langPair);
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
        // sourceMeta 관통(fileOrder와 동일): 리테이크 감시행이 납품 스레드(watchChannel/watchThreadTs)를 알아야 함
        await handleRetakeInquiry(client, dmChannel, analysis, { url: sourceLink, ...sourceMeta }, originalText, retakeName, requesterUserId || null, userId, langPair);
      }
      // UD-7: message 경로는 분기 부재 → ⑧ 기본처리로 자동 폴백 (여기서 return 안 함)
      if (source === "reaction") return;
    }

    // ── ⑥ 원본 파일 순서 ─────────────────────────────────────────
    if (analysis.inquiry_type === "원본 파일 순서") {
      if (source === "reaction") {
        await client.chat.update({ channel: dmChannel, ts: progressMsg.ts, text: "📁 파일 순서 문의 처리 중..." });
        await handleFileOrderInquiry(client, dmChannel, analysis, { url: sourceLink, channelId, ts, requesterUserId: requesterUserId || null, ownerUserId: userId }, originalText, langPair);
      } else {
        await client.chat.update({ channel: dmChannel, ts: progressMsg.ts, text: "📁 파일 순서 문의 처리 중..." });
        // 결함 A 복원: base message ⑥은 { ...linkInfo, requesterUserId } (app-base:846) — linkInfo는 url/channelId/ts 3키
        // sourceLink = linkInfo.url (ctx 빌드 시 message 어댑터가 linkInfo.url을 sourceLink로 전달)
        // sourceMeta = { channelId: linkInfo.channelId, ts: linkInfo.ts }
        // → url을 명시 포함해야 fileOrderFlow.js(:301,332,360)의 linkInfo?.url이 sourceLink를 채울 수 있음
        await handleFileOrderInquiry(client, dmChannel, analysis, { url: sourceLink, ...sourceMeta, requesterUserId: requesterUserId || null, ownerUserId: userId }, originalText, langPair);
      }
      return;
    }

    // ── ⑦ 원본 파일 확인 ─────────────────────────────────────────
    if (analysis.inquiry_type === "원본 파일 확인") {
      let fileParsed;
      try { fileParsed = await parseFileInquiry(originalText); } catch (e) { fileParsed = {}; }
      const matchedTitle = await matchWorkTitleFromSheet({ titleJa: fileParsed.work_title_ja || analysis.title_ja, titleKo: fileParsed.work_title_ko || analysis.title_ko, langPair }).catch(() => null);

      // UD-8: reaction만 수동 입력 모달, message는 "-" draft 진행
      if (source === "reaction" && !matchedTitle) {
        const pendingId = `fi_pending_${Date.now()}`;
        draftStore.set(pendingId, {
          type:        "file_inquiry_pending",
          ownerUserId: userId,
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
      const fiDeliveryQueryName = matchedTitle?.koreanProjectName || fileParsed.work_title_ko || fileParsed.work_title_ja || null;
      const fiDeliveryRes = (fetchDeliveryDate && fiDeliveryQueryName && fileParsed.episode)
        ? await fetchDeliveryDate(fiDeliveryQueryName, fileParsed.episode, matchedTitle?.lang || "zh-ja", matchedTitle?.koreanProjectName || null).catch(() => null)
        : null;
      const fiDeliveryDate = fiDeliveryRes
        ? (fiDeliveryRes.allSame ? fiDeliveryRes.deliveryDate : fiDeliveryRes.episodes?.map(e => `${e.episode}화:${e.deliveryDate}`).join(", "))
        : "-";

      // message: matchedTitle?.optional chaining으로 "-" 채워 draft 진행 (UD-8 보존)
      const draftId = generateDraftId();
      const draft = {
        draftId,
        ownerUserId:      userId,
        dmChannelId:       dmChannel,
        originalChannelId: channelId,
        originalTs:        ts,
        workName:    matchedTitle?.koreanProjectName || fileParsed.work_title_ko || analysis.title_ko || matchedTitle?.japaneseDisplayTitle || fileParsed.work_title_ja || analysis.title_ja || "-",
        japaneseFixedTitle: matchedTitle?.japaneseFixedTitle || "-",
        pivoId:      matchedTitle?.pivoId  || null,
        lang:        matchedTitle?.lang    || null,
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
      const candResult = await matchWorkTitleWithCandidates(analysis.title_ja, analysis.title_ko, null, langPair).catch(() => null);
      if (candResult?.single) {
        matchedTitle = candResult.single;
      } else if (candResult?.multiple || candResult?.tooMany || candResult?.wrongLang) {
        const pendingId = `pending_${Date.now()}`;
        draftStore.set(pendingId, {
          isPending:      true,
          ownerUserId:    userId,
          userId,
          dmChannelId:    dmChannel,
          progressTs:     progressMsg.ts,
          sourceLink,
          originalText,
          // 원문 스레드 좌표 — 후보 선택/직접 입력을 거쳐 만들어진 draft도
          // 완료 후 「답변 작성」이 원문에 답글을 달 수 있어야 한다.
          originalChannelId: channelId,
          originalTs:        ts,
          titleJa:        analysis.title_ja,
          inquiryType:    analysis.inquiry_type,
          inquiryContent: analysis.translated_ko,
          summary:        analysis.summary_ko,
          actionRequired: analysis.action_required,
          priority:       analysis.priority,
          sourceLang:     analysis.source_lang,
        });
        if (candResult?.wrongLang) {
          // 이모지로 언어를 잘라서 못 찾았는데 반대 언어에는 있다. 그냥 "없음"으로 끝내면
          // APM 이 왜 안 나오는지 모른다 - 어느 이모지로 다시 찍어야 하는지 짚어 준다.
          const otherLang = candResult.wrongLang[0]?.lang === "ko-ja" ? "ko-ja" : "zh-ja";
          const other = otherLang === "ko-ja" ? "한일" : "중일";
          // 이모지 이름은 env 로 바뀌므로 실제 맵에서 되찾는다(하드코딩하면 틀린 안내가 나간다).
          const emoji = emojiForLangPair(triggerEmojis, otherLang);
          const retry = emoji ? `:${emoji}: 로 다시 찍거나, ` : "";
          await client.chat.update({ channel: dmChannel, ts: progressMsg.ts,
            text: `*${analysis.title_ko || analysis.title_ja || "-"}* 은 ${other} 작품이야. ${retry}아래에서 골라줘.` });
          await client.chat.postMessage({ channel: dmChannel, text: `${other} 작품이야. 맞으면 골라줘.`,
            blocks: buildCandidateBlocks({
              candidates: candResult.wrongLang, pendingId,
              actionIdPrefix: "inquiry_cand_pick_", manualActionId: "open_manual_title_modal", manualLabel: "✏️ 직접 입력 (작품명·PIVO ID)",
            }),
          });
        } else if (candResult?.multiple) {
          await client.chat.update({ channel: dmChannel, ts: progressMsg.ts,
            text: `작품명 *${analysis.title_ko || analysis.title_ja || "-"}* 후보가 여러 개야. 선택해줘.` });
          await client.chat.postMessage({ channel: dmChannel, text: "작품을 선택해줘.",
            blocks: buildCandidateBlocks({
              candidates: candResult.multiple, pendingId,
              actionIdPrefix: "inquiry_cand_pick_", manualActionId: "open_manual_title_modal", manualLabel: "✏️ 직접 입력 (작품명·PIVO ID)",
            }),
          });
        } else {
          await client.chat.update({ channel: dmChannel, ts: progressMsg.ts,
            text: `*${analysis.title_ko || analysis.title_ja || "-"}* 와 일치하는 작품이 너무 많아. 더 정확한 작품명을 입력해줘.` });
          await client.chat.postMessage({ channel: dmChannel, text: "작품명을 직접 입력해줘.",
            blocks: buildManualEntryBlocks({
              pendingId, manualActionId: "open_manual_title_modal", manualLabel: "✏️ 직접 입력 (작품명·PIVO ID)",
              titleHint: analysis.title_ja || analysis.title_ko,
            }),
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
        ownerUserId:    userId,
        userId,
        dmChannelId:    dmChannel,
        progressTs:     progressMsg.ts,
        sourceLink,
        originalText,
        originalChannelId: channelId,
        originalTs:        ts,
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
        blocks: buildManualEntryBlocks({
          pendingId, manualActionId: "open_manual_title_modal", manualLabel: "✏️ 직접 입력 (작품명·PIVO ID)",
          titleHint: analysis.title_ja || analysis.title_ko,
        }),
      });
      return;
    }

    const draftId = generateDraftId();
    const draft = {
      draftId,
      ownerUserId:    userId,
      userId,
      dmChannelId:      dmChannel,
      progressMessageTs: progressMsg.ts,
      sourceLink,
      originalText,
      originalChannelId: channelId,
      originalTs:        ts,
      workName:      matchedTitle.koreanProjectName || analysis.title_ko || matchedTitle.japaneseDisplayTitle || analysis.title_ja || "",
      workNameKo:    matchedTitle.koreanProjectName || analysis.title_ko || "",
      pivoId:        matchedTitle.pivoId || null,
      lang:          matchedTitle.lang   || null,
      episode:       analysis.episode || null,
      deliveryDate:  analysis.episode && matchedTitle.koreanProjectName
        ? await fetchDeliveryDate(matchedTitle.koreanProjectName, analysis.episode, matchedTitle.lang || "zh-ja", matchedTitle.koreanProjectName)
            .catch(() => null)
            .then(d => d ? (d.allSame ? d.deliveryDate : d.episodes?.map(e => `${e.episode}화:${e.deliveryDate}`).join(", ")) : "-")
        : "-",
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
