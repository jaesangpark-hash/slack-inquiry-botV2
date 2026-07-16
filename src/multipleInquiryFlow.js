// ══════════════════════════════════════════════════════════════════
// multipleInquiryFlow.js — 복수 문의 자동 분기 처리
// ══════════════════════════════════════════════════════════════════

const {
  readKoreanProjectNameFromSelectionPayload,
} = require("./slack/title-selection-payload");

module.exports = function registerMultipleInquiryFlow(app, {
  ai, GEMINI_MODEL,
  matchWorkTitleFromSheet, matchWorkTitleByTokens,
  generateDraftId, draftStore, fetchDeliveryDate,
  handleFileOrderInquiry, handleRetakeInquiry, handleScheduleExt, handleScheduleExtGrouped,
}) {

  const BASE  = () => process.env.PLATFORM_API_URL;
  const TOKEN = () => process.env.PLATFORM_API_TOKEN;
  const { loggedCall } = require("./apiLogger");

  // 리테이크 항목 전용 pivoId 직접 입력 해석 — retakeFlow.js의 동일 로직 이식
  // (Totus API 선 조회 → 실패/미확인 시 마스터 시트 폴백)
  async function _resolvePivoIdForRetake(pivoId) {
    let displayWorkName;
    let koreanProjectName = null;
    try {
      const meta = { bot: "multi-retake", endpoint: "/projects", params: { pivoId }, expectedCount: 1 };
      const _pivoRes = await loggedCall(async () => {
        const res = await fetch(`${BASE()}/api/v1/projects?pivoId=${encodeURIComponent(pivoId)}`, {
          headers: { Authorization: `Bearer ${TOKEN()}` },
        });
        const ct = res.headers.get("content-type") || "";
        if (!ct.includes("application/json")) {
          const head = (await res.text()).slice(0, 200);
          throw new Error(`TOTUS API 비-JSON 응답 (HTTP ${res.status}) — ${head}`);
        }
        const json = await res.json();
        if (Array.isArray(json.data)) meta.returnedCount = json.data.length;
        else if (json.data != null)   meta.returnedCount = 1;
        return json;
      }, meta);
      const list = _pivoRes?.data || [];
      const proj = list.find(p => {
        const d = p._detail || p;
        return d.진행상태 !== "CANCELED" && d.pivoId != null;
      });
      const primaryWorkTitle = proj?.name
                            || proj?._detail?.pivoOriginalTitle || proj?.detail?.pivoOriginalTitle
                            || proj?._detail?.pivoTitle        || proj?.detail?.pivoTitle
                            || null;
      const matchedByPivo = await matchWorkTitleFromSheet({ pivoId }).catch(() => null);
      koreanProjectName = matchedByPivo?.koreanProjectName || null;
      displayWorkName = koreanProjectName
                     || matchedByPivo?.chineseOriginalTitle
                     || primaryWorkTitle
                     || `(pivoId: ${pivoId})`;
    } catch (e) {
      console.error(`[multi] pivoId 조회 실패 → 마스터 시트 폴백:`, e.message);
      const matchedByPivo = await matchWorkTitleFromSheet({ pivoId }).catch(() => null);
      koreanProjectName = matchedByPivo?.koreanProjectName || null;
      displayWorkName = koreanProjectName
                     || matchedByPivo?.chineseOriginalTitle
                     || `(pivoId: ${pivoId})`;
    }
    return { koreanProjectName, displayWorkName, pivoId };
  }

  // ── 타입별 필수 필드 정의 ─────────────────────────────────
  const REQUIRED_FIELDS = {
    "스케줄":   ["work_title", "episode", "extend_or_date"],  // extend_days 또는 requested_date 중 하나
    "재수급":   ["work_title", "episode", "reason"],
    "파일순서": ["work_title", "episode"],
    "리테이크": ["work_title", "episode"],
    "문의":     ["work_title", "episode", "content"],
  };

  // ── 복수 문의 AI 파싱 ─────────────────────────────────────
  async function parseMultipleInquiry(text, msgDate = null) {
    const dateContext = msgDate ? `문의 작성일(KST): ${msgDate}\n\n` : "";
    const prompt = `${dateContext}너는 웹툰/만화 로컬라이징 전문 문의 분석 AI다.

아래 문의에서 개별 문의 항목을 분리하여 배열로 추출해줘.
각 항목은 독립된 작품·화수·유형을 가진다.

각 항목에서 추출할 정보:
1) type: 아래 중 하나
   - "스케줄"   : 납품일·일정 연장/변경 요청
   - "재수급"   : 원본 파일 재전송/재수급 요청
   - "파일순서" : 파일 순서 오류 수정 요청
   - "리테이크" : 제출 후 재작업·리테이크 요청
   - "문의"     : 그 외 작업 관련 일반 문의
   - "불명"     : 유형 판단 불가
2) work_title_ja: 일본어·중국어 작품명 원문 그대로 (없으면 null)
3) work_title_ko: 한국어 작품명 원문 그대로 (없으면 null)
4) episode: 회차 숫자만 (없으면 null)
5) extend_days: 연장 일수 (스케줄 유형만). "추가 일수"가 명시된 경우에만 반드시 양의 정수(예: 3). 한국어·일본어·영어 공통("N일 연장", "extend N days", "N more days"). 목표일 표현(tomorrow 등)은 여기 넣지 말 것. 숫자가 아니면 null
6) requested_date: 희망 마감일 YYYY-MM-DD (스케줄 유형만). 작성일 기준 변환. "N월N일까지/28일까지/by May 10" 등 달력 날짜, "내일/明日/tomorrow"=작성일+1·"모레/明後日/the day after tomorrow"=작성일+2, "to/by/until tomorrow·내일까지·明日まで" 같은 목표 마감일 표현 모두 여기로. 작성일 모르면 추측 금지 → null
7) reason: 재수급 사유 한국어 1문장 (재수급 유형만, 없으면 null)
8) content: 문의 내용 요약 (문의 유형만, 없으면 null)
9) file_numbers: 파일/페이지 번호 배열 (재수급 유형만, 없으면 [])

JSON만 출력. 코드블록 금지.
{"items": [...]}

문의:
${text}`.trim();

    const res = await ai.models.generateContent({ model: GEMINI_MODEL, contents: prompt });
    const parsed = JSON.parse((res.text || "").replace(/```json|```/g, "").trim());
    return parsed.items || [];
  }

  // ── 항목별 누락 필드 확인 ─────────────────────────────────
  function getMissingFields(item) {
    const required = REQUIRED_FIELDS[item.type] || [];
    const missing = [];
    for (const field of required) {
      if (field === "work_title" && !item.work_title_ja && !item.work_title_ko) missing.push("work_title");
      if (field === "episode" && !item.episode) missing.push("episode");
      if (field === "extend_or_date") {
        // extend_days 는 양의 정수일 때만 유효 (문자열 "tomorrow" 등은 무효 처리 → 누락)
        const days     = Number(item.extend_days);
        const hasDays  = item.extend_days != null && Number.isFinite(days) && days > 0;
        const hasDate  = !!item.requested_date;
        if (!hasDays && !hasDate) missing.push("extend_or_date");
      }
      if (field === "reason" && !item.reason) missing.push("reason");
      if (field === "content" && !item.content) missing.push("content");
    }
    return missing;
  }

  // ── 항목별 작품명 매칭 ────────────────────────────────────
  async function resolveTitle(item) {
    let matched = await matchWorkTitleFromSheet(item.work_title_ja, item.work_title_ko).catch(() => null);
    if (!matched) {
      const tokenResult = await matchWorkTitleByTokens(item.work_title_ko, item.work_title_ja).catch(() => null);
      if (tokenResult?.single) matched = tokenResult.single;
      else if (tokenResult?.multiple) return { matched: null, candidates: tokenResult.multiple };
    }
    return { matched, candidates: null };
  }

  // ── 누락 필드 라벨 ────────────────────────────────────────
  function fieldLabel(field) {
    const map = {
      work_title: "작품명",
      episode: "화수",
      extend_or_date: "연장 일수 또는 희망 마감일",
      reason: "재수급 사유",
      content: "문의 내용",
    };
    return map[field] || field;
  }

  // ── 타입 라벨 ─────────────────────────────────────────────
  function typeLabel(type) {
    const map = {
      "스케줄": "📅 스케줄 연장",
      "재수급": "📦 재수급",
      "파일순서": "📁 파일 순서",
      "리테이크": "🔄 태스크 재생성",
      "문의": "💬 작업 문의",
      "불명": "❓ 유형 불명",
    };
    return map[type] || type;
  }

  // ── 항목 처리: 각 봇 플로우 연결 ─────────────────────────
  async function processItem(client, dmChannel, item, matchedTitle, originalChannelId, originalTs, sourceLink, requesterName, requesterUserId, ownerUserId) {
    const koreanProjectName = matchedTitle?.koreanProjectName || item.work_title_ko || null;
    const displayWorkName = koreanProjectName
                         || matchedTitle?.displayWorkName
                         || item.work_title_ja
                         || "";
    const primaryWorkTitle = koreanProjectName || displayWorkName;
    const originalWorkTitle = item.work_title_ja
                           || (!koreanProjectName ? displayWorkName : null);
    const episode = item.episode || null;

    switch (item.type) {
      case "스케줄": {
        const delivery = primaryWorkTitle && episode
          ? await fetchDeliveryDate(primaryWorkTitle, episode, "zh-ja", koreanProjectName).catch(() => null)
          : null;
        const parsed = {
          work_title_ko: koreanProjectName,
          work_title_ja: originalWorkTitle,
          episode,
          extend_days: item.extend_days || null,
          requested_date: item.requested_date || null,
          worker_type: "불명",
          originalChannelId,
          originalTs,
          requesterUserId: null,
          ownerUserId,
        };
        await handleScheduleExt(client, dmChannel, parsed, matchedTitle, delivery, sourceLink);
        break;
      }

      case "재수급": {
        const delivery = primaryWorkTitle && episode
          ? await fetchDeliveryDate(primaryWorkTitle, episode, "zh-ja", koreanProjectName).catch(() => null)
          : null;
        const draftId = generateDraftId();
        draftStore.set(draftId, {
          type: "file_inquiry",
          draftId,
          ownerUserId,
          workName: displayWorkName,
          workNameKo: koreanProjectName,
          episode: episode || "",
          fileNumbers: item.file_numbers || [],
          reason: item.reason || "",
          deliveryDate: delivery?.allSame ? delivery.deliveryDate : "-",
          sourceLink,
          originalChannelId,
          originalTs,
          dmChannelId: dmChannel,
        });
        const fileNums = (item.file_numbers || []).join(", ") || "-";
        await client.chat.postMessage({
          channel: dmChannel,
          text: `📦 *재수급 요청 초안* — ${displayWorkName} ${episode || "-"}화`,
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: `*📦 재수급 요청 초안*\n*작품명:* ${displayWorkName}\n*회차:* ${episode ? episode+"화" : "-"}\n*납품일:* ${delivery?.allSame ? delivery.deliveryDate : "-"}\n*파일/페이지 번호:* ${fileNums}\n*재수급 사유:* ${item.reason || "-"}` }},
            { type: "actions", elements: [
              { type: "button", action_id: "open_file_inquiry_modal", text: { type: "plain_text", text: "수정" }, style: "primary", value: draftId },
              { type: "button", action_id: "send_file_inquiry_now",   text: { type: "plain_text", text: "전송" }, style: "danger",   value: draftId,
                confirm: { title: { type: "plain_text", text: "전송할까?" }, text: { type: "mrkdwn", text: "PM 채널에 재수급 요청을 전송해." }, confirm: { type: "plain_text", text: "전송" }, deny: { type: "plain_text", text: "취소" } }},
            ]},
          ],
        });
        break;
      }

      case "파일순서": {
        await handleFileOrderInquiry(
          client, dmChannel,
          { title_ja: originalWorkTitle, title_ko: koreanProjectName, episode },
          { url: sourceLink, channelId: originalChannelId, ts: originalTs, requesterUserId: requesterUserId || null, ownerUserId },
          item.work_title_ko || item.work_title_ja || "",
        );
        break;
      }

      case "리테이크": {
        await handleRetakeInquiry(
          client, dmChannel,
          { title_ja: originalWorkTitle, title_ko: koreanProjectName, episode },
          { url: sourceLink },
          item.work_title_ko || item.work_title_ja || "",
          requesterName || "",
          requesterUserId || null,
          ownerUserId,
        );
        break;
      }

      case "문의": {
        // 일반 문의는 초안 생성 없이 내용만 표시 + 문의봇 버튼
        const btnValue = JSON.stringify({ sourceLink, workName: displayWorkName, episode: episode || "" });
        await client.chat.postMessage({
          channel: dmChannel,
          text: `💬 *작업 문의* — ${displayWorkName} ${episode || "-"}화`,
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: `*💬 작업 문의*\n*작품명:* ${displayWorkName}\n*회차:* ${episode ? episode+"화" : "-"}\n*내용:* ${item.content || "-"}` }},
            { type: "actions", elements: [
              { type: "button", action_id: "direct_inquiry_btn", text: { type: "plain_text", text: "문의봇으로 처리" }, style: "primary", value: btnValue },
            ]},
          ],
        });
        break;
      }

      default: {
        const btnValue = JSON.stringify({ sourceLink, workName: displayWorkName, episode: episode || "" });
        await client.chat.postMessage({
          channel: dmChannel,
          text: `❓ 유형을 특정할 수 없어. 직접 봇을 선택해줘. — ${displayWorkName} ${episode || "-"}화`,
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: `❓ *유형 불명*\n*작품명:* ${displayWorkName}\n*회차:* ${episode ? episode+"화" : "-"}\n직접 봇을 선택해줘.` }},
            { type: "actions", elements: [
              { type: "button", action_id: "direct_inquiry_btn",   text: { type: "plain_text", text: "문의봇" },    value: btnValue },
              { type: "button", action_id: "direct_resupply_btn",  text: { type: "plain_text", text: "재수급봇" },  value: btnValue },
              { type: "button", action_id: "direct_schedule_btn",  text: { type: "plain_text", text: "스케줄봇" },  value: btnValue },
              { type: "button", action_id: "direct_fileorder_btn", text: { type: "plain_text", text: "파일순서봇" }, value: btnValue },
              { type: "button", action_id: "direct_retake_btn",    text: { type: "plain_text", text: "태스크생성봇" }, value: btnValue },
            ]},
          ],
        });
      }
    }
  }

  // ── 복수 문의 누락 정보 입력 모달 열기 ───────────────────
  app.action("multi_fill_missing", async ({ ack, body, client }) => {
    await ack();
    const { multiPendingId, itemIndex } = JSON.parse(body.actions[0].value || "{}");
    const multiPending = draftStore.get(multiPendingId);
    if (!multiPending) return;

    const item    = multiPending.items[itemIndex];
    // 저장된 누락 필드 사용 (매칭 실패 포함)
    const missing = multiPending.missingByIndex?.[itemIndex] || getMissingFields(item);

    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: `*${typeLabel(item.type)}* — 누락된 정보를 입력해줘.` }},
    ];

    const isRetakePivoEligible = item.type === "리테이크" && missing.includes("work_title");
    if (missing.includes("work_title")) {
      blocks.push({ type: "input", block_id: "mi_work_block",
        label: { type: "plain_text", text: "작품명" },
        optional: isRetakePivoEligible,
        element: { type: "plain_text_input", action_id: "value",
          initial_value: item.work_title_ko || item.work_title_ja || "",
          placeholder: { type: "plain_text", text: "한국어 또는 일본어 작품명" } } });
      if (isRetakePivoEligible) {
        blocks.push({ type: "input", block_id: "mi_pivoid_block",
          label: { type: "plain_text", text: "pivoId (작품명 대신 입력 가능)" },
          optional: true,
          element: { type: "plain_text_input", action_id: "value",
            placeholder: { type: "plain_text", text: "예: 38873" } } });
      }
    }
    if (missing.includes("episode")) {
      blocks.push({ type: "input", block_id: "mi_episode_block",
        label: { type: "plain_text", text: "화수 (숫자만)" },
        element: { type: "plain_text_input", action_id: "value",
          initial_value: item.episode || "",
          placeholder: { type: "plain_text", text: "예: 221" } } });
    }
    if (missing.includes("extend_or_date")) {
      blocks.push({ type: "input", block_id: "mi_extdays_block",
        label: { type: "plain_text", text: "연장 일수 (숫자만)" },
        optional: true,
        element: { type: "plain_text_input", action_id: "value",
          placeholder: { type: "plain_text", text: "예: 3" } } });
      blocks.push({ type: "input", block_id: "mi_reqdate_block",
        label: { type: "plain_text", text: "희망 마감일 (연장 일수 미입력 시)" },
        optional: true,
        element: { type: "datepicker", action_id: "value",
          placeholder: { type: "plain_text", text: "날짜 선택" } } });
    }
    if (missing.includes("reason")) {
      blocks.push({ type: "input", block_id: "mi_reason_block",
        label: { type: "plain_text", text: "재수급 사유" },
        element: { type: "plain_text_input", action_id: "value",
          initial_value: item.reason || "",
          placeholder: { type: "plain_text", text: "파일 손상, 레이어 미분리 등" } } });
    }
    if (missing.includes("content")) {
      blocks.push({ type: "input", block_id: "mi_content_block",
        label: { type: "plain_text", text: "문의 내용" },
        element: { type: "plain_text_input", action_id: "value", multiline: true,
          initial_value: item.content || "",
          placeholder: { type: "plain_text", text: "문의 내용을 입력해줘." } } });
    }

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal", callback_id: "submit_multi_fill_missing",
        private_metadata: JSON.stringify({ multiPendingId, itemIndex }),
        title:  { type: "plain_text", text: "누락 정보 입력" },
        submit: { type: "plain_text", text: "처리" },
        close:  { type: "plain_text", text: "취소" },
        blocks,
      },
    });
  });

  // ── 누락 정보 입력 모달 제출 ─────────────────────────────
  app.view("submit_multi_fill_missing", async ({ ack, body, view, client }) => {
    await ack();
    const { multiPendingId, itemIndex } = JSON.parse(view.private_metadata || "{}");
    const multiPending = draftStore.get(multiPendingId);
    if (!multiPending) return;

    const v         = view.state.values;
    const item      = multiPending.items[itemIndex];
    const pivoInput = v.mi_pivoid_block?.value?.value?.trim() || "";

    // 입력값으로 항목 업데이트
    if (v.mi_work_block?.value?.value)    item.work_title_ko = v.mi_work_block.value.value.trim();
    if (v.mi_episode_block?.value?.value) item.episode       = v.mi_episode_block.value.value.trim();
    if (v.mi_extdays_block?.value?.value) item.extend_days   = parseInt(v.mi_extdays_block.value.value.trim(), 10) || null;
    if (v.mi_reqdate_block?.value?.selected_date) item.requested_date = v.mi_reqdate_block.value.selected_date;
    if (v.mi_reason_block?.value?.value)  item.reason  = v.mi_reason_block.value.value.trim();
    if (v.mi_content_block?.value?.value) item.content = v.mi_content_block.value.value.trim();

    if (v.mi_pivoid_block && !pivoInput && !item.work_title_ko && !item.work_title_ja) {
      await client.chat.postMessage({ channel: body.user.id, text: `[항목 ${itemIndex + 1}] 작품명 또는 pivoId 중 하나는 입력해줘.` });
      return;
    }

    multiPending.items[itemIndex] = item;
    draftStore.set(multiPendingId, multiPending);

    // pivoId 직접 입력(리테이크 전용) → 시트/토큰 매칭 우회하고 Totus API 선 조회
    const { matched, candidates } = pivoInput && item.type === "리테이크"
      ? { matched: await _resolvePivoIdForRetake(pivoInput), candidates: null }
      : await resolveTitle(item);

    if (candidates) {
      // 복수 후보 → 선택 버튼
      await client.chat.postMessage({
        channel: body.user.id,
        text: `[항목 ${itemIndex + 1}] 작품 후보가 여러 개야. 선택해줘.`,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `*[항목 ${itemIndex + 1}] ${typeLabel(item.type)}* — 작품 후보 ${candidates.length}건` }},
          { type: "actions", elements: candidates.slice(0, 5).map((r, i) => ({
            type: "button", action_id: `multi_token_pick_${i}`,
            text: { type: "plain_text", text: r.koreanProjectName || r.japaneseDisplayTitle || `후보 ${i+1}` },
            value: JSON.stringify({ multiPendingId, itemIndex, pivoId: r.pivoId, koreanProjectName: r.koreanProjectName }),
          }))},
        ],
      });
      return;
    }

    await processItem(
      client, body.user.id, item, matched,
      multiPending.originalChannelId, multiPending.originalTs,
      multiPending.sourceLink, multiPending.requesterName, multiPending.requesterUserId,
      multiPending.ownerUserId,
    );
  });

  app.action(/^multi_token_pick_\d+$/, async ({ ack, body, client }) => {
    await ack();
    const selection = JSON.parse(body.actions[0].value || "{}");
    const { multiPendingId, itemIndex, pivoId } = selection;
    const koreanProjectName = readKoreanProjectNameFromSelectionPayload(selection);
    const multiPending = draftStore.get(multiPendingId);
    if (!multiPending) return;

    const matchedTitle = { koreanProjectName, pivoId };
    const item         = multiPending.items[itemIndex];

    await processItem(
      client, body.user.id, item, matchedTitle,
      multiPending.originalChannelId, multiPending.originalTs,
      multiPending.sourceLink, multiPending.requesterName, multiPending.requesterUserId,
      multiPending.ownerUserId,
    );
  });

  // ── 메인 핸들러 ──────────────────────────────────────────
  async function handleMultipleInquiry(client, dmChannel, originalText, sourceLink, originalChannelId, originalTs, requesterName, preItems = null, forceType = null, requesterUserId = null, ownerUserId = null) {
    // 1. AI로 항목 분리 파싱 (외부에서 이미 파싱된 경우 재사용)
    let items;
    if (preItems && preItems.length) {
      items = preItems;
    } else {
      try {
        const msgDate = originalTs
          ? new Date(parseInt(originalTs.split(".")[0]) * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 10)
          : null;
        items = await parseMultipleInquiry(originalText, msgDate);
      } catch (e) {
        console.error("[multi] AI 파싱 실패:", e.message);
        await client.chat.postMessage({ channel: dmChannel, text: "⚠️ 복수 문의 파싱에 실패했어. 직접 봇을 소환해줘." });
        return;
      }
    }

    // forceType 지정 시 모든 항목 타입 강제 덮어씌움
    if (forceType) {
      items = items.map(item => ({ ...item, type: forceType }));
    }

    if (!items.length) {
      await client.chat.postMessage({ channel: dmChannel, text: "⚠️ 문의 항목을 분리할 수 없어. 직접 봇을 소환해줘." });
      return;
    }

    // 2. 전체 항목 요약 표시
    const summaryLines = items.map((item, i) =>
      `${i + 1}. ${typeLabel(item.type)} — ${item.work_title_ko || item.work_title_ja || "작품명 미확인"} ${item.episode ? item.episode+"화" : ""}`
    );
    await client.chat.postMessage({
      channel: dmChannel,
      text: `📋 복수 문의 ${items.length}건 감지됨`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*📋 복수 문의 ${items.length}건 감지 — 항목별로 처리할게.*\n${summaryLines.join("\n")}${sourceLink ? `\n\n🔗 <${sourceLink}|원문 링크>` : ""}` }},
      ],
    });

    // 3. 항목별 매칭 + 누락 필드 사전 계산 (병렬)
    const multiPendingId = `multi_${Date.now()}`;
    const resolvedItems = await Promise.all(items.map(async (item, i) => {
      let missing = getMissingFields(item);
      const { matched, candidates } = await resolveTitle(item);
      if (!matched && !candidates && !missing.includes("work_title")) {
        missing = ["work_title", ...missing];
      }
      return { item, missing, matched, candidates };
    }));

    draftStore.set(multiPendingId, {
      ownerUserId,
      items,
      originalChannelId, originalTs, sourceLink, requesterName, requesterUserId,
      missingByIndex: Object.fromEntries(resolvedItems.map(({ missing }, i) => [i, missing])),
    });

    // 4-A. 스케줄 항목 묶음 후보 식별 — 동일 작품(pivoId) + 동일 연장요청(extend_days/requested_date)
    //   - 매칭 성공 + 누락 없는 항목만 대상 (그 외엔 단일 흐름으로 fallback)
    //   - 2건 이상 모이면 handleScheduleExtGrouped 로 위임 → 그 안에서 시그니처(시작/마감/작업자 이메일) 일치 여부 재검증
    const batchHandled  = new Set();
    const scheduleBatches = [];
    if (handleScheduleExtGrouped) {
      const scheduleByKey = new Map();
      resolvedItems.forEach(({ item, missing, matched }, i) => {
        if (item.type !== "스케줄") return;
        if (!matched?.pivoId) return;
        if (missing.length > 0) return;
        if (!item.episode) return;
        const key = `${matched.pivoId}|${item.extend_days || ""}|${item.requested_date || ""}`;
        if (!scheduleByKey.has(key)) scheduleByKey.set(key, []);
        scheduleByKey.get(key).push(i);
      });
      for (const indices of scheduleByKey.values()) {
        if (indices.length >= 2) {
          scheduleBatches.push(indices);
          indices.forEach(i => batchHandled.add(i));
        }
      }
    }

    // 4-B. 묶음 처리 (병렬)
    const batchPromises = scheduleBatches.map(async (indices) => {
      try {
        const firstRi  = resolvedItems[indices[0]];
        const workName = firstRi.matched?.koreanProjectName || firstRi.item.work_title_ko || firstRi.item.work_title_ja || "-";
        const epsLabel = indices.map(i => resolvedItems[i].item.episode + "화").join(", ");
        await client.chat.postMessage({
          channel: dmChannel,
          text: `[묶음 후보] ${workName} ${epsLabel}`,
          blocks: [
            { type: "section", text: { type: "mrkdwn",
              text: `*📚 ${workName} ${epsLabel}* — 동일 일정이면 한 카드로, 다르면 개별로 띄울게.` } },
          ],
        });
        const groupItems = indices.map(i => {
          const ri = resolvedItems[i];
          return {
            episode: ri.item.episode,
            parsed: {
              work_title_ko: ri.matched?.koreanProjectName || ri.item.work_title_ko || null,
              work_title_ja: ri.item.work_title_ja || null,
              episode: ri.item.episode,
              extend_days: ri.item.extend_days || null,
              requested_date: ri.item.requested_date || null,
              worker_type: "불명",
              originalChannelId,
              originalTs,
              requesterUserId,
              ownerUserId,
            },
            matchedTitle: ri.matched,
            delivery: null, // grouped flow가 재조회
            sourceLink,
            originalChannelId,
            originalTs,
            requesterUserId,
            ownerUserId,
          };
        });
        await handleScheduleExtGrouped(client, dmChannel, groupItems);
      } catch (e) {
        console.error("[multi] 스케줄 묶음 처리 실패:", e.message);
        // 실패 시 각 항목 단일 흐름으로 fallback
        indices.forEach(i => batchHandled.delete(i));
        await Promise.all(indices.map(async (i) => {
          const ri = resolvedItems[i];
          try {
            await processItem(client, dmChannel, ri.item, ri.matched, originalChannelId, originalTs, sourceLink, requesterName, requesterUserId, ownerUserId);
          } catch (err) {
            console.error(`[multi] fallback 항목 ${i+1} 실패:`, err.message);
          }
        }));
      }
    });

    // 4-C. 묶음에 포함되지 않은 항목은 기존 흐름대로 병렬 처리
    const otherPromises = resolvedItems.map(async ({ item, missing, matched, candidates }, i) => {
      if (batchHandled.has(i)) return;
      try {

        const workName = matched?.koreanProjectName || item.work_title_ko || item.work_title_ja || "미확인";
        const header   = `*[항목 ${i + 1}] ${typeLabel(item.type)}* — ${workName} ${item.episode ? item.episode+"화" : ""}`;

        // 케이스 1: 타입 불명
        if (item.type === "불명") {
          const btnValue = JSON.stringify({ sourceLink, workName, episode: item.episode || "" });
          await client.chat.postMessage({
            channel: dmChannel,
            text: `[항목 ${i + 1}] 유형을 특정할 수 없어. 직접 선택해줘.`,
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: `${header}\n유형을 특정할 수 없어. 직접 봇을 선택해줘.` }},
              { type: "actions", elements: [
                { type: "button", action_id: "direct_inquiry_btn",   text: { type: "plain_text", text: "문의봇" },    value: btnValue },
                { type: "button", action_id: "direct_resupply_btn",  text: { type: "plain_text", text: "재수급봇" },  value: btnValue },
                { type: "button", action_id: "direct_schedule_btn",  text: { type: "plain_text", text: "스케줄봇" },  value: btnValue },
                { type: "button", action_id: "direct_fileorder_btn", text: { type: "plain_text", text: "파일순서봇" }, value: btnValue },
                { type: "button", action_id: "direct_retake_btn",    text: { type: "plain_text", text: "태스크생성봇" }, value: btnValue },
              ]},
            ],
          });
          return;
        }

        // 케이스 2: 복수 후보
        if (candidates) {
          await client.chat.postMessage({
            channel: dmChannel,
            text: `[항목 ${i + 1}] 작품 후보가 여러 개야. 선택해줘.`,
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: `${header}\n작품 후보가 여러 개야. 선택해줘.` }},
              { type: "actions", elements: candidates.slice(0, 5).map((r, ci) => ({
                type: "button", action_id: `multi_token_pick_${ci}`,
                text: { type: "plain_text", text: r.koreanProjectName || r.japaneseDisplayTitle || `후보 ${ci+1}` },
                value: JSON.stringify({ multiPendingId, itemIndex: i, pivoId: r.pivoId, koreanProjectName: r.koreanProjectName }),
              }))},
            ],
          });
          return;
        }

        // 케이스 3: 누락 필드 있음 (매칭 실패 포함)
        if (missing.length > 0) {
          const missingLabels = missing.map(fieldLabel).join(", ");
          const matchFailNote = !matched && missing.includes("work_title")
            ? `\n시트에서 *${item.work_title_ko || item.work_title_ja || "작품명"}* 을 찾지 못했어. 정확한 작품명을 입력해줘.`
            : "";
          await client.chat.postMessage({
            channel: dmChannel,
            text: `[항목 ${i + 1}] 누락 정보가 있어. 직접 입력해줘.`,
            blocks: [
              { type: "section", text: { type: "mrkdwn",
                text: `${header}\n⚠️ 아래 정보를 확인할 수 없어.\n・ ${missingLabels}${matchFailNote}` }},
              { type: "actions", elements: [
                { type: "button", action_id: "multi_fill_missing",
                  text: { type: "plain_text", text: "✏️ 정보 입력" },
                  style: "primary",
                  value: JSON.stringify({ multiPendingId, itemIndex: i }) },
              ]},
            ],
          });
          return;
        }

        // 케이스 4: 정상 처리
        await client.chat.postMessage({
          channel: dmChannel,
          text: `[항목 ${i + 1}] ${typeLabel(item.type)} 처리 중...`,
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: `${header}\n처리 중...` }},
          ],
        });
        await processItem(client, dmChannel, item, matched, originalChannelId, originalTs, sourceLink, requesterName, requesterUserId, ownerUserId);

      } catch (e) {
        console.error(`[multi] 항목 ${i + 1} 처리 실패:`, e.message);
        await client.chat.postMessage({
          channel: dmChannel,
          text: `⚠️ [항목 ${i + 1}] 처리 중 오류가 발생했어: ${e.message}`,
        });
      }
    });

    await Promise.all([...batchPromises, ...otherPromises]);
  }

  return { handleMultipleInquiry };
};
