// ══════════════════════════════════════════════════════════════════
// workerRelayFlow.js — 작업자 TO 작업자 커뮤니케이션 릴레이
//
// 지원 유형
//   - 번역문 누락   : 번역문 미전달 → 상대 작업자에게 전달 요청
//   - 번역문 확인   : 내용 이슈 (오탈자·대사 불일치 등) → 확인 요청
//   - 번역문 수정   : 수정본 재전달 요청
//
// 공통 플로우
//   원문 스레드 이모지 소환
//   → Gemini 분석 (작품명·회차·문의 내용·유형)
//   → Totus에서 원문 작성자 오퍼레이션 판별 → 전달 대상 결정
//   → APM DM 초안 공유
//   → APM [전송] 클릭
//   → B 작업자 개인 채널에 메시지 + [답변하기] 버튼
//   → B 작업자 모달 입력 (수정 가능)
//   → A 작업자 원문 TS에 댓글로 전달
//
// app.js 에서
//   const { handleWorkerRelay } = require("./workerRelayFlow")(app, {
//     ai, GEMINI_MODEL,
//     matchWorkTitleFromSheet, generateDraftId, draftStore,
//   });
// 로 호출
// ══════════════════════════════════════════════════════════════════

module.exports = function registerWorkerRelayFlow(app, {
  ai, GEMINI_MODEL,
  matchWorkTitleFromSheet, generateDraftId, draftStore,
  sheetsClient,
}) {

  const BASE        = () => process.env.PLATFORM_API_URL;
  const TOKEN       = () => process.env.PLATFORM_API_TOKEN;
  const PM_SLACK_ID = () => process.env.PM_SLACK_ID;
  const { loggedCall, logEvent } = require("./apiLogger");
  const {
    checkEntryGate,
    readState,
    reserveInProgress,
    runCheckpointStages,
  } = require("./slack/mutation-checkpoint");

  // ── 오퍼레이션 코드 ──────────────────────────────────────
  const OP = {
    TRANSLATION:        "OTC0012", // 번역
    TYPESETTING:        "OTC0014", // 식자
    TYPESETTING_REVIEW: "OTC0015", // 식자검수
  };
  const RELAY_OP_CODES = new Set(Object.values(OP));

  // ── Gemini: 텍스트 → 일본어 번역 ────────────────────────
  async function _translateToJa(text) {
    try {
      const prompt = `以下のテキストを自然な日本語に翻訳してください。翻訳結果のみ出力してください。THINKINGや思考過程は一切含めないでください。コードブロック不要。\n\n${text}`;
      const res = await ai.models.generateContent({ model: GEMINI_MODEL, contents: prompt });
      const raw = (res.text || "")
        .replace(/```[\s\S]*?```/g, "")
        .replace(/THINKING:[\s\S]*?(?=\n\n|$)/gi, "")
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
        .trim();
      return raw || text;
    } catch (e) {
      console.error("[workerRelay] 일본어 번역 실패:", e.message);
      return text;
    }
  }

  // ── Gemini: 텍스트 → 지정 언어 번역 (en 등) ─────────────
  async function _translateTo(text, lang) {
    if (lang === "ja") return _translateToJa(text);
    try {
      const langLabel = lang === "en" ? "English" : lang;
      const prompt = `Translate the following text to ${langLabel}. Output only the translation, no explanation, no code blocks.\n\n${text}`;
      const res = await ai.models.generateContent({ model: GEMINI_MODEL, contents: prompt });
      const raw = (res.text || "")
        .replace(/```[\s\S]*?```/g, "")
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
        .trim();
      return raw || text;
    } catch (e) {
      console.error(`[workerRelay] ${lang} 번역 실패:`, e.message);
      return text;
    }
  }

  // ── 일본어 UI 텍스트 상수 ────────────────────────────────
  const JA_UI = {
    replyTitle:       "返信を入力",
    replyLabel:       "返信内容（修正可能）",
    replyPlaceholder: "内容を入力してください...",
    replySubmit:      "送信",
    replyClose:       "キャンセル",
    replyBtn:         "✏️ 返信する",
    answered:         "✅ 返信が送信されました。",
  };

  const EN_UI = {
    replyTitle:       "Enter Reply",
    replyLabel:       "Reply (editable)",
    replyPlaceholder: "Enter your message...",
    replySubmit:      "Send",
    replyClose:       "Cancel",
    replyBtn:         "✏️ Reply",
    answered:         "✅ Reply sent.",
  };

  // lang: "ko" | "en" | "ja"
  function _ui(lang) {
    if (lang === "ja") return JA_UI;
    if (lang === "en") return EN_UI;
    return null; // ko → 한국어 하드코딩
  }

  // ── 문의 유형 레이블 ─────────────────────────────────────
  const TYPE_LABEL = {
    "번역문 누락": "번역문 누락",
    "번역문 확인": "번역문 확인",
    "번역문 수정": "번역문 수정",
  };

  const WORKER_SHEET_ID    = process.env.WORKER_SHEET_ID;
  const WORKER_SHEET_RANGE = process.env.WORKER_SHEET_RANGE;
  const workerSheetCache   = { loadedAt: 0, rows: [] };

  // ── fetch + loggedCall 래퍼 ──────────────────────────────
  async function _apiFetch(url, options = {}, meta = {}) {
    return loggedCall(async () => {
      const res  = await fetch(url, options);
      // 비-JSON 응답(HTML 오류 페이지 등)은 파싱 전에 HTTP status·content-type을 담은 에러로 변환 (원인 판독성)
      const ct   = res.headers.get("content-type") || "";
      if (!ct.includes("application/json")) {
        const head = (await res.text()).slice(0, 200);
        throw new Error(`TOTUS API 비-JSON 응답 (HTTP ${res.status}, content-type: ${ct || "없음"}) — ${head}`);
      }
      const json = await res.json();
      if (Array.isArray(json.data))       meta.returnedCount = json.data.length;
      else if (json.data != null)         meta.returnedCount = 1;
      return json;
    }, meta);
  }

  // ── 작업자 시트 조회 (5분 캐시) ──────────────────────────
  async function _getWorkerInfo(email) {
    try {
      if (Date.now() - workerSheetCache.loadedAt > 300000 || !workerSheetCache.rows.length) {
        const res    = await sheetsClient.getValues(WORKER_SHEET_ID, WORKER_SHEET_RANGE);
        workerSheetCache.rows     = (res || []).slice(1);
        workerSheetCache.loadedAt = Date.now();
        console.log(`[workerRelay] 작업자 시트 캐시 갱신 — ${workerSheetCache.rows.length}건`);
      }
      const found = workerSheetCache.rows.find(row => (row[1] || "").trim().toLowerCase() === email.toLowerCase());
      return found ? {
        name:       found[0]?.trim() || null,
        slackId:    found[2]?.trim() || null,
        channelId:  found[3]?.trim() || null,
        totusEmail: found[4]?.trim() || null,  // E열: Totus 이메일
      } : null;
    } catch (e) {
      console.error("[workerRelay] 작업자 시트 조회 실패:", e.message);
      return null;
    }
  }

  // ── Gemini 파싱: 작품명·회차·문의내용 추출 ───────────────
  async function _parseRelayInquiry(text) {
    const prompt = `
아래 문의에서 정보를 추출해줘.
괄호(「」『』<>《》【】 등)가 있으면 제거하고 작품명만 반환해.

1) work_title_ja  : 일본어 또는 중국어 작품명 (없으면 null)
2) work_title_ko  : 한국어 작품명 (없으면 null)
3) episodes       : 회차 숫자 배열. 단일이면 ["31"], 범위/복수면 ["31","32"]. 없으면 null.
4) relay_type     : 아래 순서대로 반드시 하나만 선택.
   ① "번역문 누락" — 번역문 미수신으로 작업 불가·지연인 경우. 제출 지연·완료 언급 있어도 번역문 못 받은 게 원인이면 무조건 "번역문 누락"
   ② "번역문 수정" — 기존 번역문 오류(오역·오탈자 등) 수정 요청
   ③ "번역문 확인" — 번역문 내용 확인 요청
5) action_required : 상대 작업자가 해야 할 일만 한국어 1~2문장으로. 이유·배경·경위 절대 포함 금지.
   (예: "아래 대사의 등장인물 이름을 수정해주세요.", "31화 6번 파일 효과음 번역문을 전달해주세요.")
6) corrections    : 수정 전/후가 명시된 경우 배열. 없으면 [].
   형식: { "before": "수정 전 원문 그대로", "after": "수정 후 원문 그대로" }
   ※ before/after 절대 번역 금지. 일본어면 일본어 그대로.
7) missing_items  : 번역문 누락 위치/파일명 배열. 없으면 [].
   (예: ["31화 6번 파일(31-5.psd) — 배경 효과음", "32화 7번 파일(32-6.psd) — 아래 효과음"])

8) source_lang : 문의 원문의 언어. "ko" / "en" / "ja" 중 하나. 판단 불가면 "ko".

JSON만 출력. 코드블록 금지.
문의: ${text}`.trim();

    const res = await ai.models.generateContent({ model: GEMINI_MODEL, contents: prompt });
    return JSON.parse((res.text || "").replace(/```json|```/g, "").trim());
  }

  // ── Totus: projectUuid 조회 ───────────────────────────────
  async function _getProjectUuid(pivoId) {
    const json = await _apiFetch(
      `${BASE()}/api/v1/projects?pivoId=${encodeURIComponent(pivoId)}`,
      { headers: { Authorization: `Bearer ${TOKEN()}` } },
      { bot: "workerRelay", endpoint: "/projects", params: { pivoId }, expectedCount: 1 }
    );
    if (!json.success) return null;
    const proj = (json.data || []).find(p => {
      const d = p._detail || p;
      return d.진행상태 !== "CANCELED" && d.pivoId != null;
    });
    return proj?.uuid || null;
  }

  // ── Totus: 화수 JOB에서 번역/식자 작업자 목록 조회 ───────
  async function _getJobWorkers(projectUuid, episode) {
    const json = await _apiFetch(
      `${BASE()}/api/v1/projects/${projectUuid}/jobs?episode=${parseInt(episode, 10)}`,
      { headers: { Authorization: `Bearer ${TOKEN()}` } },
      { bot: "workerRelay", endpoint: "/projects/{uuid}/jobs", params: { episode }, expectedCount: 1 }
    );
    if (!json.success) return [];
    const job = (json.data || [])[0] || null;
    if (!job) return [];

    const workers = [];
    for (const op of (job.오퍼레이션 || [])) {
      for (const task of (op.태스크 || [])) {
        if (!RELAY_OP_CODES.has(task.오퍼레이션유형)) continue;
        if (!task.작업자?.이메일) continue;
        workers.push({
          opCode:      task.오퍼레이션유형,
          opName:      task.오퍼레이션유형명,
          workerEmail: task.작업자.이메일,
          workerName:  task.작업자.bid || null,
        });
      }
    }
    return workers;
  }

  // ── 원문 작성자 오퍼레이션 판별 ─────────────────────────
  function _detectRequesterOp(requesterEmail, workers) {
    return workers.find(w => w.workerEmail.toLowerCase() === requesterEmail.toLowerCase()) || null;
  }

  // ── 전달 대상 작업자 결정 ────────────────────────────────
  // 번역 작업자 → 식자검수 우선, 없으면 식자
  // 식자/식자검수 → 번역
  function _resolveTargetWorker(requesterOpCode, workers) {
    if (requesterOpCode === OP.TRANSLATION) {
      return (
        workers.find(w => w.opCode === OP.TYPESETTING_REVIEW) ||
        workers.find(w => w.opCode === OP.TYPESETTING) ||
        null
      );
    }
    if ([OP.TYPESETTING, OP.TYPESETTING_REVIEW].includes(requesterOpCode)) {
      return workers.find(w => w.opCode === OP.TRANSLATION) || null;
    }
    return null;
  }

  // ══════════════════════════════════════════════════════════
  // 메인 핸들러
  // ══════════════════════════════════════════════════════════
  async function handleWorkerRelay(client, dmChannel, analysis, sourceInfo, originalText, requesterUserId, imageUrls = [], apmUserId = null) {

    // 1. Gemini로 상세 파싱
    let parsed = {};
    try { parsed = await _parseRelayInquiry(originalText); } catch (e) { parsed = {}; }

    const titleJa       = parsed.work_title_ja || analysis.title_ja || null;
    const titleKo       = parsed.work_title_ko || analysis.title_ko || null;
    const episodesRaw   = parsed.episodes || (analysis.episode ? [String(analysis.episode)] : null);
    const episodeList   = Array.isArray(episodesRaw) ? episodesRaw.map(e => String(e).replace(/[^0-9]/g,"")).filter(Boolean) : [];
    const episodeLabel  = episodeList.length > 1 ? `${episodeList[0]}-${episodeList[episodeList.length-1]}화` : (episodeList[0] ? `${episodeList[0]}화` : null);
    const episode       = episodeList[0] || null;
    const relayType     = parsed.relay_type     || analysis.inquiry_type || "번역문 누락";
    const actionRequired = parsed.action_required || null;
    const corrections   = Array.isArray(parsed.corrections)  ? parsed.corrections  : [];
    const missingItems  = Array.isArray(parsed.missing_items) ? parsed.missing_items : [];
    const inquiryDetail = parsed.inquiry_detail || originalText;
    const sourceLang    = parsed.source_lang || "ko"; // "ko" | "en" | "ja"

    // 2. 원문 작성자 이름·이메일 조회
    let requesterName    = "";
    let requesterEmail   = "";
    let requesterTotusEmail = "";
    // 담당자 = 이모지 소환한 사람 (requesterUserId)
    let requesterMention = requesterUserId ? `<@${requesterUserId}>` : "APM";
    if (requesterUserId) {
      try {
        const ui     = await client.users.info({ user: requesterUserId });
        requesterName  = ui.user?.profile?.display_name || ui.user?.real_name || "";
        requesterEmail = ui.user?.profile?.email || "";
        // 작업자 시트에서 Totus 이메일 조회 (E열)
        const workerInfoForRequester = await _getWorkerInfo(requesterEmail).catch(() => null);
        requesterTotusEmail = workerInfoForRequester?.totusEmail || requesterEmail; // E열 없으면 Slack 이메일 fallback
      } catch (_) {}
    }
    console.log(`[workerRelay] handleWorkerRelay 시작 — titleJa: ${titleJa} | titleKo: ${titleKo} | episode: ${episode} | relayType: ${relayType} | requesterEmail(Slack): ${requesterEmail} | requesterTotusEmail: ${requesterTotusEmail}`);

    // 3. 작품 매칭
    const matchedTitle = await matchWorkTitleFromSheet(titleJa, titleKo).catch(() => null);
    console.log(`[workerRelay] matchedTitle: ${JSON.stringify(matchedTitle)}`);

    // 작품명 또는 화수 미확보 → pending 저장 + 수동 입력 유도
    if (!matchedTitle || !episode) {
      const pendingId = `wr_pending_${Date.now()}`;
      draftStore.set(pendingId, {
        type: "worker_relay_pending",
        ownerUserId: apmUserId,
        relayType, inquiryDetail, actionRequired, corrections, missingItems, sourceLang,
        workName:          matchedTitle?.koreanProjectName || titleKo || titleJa || "",
        pivoId:            matchedTitle?.pivoId      || null,
        episode:           episode || "",
        episodeList,
        episodeLabel:      episodeLabel || episode || "",
        sourceLink:        sourceInfo.url       || null,
        originalChannelId: sourceInfo.channelId || null,
        originalTs:        sourceInfo.ts        || null,
        imageUrls,
        requesterUserId, requesterName, requesterEmail: requesterTotusEmail, requesterMention,
        apmUserId,
        dmChannelId: dmChannel,
      });

      const missing = [];
      if (!matchedTitle) missing.push("작품명 (시트 매칭 실패)");
      if (!episode)      missing.push("화수");

      await client.chat.postMessage({
        channel: dmChannel,
        text: `⚠️ 누락된 정보가 있어. 직접 입력해줘.`,
        blocks: [
          { type: "section", text: { type: "mrkdwn",
            text: `*📨 작업자 TO 작업자 릴레이 — ${TYPE_LABEL[relayType] || relayType}*\n⚠️ *${missing.join(", ")}*을 특정하지 못했어. 직접 입력해줘.` } },
          { type: "actions", elements: [
            { type: "button", action_id: "wr_manual_input",
              text: { type: "plain_text", text: "✏️ 직접 입력" },
              style: "primary", value: pendingId },
          ]},
        ],
      });
      return;
    }

    const workName = matchedTitle.koreanProjectName || titleKo || titleJa || "-";
    const pivoId   = matchedTitle.pivoId;

    await _proceedWithData(client, dmChannel, {
      relayType, inquiryDetail, actionRequired, corrections, missingItems, sourceLang,
      workName,
      workNameJa: matchedTitle.japaneseDisplayTitle || matchedTitle.japaneseFixedTitle || workName,
      pivoId, episode, episodeList, episodeLabel,
      sourceLink:        sourceInfo.url       || null,
      originalChannelId: sourceInfo.channelId || null,
      originalTs:        sourceInfo.ts        || null,
      imageUrls,
      requesterUserId, requesterName, requesterEmail: requesterTotusEmail, requesterMention,
      apmUserId,
      ownerUserId: apmUserId,
    });
  }

  // ── 작품명·화수 확보 후 Totus 조회 및 초안 전송 ──────────
  async function _proceedWithData(client, dmChannel, data) {
    const { relayType, inquiryDetail, actionRequired, corrections = [], missingItems = [],
            workName, workNameJa, pivoId, episode,
            episodeList = [], episodeLabel,
            sourceLink, originalChannelId, originalTs,
            imageUrls = [],
            sourceLang = "ko",
            requesterUserId, requesterName, requesterEmail, requesterMention = "",
            apmUserId, ownerUserId } = data;
    const _episodeLabel = episodeLabel || (episode ? `${episode}화` : "-");

    // 4. Totus projectUuid
    console.log(`[workerRelay] _proceedWithData 시작 — workName: ${workName} | pivoId: ${pivoId} | episode: ${episode} | requesterEmail: ${requesterEmail}`);
    const projectUuid = await _getProjectUuid(pivoId).catch((e) => { console.error("[workerRelay] _getProjectUuid 오류:", e.message); return null; });
    console.log(`[workerRelay] projectUuid: ${projectUuid}`);
    if (!projectUuid) {
      await client.chat.postMessage({ channel: dmChannel,
        text: `⚠️ Totus에서 *${workName}* 프로젝트를 찾을 수 없어. 직접 확인해줘.` });
      return;
    }

    // 5. JOB 작업자 조회
    const workers = await _getJobWorkers(projectUuid, episode).catch((e) => { console.error("[workerRelay] _getJobWorkers 오류:", e.message); return []; });
    console.log(`[workerRelay] workers: ${JSON.stringify(workers)}`);
    if (!workers.length) {
      await client.chat.postMessage({ channel: dmChannel,
        text: `⚠️ *${workName} ${episode}화* 번역/식자 작업자를 Totus에서 찾을 수 없어.` });
      return;
    }

    // 6. 원문 작성자 오퍼레이션 판별
    const requesterWorker = _detectRequesterOp(requesterEmail, workers);
    console.log(`[workerRelay] requesterWorker: ${JSON.stringify(requesterWorker)}`);
    if (!requesterWorker) {
      const pendingId  = generateDraftId();
      draftStore.set(pendingId, { _workerPick: true, ownerUserId, data, workers, dmChannelId: dmChannel });
      const workerBtns = workers.slice(0, 5).map((w, i) => ({
        type: "button", action_id: `wr_pick_target_${i}`,
        text: { type: "plain_text", text: `${w.opName} · ${w.workerName || w.workerEmail}`.slice(0, 75) },
        value: JSON.stringify({ pendingId, idx: i }),
      }));
      await client.chat.postMessage({ channel: dmChannel,
        text: `⚠️ 원문 작성자(${requesterName || requesterEmail})를 Totus 작업자 목록에서 찾지 못했어. 전달 대상을 직접 선택해줘.`,
        blocks: [
          { type: "section", text: { type: "mrkdwn",
            text: `⚠️ *원문 작성자 미매핑* — 전달 대상을 아래서 선택해줘.\n_(원문 작성자: ${requesterName || requesterEmail})_` } },
          { type: "actions", elements: workerBtns },
        ],
      });
      return;
    }

    // 7. 전달 대상 결정
    const targetWorker = _resolveTargetWorker(requesterWorker.opCode, workers);
    console.log(`[workerRelay] targetWorker: ${JSON.stringify(targetWorker)}`);
    if (!targetWorker) {
      const otherWorkers = workers.filter(w => w.workerEmail !== requesterWorker.workerEmail);
      const pendingId    = generateDraftId();
      draftStore.set(pendingId, { _workerPick: true, ownerUserId, data, workers: otherWorkers, requesterWorker, dmChannelId: dmChannel });
      const workerBtns = otherWorkers.slice(0, 5).map((w, i) => ({
        type: "button", action_id: `wr_pick_target_${i}`,
        text: { type: "plain_text", text: `${w.opName} · ${w.workerName || w.workerEmail}`.slice(0, 75) },
        value: JSON.stringify({ pendingId, idx: i }),
      }));
      await client.chat.postMessage({ channel: dmChannel,
        text: `⚠️ 전달 대상을 자동으로 결정하지 못했어. 아래서 직접 선택해줘.`,
        blocks: [
          { type: "section", text: { type: "mrkdwn",
            text: `⚠️ *오퍼레이션 미매핑* — 전달 대상을 아래서 선택해줘.` } },
          { type: "actions", elements: workerBtns },
        ],
      });
      return;
    }

    // 7-1. 시트에서 전달 대상 Slack ID 미리 조회 → 멘션용
    const targetWorkerInfoPre  = await _getWorkerInfo(targetWorker.workerEmail).catch(() => null);
    const targetSlackId        = targetWorkerInfoPre?.slackId || null;
    const targetDisplayNamePre = targetSlackId ? `<@${targetSlackId}>` : (targetWorkerInfoPre?.name || targetWorker.workerName || targetWorker.workerEmail);
    console.log(`[workerRelay] targetWorkerInfoPre: ${JSON.stringify(targetWorkerInfoPre)} | targetSlackId: ${targetSlackId} | targetDisplayNamePre: ${targetDisplayNamePre}`);
    console.log(`[workerRelay] requesterUserId: ${requesterUserId} | requesterMention: ${requesterMention}`);

    // 8. draftStore 저장
    const draftId = generateDraftId();
    const targetIsTranslator = (targetWorker.opCode === OP.TRANSLATION);

    draftStore.set(draftId, {
      type: "worker_relay",
      ownerUserId,
      relayType, inquiryDetail, actionRequired, corrections, missingItems,
      workName, workNameJa: workNameJa || workName,
      episode, episodeList, episodeLabel: _episodeLabel,
      sourceLink, originalChannelId, originalTs,
      imageUrls,
      sourceLang,
      requesterName, requesterMention, requesterOpName: requesterWorker.opName,
      requesterSlackId: requesterUserId || null,
      apmUserId: apmUserId || null,
      targetWorkerEmail: targetWorker.workerEmail,
      targetWorkerName:  targetWorker.workerName,
      // 대상 선택 시점의 ID가 권한 SSOT다. 전송 시 재조회는 채널/표시명 보강에만 사용한다.
      targetWorkerSlackIds: targetSlackId || "",
      targetOpName:      targetWorker.opName,
      targetIsTranslator,
      dmChannelId: dmChannel,
    });

    // 8-1. 식자 작업자 대상이고 sourceLang이 불명확한 경우 → 언어 선택 버튼 먼저
    // (번역 작업자 대상은 항상 일본어이므로 버튼 불필요)
    if (!targetIsTranslator && sourceLang === "ko") {
      // Gemini가 ko로 감지했지만 영어 작업자일 수도 있으니 APM에게 확인
      await client.chat.postMessage({
        channel: dmChannel,
        text: `🌐 식자 작업자에게 보낼 메시지 언어를 선택해줘.`,
        blocks: [
          { type: "section", text: { type: "mrkdwn",
            text: `*📨 작업자 TO 작업자 릴레이 — ${TYPE_LABEL[relayType] || relayType}*\n*작품:* ${workName} ${_episodeLabel}\n*전달 대상:* ${targetDisplayNamePre} (${targetWorker.opName})\n\n🌐 식자 작업자에게 보낼 메시지 언어를 선택해줘.` } },
          { type: "actions", elements: [
            { type: "button", action_id: "wr_lang_ko",
              text: { type: "plain_text", text: "🇰🇷 한국어" },
              style: "primary", value: draftId },
            { type: "button", action_id: "wr_lang_en",
              text: { type: "plain_text", text: "🇺🇸 영어" },
              value: draftId },
          ]},
        ],
      });
      return;
    }

    // 9. APM DM 초안 전송
    draftStore.set(draftId, { ...draftStore.get(draftId), targetDisplayNamePre });
    await _sendDraft(client, dmChannel, draftId, { ...draftStore.get(draftId) });
  }

  // ── 언어 선택 버튼 (식자 작업자 대상) ───────────────────
  async function _handleLangSelect(body, ack, client, lang) {
    await ack();
    const draftId = body.actions[0].value;
    const data    = draftStore.get(draftId);
    if (!data) return;

    // sourceLang 업데이트
    draftStore.set(draftId, { ...data, sourceLang: lang });

    // 언어 선택 메시지 완료 처리
    try {
      const langLabel = lang === "en" ? "🇺🇸 영어" : "🇰🇷 한국어";
      await client.chat.update({
        channel: body.channel.id, ts: body.message.ts,
        text: `🌐 언어 선택 완료 — ${langLabel}`,
        blocks: [{ type: "section", text: { type: "mrkdwn",
          text: `🌐 언어 선택 완료 — ${langLabel}` } }],
      });
    } catch (_) {}

    // 초안 전송
    await _sendDraft(client, data.dmChannelId, draftId, { ...data, sourceLang: lang });
  }

  app.action("wr_lang_ko", async ({ body, ack, client }) => _handleLangSelect(body, ack, client, "ko"));
  app.action("wr_lang_en", async ({ body, ack, client }) => _handleLangSelect(body, ack, client, "en"));

  // ── APM 초안 전송 함수 ────────────────────────────────────
  async function _sendDraft(client, dmChannel, draftId, data) {
    const { relayType, workName, episodeLabel, episode, sourceLink, imageUrls = [],
            requesterMention, targetOpName,
            targetWorkerName, targetWorkerEmail } = data;
    const _episodeLabel = episodeLabel || (episode ? `${episode}화` : "-");

    // 전달 대상 표시명 (draftStore에 이미 있으면 재사용)
    let targetDisplayNamePre = data.targetDisplayNamePre || null;
    if (!targetDisplayNamePre) {
      const inf = await _getWorkerInfo(targetWorkerEmail).catch(() => null);
      const sid = inf?.slackId || null;
      targetDisplayNamePre = sid ? `<@${sid}>` : (inf?.name || targetWorkerName || targetWorkerEmail);
      draftStore.set(draftId, { ...draftStore.get(draftId), targetDisplayNamePre });
    }

    const linkSection = sourceLink
      ? [{ type: "section", text: { type: "mrkdwn", text: `🔗 <${sourceLink}|원본 링크>` } }]
      : [];
    const imageSection = imageUrls.length > 0
      ? [{ type: "section", text: { type: "mrkdwn",
          text: `*첨부 이미지*\n${imageUrls.map((u, i) => `<${u}|이미지 ${i+1}>`).join("  ")}` } }]
      : [];

    const bodyText = (() => {
      let t = `*작업 요청*\n${data.actionRequired || data.inquiryDetail}`;
      if ((data.corrections || []).length > 0) {
        t += "\n\n*수정 내용*";
        data.corrections.forEach(c => {
          t += `\n*수정 전:*\n\`\`\`${c.before}\`\`\`\n*수정 후:*\n\`\`\`${c.after}\`\`\``;
        });
      }
      if ((data.missingItems || []).length > 0) {
        t += "\n\n*누락 위치*\n" + data.missingItems.map(m => `• ${m}`).join("\n");
      }
      return t;
    })();

    await client.chat.postMessage({
      channel: dmChannel,
      text: `📨 작업자 TO 작업자 릴레이 초안 — ${workName} ${_episodeLabel}`,
      blocks: [
        { type: "section", text: { type: "mrkdwn",
          text: `*📨 작업자 TO 작업자 릴레이*\n*유형:* ${TYPE_LABEL[relayType] || relayType}` } },
        { type: "divider" },
        { type: "section", fields: [
          { type: "mrkdwn", text: `*작품명*\n${workName}` },
          { type: "mrkdwn", text: `*회차*\n${_episodeLabel}` },
          { type: "mrkdwn", text: `*담당자*\n${data.apmUserId ? `<@${data.apmUserId}>` : requesterMention}` },
          { type: "mrkdwn", text: `*전달 대상*\n${targetDisplayNamePre} (${targetOpName})` },
        ]},
        ...linkSection,
        { type: "section", text: { type: "mrkdwn", text: bodyText } },
        ...imageSection,
        { type: "divider" },
        { type: "actions", elements: [
          { type: "button", action_id: "wr_send",
            text: { type: "plain_text", text: "✅ 전송" },
            style: "primary", value: draftId },
          { type: "button", action_id: "wr_edit_content",
            text: { type: "plain_text", text: "✏️ 내용 수정" },
            value: draftId },
          { type: "button", action_id: "wr_close",
            text: { type: "plain_text", text: "❌ 종료" },
            style: "danger", value: draftId },
        ]},
      ],
    });
  }

  // ── 수동 입력 버튼 → 모달 ────────────────────────────────
  app.action("wr_manual_input", async ({ body, ack, client }) => {
    await ack();
    const pendingId = body.actions[0].value;
    const pending   = draftStore.get(pendingId);
    if (!pending) return;

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type:             "modal",
        callback_id:      "wr_manual_submit",
        private_metadata: pendingId,
        title:            { type: "plain_text", text: "정보 직접 입력" },
        submit:           { type: "plain_text", text: "확인" },
        close:            { type: "plain_text", text: "취소" },
        blocks: [
          ...(!pending.pivoId ? [{
            type: "input", block_id: "work_block",
            label: { type: "plain_text", text: "작품명 (한국어)" },
            element: { type: "plain_text_input", action_id: "work_input",
              initial_value: pending.workName || "",
              placeholder: { type: "plain_text", text: "예: 나의 히어로 아카데미아" } },
          }] : []),
          ...(!pending.episode ? [{
            type: "input", block_id: "episode_block",
            label: { type: "plain_text", text: "화수" },
            element: { type: "plain_text_input", action_id: "episode_input",
              initial_value: pending.episode || "",
              placeholder: { type: "plain_text", text: "예: 130" } },
          }] : []),
        ],
      },
    });
  });

  app.view("wr_manual_submit", async ({ body, ack, client }) => {
    await ack();
    const pendingId = body.view.private_metadata;
    const pending   = draftStore.get(pendingId);
    if (!pending) return;

    const workInput    = body.view.state.values.work_block?.work_input?.value    || pending.workName;
    const episodeInput = body.view.state.values.episode_block?.episode_input?.value || pending.episode;
    const episode      = (episodeInput || "").replace(/[^0-9]/g, "");

    let pivoId   = pending.pivoId;
    let workName = pending.workName;
    let matched  = null;
    if (!pivoId && workInput) {
      matched = await matchWorkTitleFromSheet(workInput, workInput).catch(() => null);
      if (matched) { pivoId = matched.pivoId; workName = matched.koreanProjectName || workInput; }
      else { workName = workInput; }
    }

    draftStore.delete(pendingId);

    await _proceedWithData(client, pending.dmChannelId, {
      relayType:         pending.relayType,
      inquiryDetail:     pending.inquiryDetail,
      workName,
      workNameJa:        matched?.japaneseDisplayTitle || matched?.japaneseFixedTitle || workName,
      pivoId:            pivoId || "",
      episode,
      episodeList:       pending.episodeList || (episode ? [episode] : []),
      episodeLabel:      pending.episodeLabel || (episode ? `${episode}화` : ""),
      sourceLink:        pending.sourceLink,
      originalChannelId: pending.originalChannelId,
      originalTs:        pending.originalTs,
      imageUrls:         pending.imageUrls || [],
      requesterUserId:   pending.requesterUserId,
      requesterName:     pending.requesterName,
      requesterEmail:    pending.requesterEmail,
      requesterMention:  pending.requesterMention || "",
      apmUserId:         pending.apmUserId || pending.requesterSlackId || null, // APM ID 유지
      ownerUserId:       pending.ownerUserId || pending.apmUserId || null,
    });
  });

  function _workerRelaySuccessPayload(data, channel, ts) {
    return {
      channel,
      ts,
      text: `✅ 전송 완료 — ${data.workName} ${data.episode}화`,
      blocks: [
        { type: "section", text: { type: "mrkdwn",
          text: `*📨 작업자 TO 작업자 릴레이*\n*유형:* ${TYPE_LABEL[data.relayType] || data.relayType}\n*작품:* ${data.workName} ${data.episodeLabel || data.episode + "화"}\n*전달 대상:* ${data.targetDisplayName || data.targetWorkerName} (${data.targetOpName})\n\n✅ 전송 완료` } },
      ],
    };
  }

  async function _updateWorkerRelaySuccessUi(client, draftId, data, channel, ts) {
    if (!channel || !ts) return;
    await client.chat.update(_workerRelaySuccessPayload(data, channel, ts));
    const current = draftStore.get(draftId) || data;
    draftStore.set(draftId, { ...current, workerRelayUiPending: false });
  }

  async function _deliverWorkerRelay({
    client,
    draftId,
    channelId,
    targetDisplayName,
    targetWorkerSlackIds,
    previewChannelId,
    previewMessageTs,
    alreadyReserved = false,
  }) {
    let data = draftStore.get(draftId);
    if (!data) return;

    // workerRelaySendStatus/workerRelayUiPending을 draftStore 레코드 필드에 저장하는
    // mutation-checkpoint stateStore 어댑터. get/set이 항상 최신 draftStore를 조회·병합해
    // _sendToWorkerChannel이 직접 쓰는 다른 필드(targetWorkerSlackIds, workerMsgTs 등)를
    // 덮어쓰지 않는다.
    //
    // [shape 관례 — 유지보수 주의] worker는 terminal(sent/review_required)과 in-progress를
    // 모두 단일 status 필드(workerRelaySendStatus: sending/sent/review_required)로 표현한다.
    // primitive의 inProgress boolean은 여기서 의도적으로 저장·조회하지 않는다 — set은
    // value.inProgress를 버리고, get은 노출하지 않으며, in-progress marker는 아래 checkEntryGate의
    // isInProgress가 status === "sending"으로 읽는다. reserveInProgress가 붙이는 inProgress:true는
    // 이 어댑터에서 무시되지만, 같은 호출이 state.status를 "sending"으로 세우므로 선점은 성립한다.
    // 따라서 primitive와 영속 state의 shape가 다르다 — inProgress를 배선하려 "정리"하지 말 것
    // (publication-coordinator는 반대로 primitive의 inProgress를 그대로 쓴다).
    const mutationStore = {
      get: key => {
        const rec = draftStore.get(key);
        if (!rec) return undefined;
        return { status: rec.workerRelaySendStatus, uiPending: !!rec.workerRelayUiPending };
      },
      set: (key, value) => {
        const current = draftStore.get(key) || {};
        const next = { ...current, workerRelaySendStatus: value.status };
        if ("uiPending" in value) next.workerRelayUiPending = value.uiPending;
        if ("reviewReason" in value) next.workerRelayReviewReason = value.reviewReason;
        draftStore.set(key, next);
        return value;
      },
    };

    const savedState = readState(mutationStore, draftId);
    const entryGate = checkEntryGate({
      savedState,
      isTerminal: state => state.status === "review_required" || state.status === "sent",
      // alreadyReserved=true는 호출부(wr_send)가 첫 await 전에 이미 자신을 선점한 뒤 넘어온
      // 호출이라는 뜻 — 동시 클릭 drop 대상이 아니므로 in-progress로 취급하지 않는다.
      isInProgress: state => !alreadyReserved && state.status === "sending",
      buildReplayResult: state => ({
        reviewRequired: state.status === "review_required",
        sent: state.status === "sent",
        uiPending: !!state.uiPending,
      }),
      buildInProgressResult: () => null,
    });
    if (entryGate.done) {
      if (entryGate.result?.reviewRequired) {
        await client.chat.postMessage({
          channel: data.dmChannelId,
          text: "⚠️ 작업자 메시지 게시 결과가 불명확해 운영자 확인이 필요해. 전송 버튼을 다시 누르지 말아줘.",
        }).catch(() => {});
      } else if (entryGate.result?.sent && entryGate.result.uiPending) {
        await _updateWorkerRelaySuccessUi(
          client,
          draftId,
          data,
          previewChannelId || data.previewChannelId,
          previewMessageTs || data.previewMessageTs
        ).catch(() => {});
      }
      return;
    }

    // 첫 await(worker 채널 postMessage) 전에 선점한다.
    const reserved = reserveInProgress({
      stateStore: mutationStore,
      stateKey: draftId,
      state: { status: "sending" },
    });
    data = {
      ...draftStore.get(draftId),
      previewChannelId: previewChannelId || data.previewChannelId || null,
      previewMessageTs: previewMessageTs || data.previewMessageTs || null,
    };
    draftStore.set(draftId, data);

    const stages = [
      {
        isDone: () => false,
        // _sendToWorkerChannel이 ts 확인(if (!sent?.ts) throw)과 성공 시 draftStore 기록을
        // 함께 수행한다 — outcome 분류만 여기서 primitive에 위임한다.
        execute: () => _sendToWorkerChannel(
          client,
          data,
          channelId,
          targetDisplayName,
          draftId,
          targetWorkerSlackIds
        ),
        confirm: () => ({ status: "sent", uiPending: true }),
        onOutcomeUnknown: () => {
          const current = draftStore.get(draftId) || data;
          return current.workerMsgTs
            ? { status: "sent", uiPending: true }
            : { status: "review_required", uiPending: false, reviewReason: "worker_message_outcome_unknown" };
        },
        buildError: error => error,
      },
    ];

    try {
      await runCheckpointStages({
        state: reserved,
        stages,
        stateStore: mutationStore,
        stateKey: draftId,
      });
    } catch (error) {
      await client.chat.postMessage({
        channel: data.dmChannelId,
        text: `⚠️ 작업자 메시지 게시 결과를 확정할 수 없어. 운영자가 채널을 확인하고 다시 누르지 말아줘. (${error.message})`,
      }).catch(() => {});
      return;
    }

    const sentState = draftStore.get(draftId) || data;
    await _updateWorkerRelaySuccessUi(
      client,
      draftId,
      sentState,
      previewChannelId || sentState.previewChannelId,
      previewMessageTs || sentState.previewMessageTs
    ).catch(() => {
      const current = draftStore.get(draftId) || sentState;
      draftStore.set(draftId, { ...current, workerRelayUiPending: true });
    });
  }

  // ── [전송] 버튼 → B 작업자 개인 채널로 전달 ─────────────
  app.action("wr_send", async ({ body, ack, client }) => {
    await ack();
    const draftId = body.actions[0].value;
    let data = draftStore.get(draftId);
    if (!data) return;

    if (["sending", "sent", "review_required"].includes(data.workerRelaySendStatus)) {
      await _deliverWorkerRelay({
        client,
        draftId,
        channelId: data.workerChannelId,
        targetDisplayName: data.targetDisplayName || data.targetWorkerName,
        targetWorkerSlackIds: data.targetWorkerSlackIds,
        previewChannelId: body.channel.id,
        previewMessageTs: body.message.ts,
      });
      return;
    }

    // 첫 await 전에 선점한다.
    data = {
      ...data,
      workerRelaySendStatus: "sending",
      previewChannelId: body.channel.id,
      previewMessageTs: body.message.ts,
    };
    draftStore.set(draftId, data);

    // B 작업자 채널 재조회는 채널/표시명 보강용이다. 첫 선택의 Slack ID를 덮어쓰지 않는다.
    const workerInfo = await _getWorkerInfo(data.targetWorkerEmail).catch(() => null);
    const channelId  = workerInfo?.channelId || null;
    const authorizedWorkerSlackIds = data.targetWorkerSlackIds || workerInfo?.slackId || "";
    const targetDisplayName = authorizedWorkerSlackIds
      ? `<@${String(authorizedWorkerSlackIds).split(",")[0].trim()}>`
      : (workerInfo?.name || data.targetWorkerName || data.targetWorkerEmail);

    if (!channelId) {
      draftStore.set(draftId, {
        ...data,
        workerRelaySendStatus: "awaiting_channel",
        targetWorkerSlackIds: authorizedWorkerSlackIds,
        targetDisplayName,
      });
      const retryId = generateDraftId();
      draftStore.set(retryId, {
        _channelRetry: true,
        ownerUserId: data.ownerUserId,
        draftId,
        dmChannelId: data.dmChannelId,
        targetDisplayName,
        targetOpName: data.targetOpName,
        targetWorkerSlackIds: authorizedWorkerSlackIds,
        previewChannelId: body.channel.id,
        previewMessageTs: body.message.ts,
      });
      await client.chat.postMessage({ channel: data.dmChannelId,
        text: `⚠️ ${targetDisplayName}의 채널 ID를 작업자 DB에서 찾을 수 없어.`,
        blocks: [
          { type: "section", text: { type: "mrkdwn",
            text: `⚠️ *${targetDisplayName}(${data.targetOpName})* 채널 ID가 DB에 없어. 채널 ID를 직접 입력하거나 직접 연락해줘.` } },
          { type: "actions", elements: [
            { type: "button", action_id: "wr_manual_channel_input", style: "primary",
              text: { type: "plain_text", text: "📨 채널 직접 입력" },
              value: retryId },
          ]},
        ],
      });
      return;
    }

    try { await client.conversations.join({ channel: channelId }).catch(() => {}); } catch (_) {}
    await _deliverWorkerRelay({
      client,
      draftId,
      channelId,
      targetDisplayName,
      targetWorkerSlackIds: authorizedWorkerSlackIds,
      previewChannelId: body.channel.id,
      previewMessageTs: body.message.ts,
      alreadyReserved: true,
    });
  });

  // ── 작업자 채널 메시지 전송 헬퍼 (wr_send + 채널 직접 입력 공용) ──
  async function _sendToWorkerChannel(client, data, channelId, targetDisplayName, draftId, targetWorkerSlackIds = "") {
    const srcLang = data.sourceLang || "ko";
    const authorizedWorkerSlackIds = String(
      data.targetWorkerSlackIds || targetWorkerSlackIds || ""
    ).trim();
    let msgHeader, msgContent, msgReplyBtn;

    if (data.targetIsTranslator) {
      const typeJa   = await _translateToJa(TYPE_LABEL[data.relayType] || data.relayType);
      const _epLabelJa = (data.episodeList || []).length > 1
        ? `${data.episodeList[0]}～${data.episodeList[data.episodeList.length-1]}話`
        : (data.episodeLabel?.replace("화","話") || `${data.episode || ""}話`);
      const _targetMentionJa = targetDisplayName.startsWith("<@") ? targetDisplayName : "";
      msgHeader = `${_targetMentionJa}\n*📨 ${typeJa}*\n*作品:* ${data.workNameJa || data.workName}　*話:* ${_epLabelJa}\n*担当者:* ${data.requesterMention}`;
      const _actionJa = await _translateToJa(data.actionRequired || data.inquiryDetail).catch(() => data.inquiryDetail);
      let _bodyJa = `*依頼内容*\n${_actionJa}`;
      if ((data.corrections || []).length > 0) {
        _bodyJa += "\n\n*修正内容*";
        data.corrections.forEach(c => { _bodyJa += `\n*修正前:*\n\`\`\`${c.before}\`\`\`\n*修正後:*\n\`\`\`${c.after}\`\`\``; });
      }
      if ((data.missingItems || []).length > 0) {
        _bodyJa += "\n\n*不足箇所*\n" + (data.missingItems || []).map(m => `• ${m}`).join("\n");
      }
      msgContent  = _bodyJa;
      msgReplyBtn = JA_UI.replyBtn;

    } else if (srcLang === "en") {
      const typeEn = TYPE_LABEL[data.relayType] || data.relayType;
      const _epLabelEn = (data.episodeList || []).length > 1
        ? `Ep.${data.episodeList[0]}-${data.episodeList[data.episodeList.length-1]}`
        : `Ep.${data.episode || ""}`;
      const _targetMentionEn = targetDisplayName.startsWith("<@") ? targetDisplayName : "";
      const _apmMention = data.apmUserId ? `<@${data.apmUserId}>` : (data.requesterMention || "");
      msgHeader = `${_targetMentionEn}\n*📨 ${typeEn}*\n*Title:* ${data.workName}　*Episode:* ${_epLabelEn}\n*Manager:* ${_apmMention}`;
      const _actionEn = await _translateTo(data.actionRequired || data.inquiryDetail, "en").catch(() => data.actionRequired || data.inquiryDetail);
      let _bodyEn = `*Request*\n${_actionEn}`;
      if ((data.corrections || []).length > 0) {
        _bodyEn += "\n\n*Corrections*";
        data.corrections.forEach(c => { _bodyEn += `\n*Before:*\n\`\`\`${c.before}\`\`\`\n*After:*\n\`\`\`${c.after}\`\`\``; });
      }
      if ((data.missingItems || []).length > 0) {
        _bodyEn += "\n\n*Missing Items*\n" + (data.missingItems || []).map(m => `• ${m}`).join("\n");
      }
      msgContent  = _bodyEn;
      msgReplyBtn = EN_UI.replyBtn;

    } else {
      const _epLabelKo = (data.episodeList || []).length > 1
        ? `${data.episodeList[0]}-${data.episodeList[data.episodeList.length-1]}화`
        : (data.episodeLabel || `${data.episode || ""}화`);
      const _targetMentionKo = targetDisplayName.startsWith("<@") ? targetDisplayName : "";
      const _apmMention = data.apmUserId ? `<@${data.apmUserId}>` : (data.requesterMention || "");
      msgHeader = `${_targetMentionKo}\n*📨 ${TYPE_LABEL[data.relayType] || data.relayType}*\n*작품:* ${data.workName}　*회차:* ${_epLabelKo}\n*담당자:* ${_apmMention}`;
      let _bodyKo = `*작업 요청*\n${data.actionRequired || data.inquiryDetail}`;
      if ((data.corrections || []).length > 0) {
        _bodyKo += "\n\n*수정 내용*";
        data.corrections.forEach(c => { _bodyKo += `\n*수정 전:*\n\`\`\`${c.before}\`\`\`\n*수정 후:*\n\`\`\`${c.after}\`\`\``; });
      }
      if ((data.missingItems || []).length > 0) {
        _bodyKo += "\n\n*누락 위치*\n" + (data.missingItems || []).map(m => `• ${m}`).join("\n");
      }
      msgContent  = _bodyKo;
      msgReplyBtn = "✏️ 답변하기";
    }

    const messageBlocks = [
      { type: "section", text: { type: "mrkdwn", text: msgHeader } },
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: msgContent } },
    ];
    if (data.relayType === "번역문 누락" && authorizedWorkerSlackIds) {
      messageBlocks.push({
        type: "actions", elements: [
          { type: "button", action_id: "wr_worker_reply",
            text: { type: "plain_text", text: msgReplyBtn },
            style: "primary", value: draftId },
        ]
      });
    }

    const _t0 = Date.now();
    const sent = await client.chat.postMessage({
      channel: channelId,
      text: `📨 ${data.workName} ${data.episodeLabel || data.episode + "화"} — ${TYPE_LABEL[data.relayType] || data.relayType}`,
      blocks: messageBlocks,
    });
    if (!sent?.ts) throw new Error("작업자 메시지 ts를 확인할 수 없어.");
    draftStore.set(draftId, {
      ...data,
      targetWorkerSlackIds: authorizedWorkerSlackIds,
      targetDisplayName,
      workerChannelId: channelId,
      workerMsgTs: sent.ts,
      sentMsgHeader: msgHeader,
      sentMsgContent: msgContent,
      workerRelaySendStatus: "sent",
      workerRelayUiPending: true,
    });
    try { logEvent("workerRelay", "/slack/relay-sent", Date.now() - _t0, true); } catch (_) {}

    const workerImageUrls = data.imageUrls || [];
    if (workerImageUrls.length > 0) {
      const sharp  = require("sharp");
      const axios  = require("axios");
      const fs     = require("fs");
      const path   = require("path");
      const os     = require("os");
      const tmpDir = os.tmpdir();
      const failedLinks = [];
      for (const [i, url] of workerImageUrls.entries()) {
        try {
          let downloadUrl = url;
          const fileIdMatch = url.match(/\/(F[A-Z0-9]{8,})\//);
          if (fileIdMatch) {
            try {
              const infoRes = await client.files.info({ file: fileIdMatch[1] });
              downloadUrl = infoRes.file?.url_private_download || infoRes.file?.url_private || url;
            } catch (_) {}
          }
          const res = await axios.get(downloadUrl, {
            responseType: "arraybuffer",
            headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
          });
          const tmpPath = path.join(tmpDir, `relay_thumb_${Date.now()}_${i}.png`);
          await sharp(Buffer.from(res.data))
            .resize({ width: 320, withoutEnlargement: true })
            .extend({ top: 20, bottom: 20, left: 20, right: 20,
              background: { r: 255, g: 255, b: 255, alpha: 1 } })
            .png().toFile(tmpPath);
          await client.files.uploadV2({
            channel_id: channelId,
            file: fs.createReadStream(tmpPath),
            filename: `relay_thumb_${i + 1}.png`,
            initial_comment: "",
          });
          fs.unlink(tmpPath, () => {});
        } catch (imgErr) {
          console.error(`[workerRelay] 이미지 ${i + 1} 전처리 실패:`, imgErr.message);
          const imgLabel = data.targetIsTranslator ? `画像 ${i + 1}` : (srcLang === "en" ? `Image ${i+1}` : `이미지 ${i + 1}`);
          failedLinks.push(`<${url}|${imgLabel}>`);
        }
      }
      if (failedLinks.length > 0) {
        await client.chat.postMessage({
          channel: channelId, thread_ts: sent.ts,
          text: failedLinks.join("\n"),
          blocks: [{ type: "section", text: { type: "mrkdwn",
            text: (data.targetIsTranslator
              ? "⚠️ *サムネイル生成失敗 — 原本リンクで確認してください*\n"
              : srcLang === "en"
                ? "⚠️ *Thumbnail generation failed — please check the original link*\n"
                : "⚠️ *썸네일 생성 실패 — 원본 링크로 확인해주세요*\n") + failedLinks.join("\n") } }],
        }).catch(() => {});
      }
    }
    await client.chat.postMessage({ channel: data.dmChannelId,
      text: `✅ ${targetDisplayName}(${data.targetOpName}) 채널로 전달했어.` }).catch(() => {});
    return sent;
  }

  // ── 작업자 선택 버튼 핸들러 (wr_pick_target_0~4) ─────────────
  app.action(/^wr_pick_target_\d+$/, async ({ ack, body, client }) => {
    await ack();
    const { pendingId, idx } = JSON.parse(body.actions[0].value || "{}");
    const pending = draftStore.get(pendingId);
    if (!pending) return;
    draftStore.delete(pendingId);
    const targetWorker = pending.workers[idx];
    if (!targetWorker) return;
    const reqWorker = pending.requesterWorker || { opCode: "unknown", opName: "미매핑", workerEmail: "" };
    // 전달 대상 확정 후 draftStore 저장 + 초안 전송
    const { data, dmChannelId } = pending;
    const targetWorkerInfoPre  = await _getWorkerInfo(targetWorker.workerEmail).catch(() => null);
    const targetSlackId        = targetWorkerInfoPre?.slackId || null;
    const targetDisplayNamePre = targetSlackId
      ? `<@${targetSlackId}>`
      : (targetWorkerInfoPre?.name || targetWorker.workerName || targetWorker.workerEmail);
    const draftId = generateDraftId();
    const targetIsTranslator = (targetWorker.opCode === OP.TRANSLATION);
    const _episodeLabel = data.episodeLabel || (data.episode ? `${data.episode}화` : "-");
    draftStore.set(draftId, {
      type: "worker_relay",
      ownerUserId: data.ownerUserId || data.apmUserId || null,
      relayType: data.relayType, inquiryDetail: data.inquiryDetail,
      actionRequired: data.actionRequired, corrections: data.corrections || [], missingItems: data.missingItems || [],
      workName: data.workName, workNameJa: data.workNameJa || data.workName,
      episode: data.episode, episodeList: data.episodeList || [], episodeLabel: _episodeLabel,
      sourceLink: data.sourceLink, originalChannelId: data.originalChannelId, originalTs: data.originalTs,
      imageUrls: data.imageUrls || [],
      sourceLang: data.sourceLang || "ko",
      requesterName: data.requesterName, requesterMention: data.requesterMention,
      requesterOpName: reqWorker.opName,
      requesterSlackId: data.requesterUserId || null,
      apmUserId: data.apmUserId || null,
      targetWorkerEmail: targetWorker.workerEmail,
      targetWorkerName:  targetWorker.workerName,
      targetWorkerSlackIds: targetSlackId || "",
      targetOpName:      targetWorker.opName,
      targetIsTranslator,
      dmChannelId,
    });
    if (!targetIsTranslator && (data.sourceLang || "ko") === "ko") {
      await client.chat.postMessage({
        channel: dmChannelId,
        text: "🌐 식자 작업자에게 보낼 메시지 언어를 선택해줘.",
        blocks: [
          { type: "section", text: { type: "mrkdwn",
            text: `*📨 작업자 TO 작업자 릴레이 — ${TYPE_LABEL[data.relayType] || data.relayType}*\n*작품:* ${data.workName} ${_episodeLabel}\n*전달 대상:* ${targetDisplayNamePre} (${targetWorker.opName})\n\n🌐 식자 작업자에게 보낼 메시지 언어를 선택해줘.` } },
          { type: "actions", elements: [
            { type: "button", action_id: "wr_lang_ko", text: { type: "plain_text", text: "🇰🇷 한국어" }, style: "primary", value: draftId },
            { type: "button", action_id: "wr_lang_en", text: { type: "plain_text", text: "🇺🇸 영어" }, value: draftId },
          ]},
        ],
      });
      return;
    }
    draftStore.set(draftId, { ...draftStore.get(draftId), targetDisplayNamePre });
    await _sendDraft(client, dmChannelId, draftId, { ...draftStore.get(draftId) });
  });

  // ── 채널 직접 입력 버튼 ──────────────────────────────────────
  app.action("wr_manual_channel_input", async ({ ack, body, client }) => {
    await ack();
    const retryId = body.actions[0].value;
    const retry   = draftStore.get(retryId);
    if (!retry) return;
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal", callback_id: "wr_manual_channel_submit",
        private_metadata: retryId,
        title:  { type: "plain_text", text: "채널 직접 입력" },
        submit: { type: "plain_text", text: "전송" },
        close:  { type: "plain_text", text: "취소" },
        blocks: [
          { type: "section", text: { type: "mrkdwn",
            text: `*전달 대상:* ${retry.targetDisplayName} (${retry.targetOpName})` } },
          { type: "input", block_id: "manual_channel_block",
            label: { type: "plain_text", text: "채널 ID" },
            element: { type: "plain_text_input", action_id: "value",
              placeholder: { type: "plain_text", text: "예: C0A1B2C3D4E" } },
            hint: { type: "plain_text", text: "C로 시작하는 Slack 채널 ID" } },
        ],
      },
    });
  });

  app.view("wr_manual_channel_submit", async ({ ack, body, view, client }) => {
    await ack();
    const retryId = body.view.private_metadata;
    const retry   = draftStore.get(retryId);
    if (!retry) {
      await client.chat.postMessage({ channel: body.user.id, text: "⚠️ 세션이 만료됐어. 처음부터 다시 시도해줘." });
      return;
    }
    draftStore.delete(retryId);
    const channelId = (view.state.values.manual_channel_block?.value?.value || "").trim();
    if (!channelId) return;
    const data = draftStore.get(retry.draftId);
    if (!data) {
      await client.chat.postMessage({ channel: retry.dmChannelId, text: "⚠️ 세션이 만료됐어. 처음부터 다시 시도해줘." });
      return;
    }
    try { await client.conversations.join({ channel: channelId }).catch(() => {}); } catch (_) {}
    await _deliverWorkerRelay({
      client,
      draftId: retry.draftId,
      channelId,
      targetDisplayName: retry.targetDisplayName,
      targetWorkerSlackIds: retry.targetWorkerSlackIds || "",
      previewChannelId: retry.previewChannelId,
      previewMessageTs: retry.previewMessageTs,
    });
  });

  // ── [내용 수정] 버튼 → 모달 ─────────────────────────────
  app.action("wr_edit_content", async ({ body, ack, client }) => {
    await ack();
    const draftId = body.actions[0].value;
    const data    = draftStore.get(draftId);
    if (!data) return;

    // 누락 위치 배열 → 줄바꿈 텍스트로 변환
    const missingText = (data.missingItems || []).join("\n");

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type:             "modal",
        callback_id:      "wr_edit_submit",
        private_metadata: JSON.stringify({
          draftId,
          dmChannelId:  data.dmChannelId,
          msgChannel:   body.channel.id,
          msgTs:        body.message.ts,
        }),
        title:  { type: "plain_text", text: "내용 수정" },
        submit: { type: "plain_text", text: "확인" },
        close:  { type: "plain_text", text: "취소" },
        blocks: [
          {
            type: "input", block_id: "edit_workname",
            label: { type: "plain_text", text: "작품명" },
            element: { type: "plain_text_input", action_id: "workname_input",
              initial_value: data.workName || "" },
          },
          {
            type: "input", block_id: "edit_episode",
            label: { type: "plain_text", text: "회차" },
            element: { type: "plain_text_input", action_id: "episode_input",
              initial_value: data.episodeLabel || (data.episode ? `${data.episode}화` : "") },
            hint: { type: "plain_text", text: "예: 31화 또는 31-32화" },
          },
          {
            type: "input", block_id: "edit_action",
            label: { type: "plain_text", text: "작업 요청 내용" },
            element: { type: "plain_text_input", action_id: "action_input",
              multiline: true,
              initial_value: data.actionRequired || data.inquiryDetail || "" },
          },
          {
            type: "input", block_id: "edit_missing",
            label: { type: "plain_text", text: "누락 위치 (줄바꿈으로 구분)" },
            optional: true,
            element: { type: "plain_text_input", action_id: "missing_input",
              multiline: true,
              initial_value: missingText,
              placeholder: { type: "plain_text", text: "예: 31화 6번 파일(31-5.psd) — 배경 효과음" } },
          },
        ],
      },
    });
  });

  // ── 내용 수정 모달 제출 → draftStore 갱신 + APM 초안 재전송 ──
  app.view("wr_edit_submit", async ({ body, ack, client }) => {
    await ack();
    const { draftId, dmChannelId, msgChannel, msgTs } = JSON.parse(body.view.private_metadata);
    const data = draftStore.get(draftId);
    if (!data) return;

    const vals = body.view.state.values;
    const newWorkName    = vals.edit_workname?.workname_input?.value?.trim() || data.workName;
    const newEpisodeRaw  = vals.edit_episode?.episode_input?.value?.trim()   || "";
    const newAction      = vals.edit_action?.action_input?.value?.trim()     || data.actionRequired || data.inquiryDetail;
    const newMissingRaw  = vals.edit_missing?.missing_input?.value?.trim()   || "";
    const newMissingItems = newMissingRaw ? newMissingRaw.split("\n").map(s => s.trim()).filter(Boolean) : [];

    // 회차 파싱 — "31화" / "31-32화" / "31" 모두 처리
    const epMatch = newEpisodeRaw.match(/(\d+)[-~～](\d+)/);
    let newEpisode      = data.episode;
    let newEpisodeList  = data.episodeList || [];
    let newEpisodeLabel = data.episodeLabel;
    if (epMatch) {
      const from = parseInt(epMatch[1], 10);
      const to   = parseInt(epMatch[2], 10);
      newEpisodeList  = Array.from({ length: to - from + 1 }, (_, i) => String(from + i));
      newEpisode      = String(from);
      newEpisodeLabel = `${from}-${to}화`;
    } else {
      const single = newEpisodeRaw.replace(/[^0-9]/g, "");
      if (single) {
        newEpisode      = single;
        newEpisodeList  = [single];
        newEpisodeLabel = `${single}화`;
      }
    }

    // draftStore 업데이트
    const updated = {
      ...data,
      workName:       newWorkName,
      workNameJa:     newWorkName !== data.workName ? newWorkName : data.workNameJa,
      episode:        newEpisode,
      episodeList:    newEpisodeList,
      episodeLabel:   newEpisodeLabel,
      actionRequired: newAction,
      inquiryDetail:  newAction,
      missingItems:   newMissingItems,
    };
    draftStore.set(draftId, updated);

    // 기존 APM 초안 메시지 업데이트
    const linkSection = updated.sourceLink
      ? [{ type: "section", text: { type: "mrkdwn", text: `🔗 <${updated.sourceLink}|원본 링크>` } }]
      : [];
    const imageSection = (updated.imageUrls || []).length > 0
      ? [{ type: "section", text: { type: "mrkdwn",
          text: `*첨부 이미지*\n${updated.imageUrls.map((u, i) => `<${u}|이미지 ${i+1}>`).join("  ")}` } }]
      : [];

    const bodyText = (() => {
      let t = `*작업 요청*\n${updated.actionRequired}`;
      if ((updated.corrections || []).length > 0) {
        t += "\n\n*수정 내용*";
        updated.corrections.forEach(c => {
          t += `\n*수정 전:*\n\`\`\`${c.before}\`\`\`\n*수정 후:*\n\`\`\`${c.after}\`\`\``;
        });
      }
      if (updated.missingItems.length > 0) {
        t += "\n\n*누락 위치*\n" + updated.missingItems.map(m => `• ${m}`).join("\n");
      }
      return t;
    })();

    try {
      await client.chat.update({
        channel: msgChannel, ts: msgTs,
        text: `📨 작업자 TO 작업자 릴레이 초안 — ${updated.workName} ${updated.episodeLabel}`,
        blocks: [
          { type: "section", text: { type: "mrkdwn",
            text: `*📨 작업자 TO 작업자 릴레이*\n*유형:* ${TYPE_LABEL[updated.relayType] || updated.relayType}` } },
          { type: "divider" },
          { type: "section", fields: [
            { type: "mrkdwn", text: `*작품명*\n${updated.workName}` },
            { type: "mrkdwn", text: `*회차*\n${updated.episodeLabel}` },
            { type: "mrkdwn", text: `*의뢰자*\n${updated.requesterMention}` },
            { type: "mrkdwn", text: `*전달 대상*\n${updated.targetDisplayName || updated.targetWorkerName || updated.targetWorkerEmail} (${updated.targetOpName})` },
          ]},
          ...linkSection,
          { type: "section", text: { type: "mrkdwn", text: bodyText } },
          ...imageSection,
          { type: "divider" },
          { type: "context", elements: [{ type: "mrkdwn", text: "✏️ _내용이 수정되었어._" }] },
          { type: "actions", elements: [
            { type: "button", action_id: "wr_send",
              text: { type: "plain_text", text: "✅ 전송" },
              style: "primary", value: draftId },
            { type: "button", action_id: "wr_edit_content",
              text: { type: "plain_text", text: "✏️ 내용 수정" },
              value: draftId },
            { type: "button", action_id: "wr_close",
              text: { type: "plain_text", text: "❌ 종료" },
              style: "danger", value: draftId },
          ]},
        ],
      });
    } catch (e) {
      console.error("[workerRelay] 초안 업데이트 실패:", e.message);
      await client.chat.postMessage({ channel: dmChannelId, text: "✅ 내용이 수정됐어. (메시지 업데이트 실패 — 전송은 정상 동작해)" });
    }
  });

  // ── [종료] 버튼 ──────────────────────────────────────────
  app.action("wr_close", async ({ body, ack, client }) => {
    await ack();
    draftStore.delete(body.actions[0].value);
    try {
      await client.chat.update({
        channel: body.channel.id, ts: body.message.ts,
        text: "❌ 릴레이 문의 종료",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "❌ 릴레이 문의가 종료됐어." } }],
      });
    } catch (_) {}
  });

  // ── [답변하기] 버튼 → 모달 (언어별 UI) ──────────────────
  app.action("wr_worker_reply", async ({ body, ack, client }) => {
    await ack();
    const draftId = body.actions[0].value;
    const data    = draftStore.get(draftId);
    if (!data) return;

    // 번역 작업자 대상: 항상 ja / 식자 작업자: sourceLang
    const modalLang = data.targetIsTranslator ? "ja" : (data.sourceLang || "ko");
    const ui = _ui(modalLang);

    const typeLabel = modalLang === "ja"
      ? await _translateToJa(TYPE_LABEL[data.relayType] || data.relayType).catch(() => data.relayType)
      : (TYPE_LABEL[data.relayType] || data.relayType);

    const epStr = modalLang === "ja"
      ? (data.episodeLabel?.replace("화","話") || data.episode + "話")
      : (data.episodeLabel || data.episode + "화");
    const sectionText = `*${data.workName} ${epStr}* — ${typeLabel}`;

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type:             "modal",
        callback_id:      "wr_reply_submit",
        private_metadata: JSON.stringify({
          draftId,
          workerChannelId: body.channel.id,
          workerMsgTs:     body.message.ts,
        }),
        title:  { type: "plain_text", text: ui ? ui.replyTitle  : "답변 입력" },
        submit: { type: "plain_text", text: ui ? ui.replySubmit : "전송" },
        close:  { type: "plain_text", text: ui ? ui.replyClose  : "취소" },
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: sectionText } },
          { type: "input", block_id: "reply_block",
            label: { type: "plain_text", text: ui ? ui.replyLabel : "답변 내용 (수정 가능)" },
            element: { type: "plain_text_input", action_id: "reply_input",
              multiline: true,
              placeholder: { type: "plain_text", text: ui ? ui.replyPlaceholder : "내용을 입력하세요..." } } },
        ],
      },
    });
  });

  // ── 모달 제출 → A 작업자 원문 TS에 댓글 ─────────────────
  app.view("wr_reply_submit", async ({ body, ack, client }) => {
    await ack();
    const { draftId, workerChannelId, workerMsgTs } = JSON.parse(body.view.private_metadata);
    const data = draftStore.get(draftId);
    if (!data) return;

    const replyText = body.view.state.values.reply_block.reply_input.value;

    // A 작업자 원문 TS에 댓글
    if (data.originalChannelId && data.originalTs) {
      try {
        await client.conversations.join({ channel: data.originalChannelId }).catch(() => {});
        const _mentionReq = data.requesterSlackId ? `<@${data.requesterSlackId}> ` : "";
        await client.chat.postMessage({
          channel:   data.originalChannelId,
          thread_ts: data.originalTs,
          text:      `📨 답변이 도착했습니다.`,
          blocks: [
            { type: "section", text: { type: "mrkdwn",
              text: `${_mentionReq}*📨 답변 도착*\n*작품:* ${data.workName} ${data.episodeLabel || data.episode + "화"}\n*담당자:* ${data.requesterMention}` } },
            { type: "divider" },
            { type: "section", text: { type: "mrkdwn", text: replyText } },
          ],
        });
      } catch (e) {
        console.error("[workerRelay] 원문 TS 댓글 실패:", e.message);
      }
    }

    // B 작업자 채널 메시지 완료 처리 (전송 시 본문 그대로 + 완료 상태 추가)
    try {
      const isJa     = data.targetIsTranslator;
      const srcLang2 = data.sourceLang || "ko";
      const doneLabel = isJa ? "✅ 返信が送信されました。"
        : srcLang2 === "en" ? "✅ Reply sent."
        : "✅ 답변이 전달되었습니다.";

      const workerImageUrls = data.imageUrls || [];
      const imgLabel = isJa ? "添付画像" : "첨부 이미지";
      const workerImageSection = workerImageUrls.length > 0
        ? [{ type: "section", text: { type: "mrkdwn",
            text: `*${imgLabel}*\n${workerImageUrls.map((u, i) => `<${u}|${isJa ? `画像 ${i+1}` : `이미지 ${i+1}`}>`).join("  ")}` } }]
        : [];

      await client.chat.update({
        channel: workerChannelId, ts: workerMsgTs,
        text: isJa ? `✅ 返信完了 — ${data.workName} ${data.episode}話` : `✅ 답변 전송 완료 — ${data.workName} ${data.episode}화`,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: data.sentMsgHeader || "" } },
          { type: "divider" },
          { type: "section", text: { type: "mrkdwn", text: data.sentMsgContent || "" } },
          ...workerImageSection,
          { type: "context", elements: [{ type: "mrkdwn", text: doneLabel }] },
        ],
      });
    } catch (_) {}

    // APM DM 완료 알림
    await client.chat.postMessage({ channel: data.dmChannelId,
      text: `✅ ${data.targetDisplayName || data.targetWorkerName}의 답변이 원문 스레드에 전달됐어.` });

    draftStore.delete(draftId);
  });

  return { handleWorkerRelay };
};
