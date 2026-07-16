// ══════════════════════════════════════════════════════════════════
// fileOrderFlow.js — 원본 파일 순서 문의 플로우
// app.js 에서 require("./fileOrderFlow")(app, { ai, GEMINI_MODEL, matchWorkTitleFromSheet, generateDraftId, draftStore }) 로 호출
// ══════════════════════════════════════════════════════════════════

const {
  readKoreanProjectNameFromSelectionPayload,
} = require("./slack/title-selection-payload");
const {
  checkEntryGate,
  readState,
  reserveInProgress,
  runCheckpointStages,
} = require("./slack/mutation-checkpoint");

module.exports = function registerFileOrderFlow(app, { ai, GEMINI_MODEL, matchWorkTitleFromSheet, matchWorkTitleWithCandidates, generateDraftId, draftStore }) {

  const { loggedCall } = require("./apiLogger");

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

  // ── Gemini 번역 ───────────────────────────────────────────────
  async function _foTranslate(text, targetLang, workName) {
    const langMap = { en: "English", ja: "Japanese", zh: "Chinese (Simplified)" };
    const langName = langMap[targetLang];
    if (!langName) return text;
    // 작품명을 플레이스홀더로 치환해 번역 대상에서 제외
    const PLACEHOLDER = "[[TITLE]]";
    const escaped = workName ? text.replace(workName, PLACEHOLDER) : text;
    const prompt = `Translate the following text into ${langName}. Return only the translated text, no explanation, no quotes. Do not translate "${PLACEHOLDER}" — keep it exactly as-is.\n\n${escaped}`;
    try {
      const res = await ai.models.generateContent({ model: GEMINI_MODEL, contents: prompt });
      const translated = res.text?.trim() || escaped;
      return workName ? translated.replace(PLACEHOLDER, workName) : translated;
    } catch (e) {
      console.error("[fileOrder] 번역 실패:", e.message);
      return text;
    }
  }

  // ── AI 파싱 ────────────────────────────────────────────────────
  async function parseFileOrderInquiry(text) {
    const prompt = `
아래 문의에서 정보를 추출해줘.
괄호(「」『』<>《》【】 등)가 있으면 제거하고 작품명만 반환해.

1) work_title_ja : 일본어 또는 중국어 작품명 (없으면 null)
2) work_title_ko : 한국어 작품명 (없으면 null)
3) episode       : 회차 숫자만 (예: "204話" → "204", "60화" → "60", 없으면 null)
4) page_numbers  : 잘못된 페이지/파일 번호 배열 (언급됐을 때만, 없으면 [])

JSON만 출력. 코드블록 금지.
문의: ${text}`.trim();

    const res = await ai.models.generateContent({ model: GEMINI_MODEL, contents: prompt });
    return JSON.parse((res.text || "").replace(/```json|```/g, "").trim());
  }

  // ── 내부 플랫폼 API: 프로젝트 UUID 조회 (공통) ────────────────
  async function _getProjectUuid(workName, pivoId = null) {
    const BASE  = process.env.PLATFORM_API_URL;
    const TOKEN = process.env.PLATFORM_API_TOKEN;
    const query = pivoId
      ? `pivoId=${encodeURIComponent(pivoId)}`
      : `name=${encodeURIComponent(workName)}`;
    console.log(`[Totus] 프로젝트 조회 → ${query}`);
    const json = await _apiFetch(`${BASE}/api/v1/projects?${query}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }, { bot: "fileOrder", endpoint: "/projects", params: { query }, expectedCount: 1 });
    console.log(`[Totus] 응답 success:${json.success} count:${(json.data||[]).length}`, (json.data||[]).map(p => `${p.uuid}/${p.name}`));
    if (!json.success) throw new Error(json.error?.message || "프로젝트 검색 실패");
    const allProjects = json.data || [];
    const projects = allProjects.filter(p => {
      const detail = p._detail || p;
      return detail.진행상태 !== "CANCELED" && detail.pivoId != null;
    });
    // 필터 후 없으면 전체 중 첫 번째 사용 (name 조회 폴백)
    const result = projects.length ? projects : allProjects;
    if (!result.length) return null;
    return result[0].uuid;
  }

  // ── 내부 플랫폼 API: source-groups 단건 조회 (episode 파라미터) ──
  // source-groups API = 에디터 파일 관리 탭 순서 (어드민 드래그 반영)
  async function _getEpisodeFolder(projectUuid, episode) {
    const BASE  = process.env.PLATFORM_API_URL;
    const TOKEN = process.env.PLATFORM_API_TOKEN;
    const epNum = parseInt(episode, 10);
    const json = await _apiFetch(`${BASE}/api/v1/projects/${projectUuid}/source-groups?episode=${epNum}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }, { bot: "fileOrder", endpoint: "/projects/{uuid}/source-groups", params: { episode: epNum }, expectedCount: 1 });
    if (!json.success) throw new Error(json.error?.message || "source-groups 조회 실패");
    const groups = json.data || [];

    // source-groups API가 episode 서버 사이드 필터 지원 → 첫 번째 항목 사용
    const group = groups[0] || null;
    if (group) {
      group.파일목록 = (group.파일목록 || []).sort((a, b) => a.순서 - b.순서);
      console.log(`[episodeFolder] ${episode}화 → 그룹: ${group.이름}`);
      console.log("[episodeFolder] 파일 순서:", group.파일목록.map(f => `${f.파일이름}(순서:${f.순서})`));
    } else {
      console.log(`[episodeFolder] 그룹 없음 — 에피소드: ${epNum}`);
    }

    return group;
  }

  // ── 내부 플랫폼 API: 파일 목록 조회 ──────────────────────────
  // 반환: { files, projectUuid, sourceGroupId, fileMap }
  async function fetchFileListFromPlatform(workName, episode, pivoId = null) {
    const projectUuid = await _getProjectUuid(workName, pivoId);
    if (!projectUuid) {
      console.log("[fileList] 프로젝트 없음:", workName);
      return null;
    }
    const group = await _getEpisodeFolder(projectUuid, episode);
    if (!group) {
      console.log("[fileList] 회차 그룹 없음 — projectUuid:", projectUuid, "episode:", episode);
      return null;
    }
    const files   = (group.파일목록 || []).map(f => f.파일이름);
    const fileMap = {};
    for (const f of (group.파일목록 || [])) fileMap[f.파일이름] = f.id;
    console.log("[fileList] 현재 순서 (어드민 드래그 기준):", files);
    return { files, projectUuid, sourceGroupId: group.id, fileMap };
  }

  function confirmedMutationFailure(message) {
    const error = new Error(message);
    error.mutationOutcome = "not_applied";
    return error;
  }

  // ── 내부 플랫폼 API: 파일 순서 수정/그룹 확정 stage 분리 ─────
  // 두 POST를 분리해 reorder 성공 checkpoint 뒤에는 complete만 재시도한다.
  async function applyFileReorderStage(correctOrder, fileMap) {
    const BASE  = process.env.PLATFORM_API_URL;
    const TOKEN = process.env.PLATFORM_API_TOKEN;

    const sources = correctOrder.map((name, idx) => {
      const sourceId = fileMap[name];
      if (!sourceId) throw new Error(`파일명 "${name}"에 해당하는 id를 찾을 수 없어.`);
      return { sourceId, order: idx };
    });

    const reqBody = { sources };
    console.log("[reorder] 요청 body:", JSON.stringify(reqBody, null, 2));

    const json = await _apiFetch(`${BASE}/api/v1/files/reorder`, {
      method:  "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body:    JSON.stringify(reqBody),
    }, { bot: "fileOrder", endpoint: "/files/reorder", params: {}, expectedCount: null });
    console.log("[reorder] 응답 전체:", JSON.stringify(json, null, 2));
    if (!json.success) throw confirmedMutationFailure(json.error?.message || "파일 순서 변경 실패");

    console.log("[reorder] 완료 — sources:", sources.length);
    return true;
  }

  async function completeSourceGroupStage(sourceGroupId) {
    const BASE  = process.env.PLATFORM_API_URL;
    const TOKEN = process.env.PLATFORM_API_TOKEN;
    const completeJson = await _apiFetch(`${BASE}/api/v1/source-groups/complete`, {
      method:  "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ sourceGroupIds: [sourceGroupId] }),
    }, { bot: "fileOrder", endpoint: "/source-groups/complete", params: {}, expectedCount: null });
    console.log("[complete] 응답 전체:", JSON.stringify(completeJson, null, 2));
    if (!completeJson.success) throw confirmedMutationFailure(completeJson.error?.message || "확정 처리 실패");
    console.log("[complete] 완료 — sourceGroupId:", sourceGroupId);
    return true;
  }

  // ── 파일명에서 시퀀스 번호 추출 ───────────────────────────────
  // 패턴 1: "작품명-60-03.psd" → 3
  // 패턴 2: "003.psd" / "003_copy.psd" 등 앞자리 숫자 → 3
  function extractSeqFromFilename(filename) {
    // ^ 앵커 제거 — 한자·알파벳 등 비숫자 접두사가 있어도 첫 번째 숫자 시퀀스를 정상 인식
    // 반환값: [주번호, 부번호, 서브페이지] 3개
    //   36-9.2.psd  → [36, 9, 2]  (서브페이지 2 → 36-9.psd 보다 뒤, 36-10.psd 보다 앞)
    //   36-9.psd    → [36, 9, 0]
    //   龙头44-1.psd → [44, 1, 0]
    //   001.psd     → [1,  0, 0]

    // 숫자-숫자.숫자 형식 (서브페이지) — 일반 패턴보다 먼저 체크
    const p0 = filename.match(/(\d+)[_\-](\d+)\.(\d+)/);
    if (p0) return [parseInt(p0[1], 10), parseInt(p0[2], 10), parseInt(p0[3], 10)];
    // 숫자-숫자 또는 숫자_숫자 형식 (예: 16-10.psd → [16,10,0], 龙头44-1.psd → [44,1,0])
    const p1 = filename.match(/(\d+)[_\-](\d+)/);
    if (p1) return [parseInt(p1[1], 10), parseInt(p1[2], 10), 0];
    // 단순 숫자 형식 (예: 001.psd)
    const p2 = filename.match(/(\d+)/);
    if (p2) return [parseInt(p2[1], 10), 0, 0];
    return [9999, 9999, 9999];
  }

  // ── 파일명 기준으로 올바른 순서 제안 ─────────────────────────
  function suggestCorrectOrder(fileList) {
    return [...fileList].sort((a, b) => {
      const [a1, a2, a3] = extractSeqFromFilename(a);
      const [b1, b2, b3] = extractSeqFromFilename(b);
      if (a1 !== b1) return a1 - b1;
      if (a2 !== b2) return a2 - b2;
      return a3 - b3;
    });
  }


  function isDifferentOrder(current, suggested) {
    return current.some((f, i) => f !== suggested[i]);
  }

  // ── 파일 목록 표시 텍스트 ─────────────────────────────────────
  function buildFileListText(label, fileList) {
    const lines = fileList.map((f, i) => {
      const display = f.length > 40 ? f.slice(0, 40) + "…" : f;
      return `  ${i + 1}. ${display}`;
    });
    return `*${label}*\n` + lines.join("\n");
  }

  // ── 파일 순서 확인 DM 블록 ────────────────────────────────────
  function buildFileOrderCheckBlocks(draftId, workName, episode, currentFiles, suggestedFiles, isDiff) {
    const currentText   = buildFileListText("📋 현재 순서 (플랫폼)", currentFiles);
    const suggestedText = buildFileListText("✨ AI 제안 순서", suggestedFiles);
    const diffNote      = isDiff
      ? "⚠️ 순서가 다른 파일이 있어. 아래에서 선택해줘."
      : "✅ 현재 순서와 AI 제안 순서가 동일해. 수정이 필요 없을 수 있어.";

    return [
      { type: "section", text: { type: "mrkdwn", text: `*📁 파일 순서 확인*\n*작품명:* ${workName}　*회차:* ${episode}화` } },
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: currentText } },
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: suggestedText } },
      { type: "section", text: { type: "mrkdwn", text: diffNote } },
      { type: "actions", elements: [
        { type: "button", action_id: "file_order_apply_suggested",
          text: { type: "plain_text", text: "✅ AI 제안대로 반영" },
          style: "primary", value: draftId,
          confirm: { title: { type: "plain_text", text: "반영할까?" },
            text: { type: "mrkdwn", text: "AI 제안 순서로 플랫폼에 반영해." },
            confirm: { type: "plain_text", text: "반영" }, deny: { type: "plain_text", text: "취소" } } },
        { type: "button", action_id: "file_order_manual_input",
          text: { type: "plain_text", text: "✏️ 직접 순서 입력" }, value: draftId },
        { type: "button", action_id: "file_order_close",
          text: { type: "plain_text", text: "❌ 종료 (수정 불필요)" }, value: draftId },
      ]},
    ];
  }

  // ── 파일 목록 조회 & 순서 제안 공통 로직 ──────────────────────
  async function _proceedFileOrderCheck(client, dmChannel, info) {
    const displayWorkName = info.displayWorkName || info.workName;
    const originalWorkTitle = info.originalWorkTitle || null;
    const koreanProjectName = info.koreanProjectName || info.workNameKo || null;
    const {
      episode,
      sourceLink,
      pivoId,
      ownerUserId,
    } = info;

    let fetchResult;
    try {
      fetchResult = await fetchFileListFromPlatform(koreanProjectName || displayWorkName, episode, pivoId);
    } catch (e) {
      console.error('[fileOrder] fetchFileListFromPlatform 오류:', e.message, e.stack);
      await client.chat.postMessage({
        channel: dmChannel,
        text: `⚠️ *${displayWorkName} ${episode}화* 파일 목록 조회 실패\n\`${e.message}\`\n\n터미널 로그를 확인해줘.`,
      });
      return;
    }

    if (!fetchResult) {
      const pendingId = `fo_pending_${Date.now()}`;
      draftStore.set(pendingId, {
        type: "file_order_pending",
        ownerUserId,
        displayWorkName: displayWorkName || "",
        originalWorkTitle,
        koreanProjectName,
        workName:    displayWorkName || "",
        workNameKo:  koreanProjectName,
        episode:     episode || "",
        pageNumbers: info.pageNumbers || [],
        sourceLink:  info.sourceLink || "",
        dmChannelId: dmChannel,
        originalChannelId: info.originalChannelId || null,
        originalTs:        info.originalTs        || null,
        requesterUserId:   info.requesterUserId   || null,
      });
      await client.chat.postMessage({
        channel: dmChannel,
        text: `⚠️ ${displayWorkName} ${episode}화 파일 목록을 가져올 수 없어.`,
        blocks: [
          { type: "section", text: { type: "mrkdwn",
            text: `*📁 원본 파일 순서 문의*\n⚠️ *${displayWorkName} ${episode}화* 파일 목록을 가져올 수 없어.\n작품명이나 화수가 다를 수 있어. 직접 입력해줘.` } },
          { type: "actions", elements: [
            { type: "button", action_id: "open_file_order_info_modal",
              text: { type: "plain_text", text: "정보 직접 입력" },
              style: "primary", value: pendingId },
          ]},
        ],
      });
      return;
    }

    const { files: currentFiles, sourceGroupId, fileMap } = fetchResult;
    const suggestedFiles = suggestCorrectOrder(currentFiles);
    const isDiff         = isDifferentOrder(currentFiles, suggestedFiles);
    const draftId        = generateDraftId();

    draftStore.set(draftId, {
      type: "file_order",
      ownerUserId,
      displayWorkName,
      originalWorkTitle,
      koreanProjectName,
      workName: displayWorkName,
      workNameKo: koreanProjectName,
      pivoId: pivoId || null,
      episode,
      currentFiles, suggestedFiles, sourceGroupId, fileMap,
      dmChannelId: dmChannel, sourceLink,
      originalChannelId:  info.originalChannelId  || null,
      originalTs:         info.originalTs         || null,
      requesterUserId:    info.requesterUserId    || null,
    });

    await client.chat.postMessage({
      channel: dmChannel,
      text:    `${displayWorkName} ${episode}화 파일 순서 확인`,
      blocks:  buildFileOrderCheckBlocks(draftId, displayWorkName, episode, currentFiles, suggestedFiles, isDiff),
    });
  }

  // ── 메인 핸들러 (app.js 분기에서 호출) ───────────────────────
  async function handleFileOrderInquiry(client, dmChannel, analysis, linkInfo, originalText) {
    let parsed;
    try { parsed = await parseFileOrderInquiry(originalText); } catch (e) { parsed = {}; }

    const titleJa = parsed.work_title_ja || analysis.title_ja;
    const titleKo = parsed.work_title_ko || analysis.title_ko;
    let matchedTitle = null;

    if (titleJa || titleKo) {
      const candResult = matchWorkTitleWithCandidates
        ? await matchWorkTitleWithCandidates(titleJa, titleKo).catch(() => null)
        : null;
      if (candResult?.single) {
        matchedTitle = candResult.single;
      } else if (candResult?.multiple) {
        const pendingId = `fo_pending_${Date.now()}`;
        draftStore.set(pendingId, { type: "file_order_pending", ownerUserId: linkInfo?.ownerUserId || null, workName: "", workNameKo: "", episode: parsed.episode || analysis?.episode || "", pageNumbers: parsed.page_numbers || [], sourceLink: linkInfo?.url || "", dmChannelId: dmChannel, originalText });
        await client.chat.postMessage({
          channel: dmChannel,
          text: "작품 후보가 여러 개야. 선택해줘.",
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: `*작품 후보 ${candResult.multiple.length}건* — 해당하는 작품을 선택해줘.` }},
            { type: "actions", elements: candResult.multiple.map((r, i) => ({
              type: "button", action_id: `fileorder_cand_pick_${i}`,
              text: { type: "plain_text", text: r.koreanProjectName || r.japaneseDisplayTitle || `후보 ${i+1}` },
              value: JSON.stringify({ pendingId, pivoId: r.pivoId, koreanProjectName: r.koreanProjectName }),
            }))},
          ],
        });
        return;
      } else if (candResult?.tooMany || !candResult) {
        matchedTitle = await matchWorkTitleFromSheet(titleJa, titleKo).catch(() => null);
      }
    }

    const koreanProjectName = matchedTitle?.koreanProjectName || parsed.work_title_ko || analysis?.koreanProjectName || null;
    const originalWorkTitle = parsed.work_title_ja || analysis?.originalWorkTitle || analysis?.title_ja || null;
    const workNameDisplay = koreanProjectName || originalWorkTitle || analysis?.displayWorkName || null;
    const episode         = parsed.episode || analysis?.episode || null;

    if (!workNameDisplay || !episode) {
      const pendingId = `fo_pending_${Date.now()}`;
      draftStore.set(pendingId, {
        type: "file_order_pending",
        ownerUserId: linkInfo?.ownerUserId || null,
        workName:    workNameDisplay || "",
        displayWorkName: workNameDisplay || "",
        originalWorkTitle,
        koreanProjectName,
        workNameKo:  koreanProjectName,
        episode:     episode        || "",
        pageNumbers: parsed.page_numbers || [],
        sourceLink:  linkInfo?.url || "",
        dmChannelId: dmChannel,
        originalText,
      });

      const missingFields = [];
      if (!workNameDisplay) missingFields.push("작품명");
      if (!episode)         missingFields.push("화수");

      await client.chat.postMessage({
        channel: dmChannel,
        text: `${missingFields.join(", ")}을 특정할 수 없어.`,
        blocks: [
          { type: "section", text: { type: "mrkdwn",
            text: `*📁 원본 파일 순서 문의*\n⚠️ *${missingFields.join(", ")}*을 특정할 수 없어. 직접 입력해줘.` } },
          { type: "actions", elements: [
            { type: "button", action_id: "open_file_order_info_modal",
              text: { type: "plain_text", text: "정보 직접 입력" },
              style: "primary", value: pendingId },
          ]},
        ],
      });
      return;
    }

    await _proceedFileOrderCheck(client, dmChannel, {
      displayWorkName: workNameDisplay,
      originalWorkTitle,
      koreanProjectName,
      workName: workNameDisplay,
      workNameKo: koreanProjectName,
      pivoId: matchedTitle?.pivoId || null,
      episode, pageNumbers: parsed.page_numbers || [], sourceLink: linkInfo?.url || "",
      originalChannelId:  linkInfo?.channelId       || null,
      originalTs:         linkInfo?.ts              || null,
      requesterUserId:    linkInfo?.requesterUserId || null,
      ownerUserId:        linkInfo?.ownerUserId     || null,
    });
  }

  // ── 파일순서봇 후보 작품 선택 버튼 ──────────────────────
  app.action(/^fileorder_cand_pick_\d+$/, async ({ ack, body, client }) => {
    await ack();
    const selection = JSON.parse(body.actions[0].value || "{}");
    const { pendingId, pivoId } = selection;
    const koreanProjectName = readKoreanProjectNameFromSelectionPayload(selection);
    const pending = draftStore.get(pendingId);
    if (!pending) return;
    draftStore.delete(pendingId);
    await _proceedFileOrderCheck(client, pending.dmChannelId, {
      displayWorkName: koreanProjectName,
      originalWorkTitle: pending.originalWorkTitle || null,
      koreanProjectName,
      workName:    koreanProjectName,
      workNameKo:  koreanProjectName,
      pivoId:      pivoId || null,
      episode:     pending.episode,
      pageNumbers: pending.pageNumbers || [],
      sourceLink:  pending.sourceLink || "",
      ownerUserId: pending.ownerUserId || null,
    });
  });

  // ── 작품명·화수 수동 입력 모달 ────────────────────────────────
  app.action("open_file_order_info_modal", async ({ ack, body, client }) => {
    await ack();
    const pending = draftStore.get(body.actions[0].value);
    if (!pending) return;

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal", callback_id: "submit_file_order_info_modal",
        private_metadata: JSON.stringify({ pendingId: body.actions[0].value }),
        title:  { type: "plain_text", text: "작품 정보 입력" },
        submit: { type: "plain_text", text: "파일 순서 확인" },
        close:  { type: "plain_text", text: "취소" },
        blocks: [
          { type: "section", text: { type: "mrkdwn",
            text: `AI 추출값 — 작품명: \`${pending.workName || "없음"}\`　화수: \`${pending.episode || "없음"}\`` } },
          { type: "input", block_id: "fo_work_block",
            label: { type: "plain_text", text: "작품명 (원문)" },
            element: { type: "plain_text_input", action_id: "value",
              initial_value: pending.workName || "",
              placeholder: { type: "plain_text", text: "예: 祭品新娘拐恶龙 / ゾンビさん" } } },
          { type: "input", block_id: "fo_episode_block",
            label: { type: "plain_text", text: "화수 (숫자만)" },
            element: { type: "plain_text_input", action_id: "value",
              initial_value: pending.episode || "",
              placeholder: { type: "plain_text", text: "예: 204" } } },
        ],
      },
    });
  });

  app.view("submit_file_order_info_modal", async ({ ack, body, view, client }) => {
    await ack();
    const { pendingId } = JSON.parse(view.private_metadata || "{}");
    const pending = draftStore.get(pendingId);
    if (!pending) return;

    const v        = view.state.values;
    const workName = v.fo_work_block?.value?.value?.trim() || "";
    const episode  = v.fo_episode_block?.value?.value?.trim() || "";

    if (!workName || !episode) {
      await client.chat.postMessage({ channel: pending.dmChannelId, text: "작품명과 화수를 모두 입력해줘." });
      return;
    }

    const candResult2     = matchWorkTitleWithCandidates ? await matchWorkTitleWithCandidates(workName, workName).catch(() => null) : null;
    const matchedTitle       = candResult2?.single || (!candResult2?.multiple && !candResult2?.tooMany ? await matchWorkTitleFromSheet(workName, workName).catch(() => null) : null);
    const koreanProjectName = matchedTitle?.koreanProjectName || null;
    const displayWorkName = koreanProjectName || workName;
    const originalWorkTitle = workName;
    draftStore.delete(pendingId);

    // 정상 경로(후보 선택)와 동일하게 실제 파일 목록을 조회한다.
    // (과거: currentFiles:[] placeholder → 수동입력 시 total=0 으로 항상 invalid 되는 버그)
    await _proceedFileOrderCheck(client, pending.dmChannelId, {
      displayWorkName,
      originalWorkTitle,
      koreanProjectName,
      workName: displayWorkName,
      workNameKo: koreanProjectName,
      pivoId:     matchedTitle?.pivoId || null,
      episode,
      sourceLink: pending.sourceLink || '',
      ownerUserId: pending.ownerUserId || null,
    });
  });

  // ── AI 제안대로 반영 ──────────────────────────────────────────
  app.action("file_order_apply_suggested", async ({ ack, body, client }) => {
    await ack();
    const draftId = body.actions[0].value;
    let data = draftStore.get(draftId);
    if (!data) return;

    const updateSuccessUi = async currentData => {
      await client.chat.update({
        channel: body.channel.id, ts: body.message.ts,
        text: `✅ *${currentData.workName} ${currentData.episode}화* 파일 순서 수정 반영 완료`,
        blocks: [
          { type: "section", text: { type: "mrkdwn",
            text: `✅ *${currentData.workName} ${currentData.episode}화* 파일 순서 수정 반영 완료` } },
          { type: "context", elements: [
            { type: "mrkdwn", text: `처리자: <@${body.user.id}> · ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}` },
          ]},
          { type: "actions", elements: [
            { type: "button", action_id: "fo_open_notify_modal",
              text: { type: "plain_text", text: "📢 작업자 안내 메시지" },
              style: "primary", value: draftId },
          ]},
        ],
      });
      const latest = draftStore.get(draftId) || currentData;
      draftStore.set(draftId, {
        ...latest,
        fileOrderMutation: {
          ...latest.fileOrderMutation,
          uiPending: false,
          uiUpdatedAt: new Date().toISOString(),
        },
      });
    };

    // fileOrderMutation 상태를 draftStore 레코드 필드에 저장하는 mutation-checkpoint stateStore 어댑터.
    const mutationStore = {
      get: key => draftStore.get(key)?.fileOrderMutation,
      set: (key, value) => {
        data = { ...data, fileOrderMutation: value };
        draftStore.set(key, data);
        return value;
      },
    };

    const savedMutation = readState(mutationStore, draftId);
    const entryGate = checkEntryGate({
      savedState: savedMutation,
      isTerminal: state => state.status === "completed" || state.status === "review_required",
      isInProgress: state => !!state.inProgress,
      buildReplayResult: state => ({
        reviewRequired: state.status === "review_required",
        completed: state.status === "completed",
        uiPending: !!state.uiPending,
      }),
      buildInProgressResult: () => null,
    });
    if (entryGate.done) {
      if (entryGate.result?.reviewRequired) {
        await client.chat.postMessage({
          channel: body.user.id,
          text: "⚠️ 파일 순서 반영 결과가 불명확해 운영자 확인이 필요해. 같은 반영 버튼을 다시 누르지 말아줘.",
        });
      } else if (entryGate.result?.completed && entryGate.result.uiPending) {
        await updateSuccessUi(data).catch(() => {});
      }
      return;
    }

    // 첫 await 전에 전체 mutation을 선점한다.
    const mutation = reserveInProgress({
      stateStore: mutationStore,
      stateKey: draftId,
      state: {
        status: savedMutation?.status || "ready",
        stage: savedMutation?.stage || "reorder",
        uiPending: savedMutation?.uiPending || false,
        startedAt: savedMutation?.startedAt || new Date().toISOString(),
      },
    });

    const stages = [
      {
        isDone: s => s.status === "reorder_confirmed",
        beforeExecute: () => ({ stage: "reorder" }),
        execute: () => applyFileReorderStage(data.suggestedFiles, data.fileMap),
        confirm: () => ({
          status: "reorder_confirmed",
          stage: "complete",
          reorderConfirmedAt: new Date().toISOString(),
        }),
        onOutcomeUnknown: (s, error) => ({
          status: error.mutationOutcome === "not_applied" ? "ready" : "review_required",
          stage: "reorder",
          inProgress: false,
          error: error.message,
        }),
        buildError: error => {
          const retrySafe = error.mutationOutcome === "not_applied";
          const wrapped = new Error(error.message);
          wrapped.fileOrderWarningText = retrySafe
            ? `⚠️ 파일 순서 변경이 명시적으로 실패했어. 같은 버튼으로 다시 시도할 수 있어. (${error.message})`
            : `⚠️ 파일 순서 변경 결과를 확정할 수 없어. 운영자가 확인하고 다시 누르지 말아줘. (${error.message})`;
          return wrapped;
        },
      },
      {
        isDone: () => false,
        execute: () => completeSourceGroupStage(data.sourceGroupId),
        confirm: () => ({
          status: "completed",
          stage: "completed",
          inProgress: false,
          uiPending: true,
          completedAt: new Date().toISOString(),
          error: null,
        }),
        onOutcomeUnknown: (s, error) => ({
          status: error.mutationOutcome === "not_applied" ? "reorder_confirmed" : "review_required",
          stage: "complete",
          inProgress: false,
          error: error.message,
        }),
        buildError: error => {
          const retrySafe = error.mutationOutcome === "not_applied";
          const wrapped = new Error(error.message);
          wrapped.fileOrderWarningText = retrySafe
            ? `⚠️ 순서 변경은 확인됐고 source group 확정만 명시적으로 실패했어. 같은 버튼은 확정 단계만 다시 시도해. (${error.message})`
            : `⚠️ 순서 변경 뒤 source group 확정 결과가 불명확해. 운영자가 확인하고 다시 누르지 말아줘. (${error.message})`;
          return wrapped;
        },
      },
    ];

    try {
      await runCheckpointStages({
        state: mutation,
        stages,
        stateStore: mutationStore,
        stateKey: draftId,
      });
    } catch (error) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: error.fileOrderWarningText,
      }).catch(() => {});
      return;
    }

    await updateSuccessUi(data).catch(error => {
      const latest = draftStore.get(draftId) || data;
      draftStore.set(draftId, {
        ...latest,
        fileOrderMutation: {
          ...latest.fileOrderMutation,
          uiPending: true,
          uiError: error.message,
        },
      });
    });
  });

  // ── 직접 순서 입력 모달 ──────────────────────────────────────
  app.action("file_order_manual_input", async ({ ack, body, client }) => {
    await ack();
    const data = draftStore.get(body.actions[0].value);
    if (!data) return;

    const fileListGuide = data.currentFiles
      .map((f, i) => `${i + 1}. ${f.length > 45 ? f.slice(0, 45) + "…" : f}`)
      .join("\n");

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal", callback_id: "submit_file_order_manual_modal",
        private_metadata: JSON.stringify({ draftId: body.actions[0].value }),
        title:  { type: "plain_text", text: "파일 순서 직접 입력" },
        submit: { type: "plain_text", text: "이 순서로 반영" },
        close:  { type: "plain_text", text: "취소" },
        blocks: [
          { type: "section", text: { type: "mrkdwn",
            text: `*현재 파일 목록 (번호 기준)*\n\`\`\`${fileListGuide}\`\`\`` } },
          { type: "section", text: { type: "mrkdwn",
            text: "올바른 순서를 번호로 입력해줘. (스페이스로 구분)\n예: 3·4번이 뒤바뀌었으면 → `1 2 4 3 5 6`" } },
          { type: "input", block_id: "fo_order_block",
            label: { type: "plain_text", text: "올바른 순서" },
            element: { type: "plain_text_input", action_id: "value",
              placeholder: { type: "plain_text", text: "예: 1 2 4 3 5 6" } } },
        ],
      },
    });
  });

  app.view("submit_file_order_manual_modal", async ({ ack, body, view, client }) => {
    await ack();
    const { draftId } = JSON.parse(view.private_metadata || "{}");
    const data = draftStore.get(draftId);
    if (!data) return;

    const input   = view.state.values.fo_order_block?.value?.value?.trim() || "";
    const indices = input.split(/\s+/).map(n => parseInt(n, 10));
    const total   = data.currentFiles.length;

    const isValid =
      indices.length === total &&
      indices.every(n => !isNaN(n) && n >= 1 && n <= total) &&
      new Set(indices).size === total;

    if (!isValid) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: `⚠️ 입력값이 올바르지 않아. 1~${total} 숫자를 중복 없이 ${total}개 입력해줘.\n예: \`1 2 4 3 5 6\``,
        blocks: [
          { type: "section", text: { type: "mrkdwn",
            text: `⚠️ 입력값이 올바르지 않아. 1~${total} 숫자를 중복 없이 ${total}개 입력해줘.\n예: \`1 2 4 3 5 6\`` } },
          { type: "actions", elements: [
            { type: "button", action_id: "file_order_manual_input",
              text: { type: "plain_text", text: "🔄 다시 입력" },
              style: "primary", value: draftId },
          ]},
        ],
      });
      return;
    }

    const reorderedFiles = indices.map(n => data.currentFiles[n - 1]);
    const previewText    = reorderedFiles.map((f, i) => `${i + 1}. ${f.length > 45 ? f.slice(0, 45) + "…" : f}`).join("\n");
    const confirmDraftId = generateDraftId();
    draftStore.set(confirmDraftId, { ...data, suggestedFiles: reorderedFiles });

    await client.chat.postMessage({
      channel: body.user.id,
      text: "입력한 순서 확인",
      blocks: [
        { type: "section", text: { type: "mrkdwn",
          text: `*입력한 순서로 재구성한 결과*\n\`\`\`${previewText}\`\`\`` } },
        { type: "section", text: { type: "mrkdwn", text: "이 순서로 플랫폼에 반영할까?" } },
        { type: "actions", elements: [
          { type: "button", action_id: "file_order_apply_suggested",
            text: { type: "plain_text", text: "✅ 이 순서로 반영" },
            style: "primary", value: confirmDraftId,
            confirm: { title: { type: "plain_text", text: "반영할까?" },
              text: { type: "mrkdwn", text: "입력한 순서로 플랫폼에 반영해." },
              confirm: { type: "plain_text", text: "반영" }, deny: { type: "plain_text", text: "취소" } } },
          { type: "button", action_id: "file_order_manual_input",
            text: { type: "plain_text", text: "🔄 다시 입력" }, value: draftId },
          { type: "button", action_id: "file_order_close",
            text: { type: "plain_text", text: "❌ 취소" }, value: confirmDraftId },
        ]},
      ],
    });
  });


  // ── 작업자 안내 메시지 모달 ──────────────────────────────────
  app.action("fo_open_notify_modal", async ({ ack, body, client }) => {
    await ack();
    const data = draftStore.get(body.actions[0].value);
    if (!data) return;

    const defaultMsg = `${data.workName} ${data.episode}화 순서 변경이 완료되었습니다.`;

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal", callback_id: "fo_notify_submit",
        private_metadata: JSON.stringify({ draftId: body.actions[0].value }),
        title:  { type: "plain_text", text: "작업자 안내 메시지" },
        submit: { type: "plain_text", text: "전송" },
        close:  { type: "plain_text", text: "취소" },
        blocks: [
          { type: "section", text: { type: "mrkdwn",
            text: `*${data.workName} ${data.episode}화* — 원문 스레드에 댓글로 전송됩니다.` } },
          { type: "input", block_id: "fo_notify_msg_block",
            label: { type: "plain_text", text: "메시지 (빈칸이면 기본 템플릿 사용)" },
            optional: true,
            element: { type: "plain_text_input", action_id: "value", multiline: true,
              placeholder: { type: "plain_text", text: `${data.workName} ${data.episode}화 순서 변경이 완료되었습니다.` } } },
          { type: "input", block_id: "fo_notify_lang_block",
            label: { type: "plain_text", text: "번역 언어 (선택 안 하면 입력 언어 그대로 전송)" },
            optional: true,
            element: {
              type: "static_select", action_id: "value",
              placeholder: { type: "plain_text", text: "번역 안 함" },
              options: [
                { text: { type: "plain_text", text: "🇺🇸 영어" },  value: "en" },
                { text: { type: "plain_text", text: "🇯🇵 일본어" }, value: "ja" },
                { text: { type: "plain_text", text: "🇨🇳 중국어" }, value: "zh" },
              ],
            },
          },
        ],
      },
    });
  });

  // ── 작업자 안내 메시지 전송 ──────────────────────────────────
  app.view("fo_notify_submit", async ({ ack, body, view, client }) => {
    await ack();
    const { draftId } = JSON.parse(view.private_metadata || "{}");
    const data = draftStore.get(draftId);
    if (!data) return;

    const inputMsg   = view.state.values.fo_notify_msg_block?.value?.value?.trim() || "";
    const rawMsg     = inputMsg || `${data.workName} ${data.episode}화 순서 변경이 완료되었습니다.`;
    const targetLang = view.state.values.fo_notify_lang_block?.value?.selected_option?.value || null;
    const msgToSend  = targetLang ? await _foTranslate(rawMsg, targetLang, data.workName) : rawMsg;
    const mention    = data.requesterUserId ? `<@${data.requesterUserId}> ` : "";
    const finalMsg   = mention + msgToSend;

    const originalChannelId = data.originalChannelId;
    const originalTs        = data.originalTs;

    if (!originalChannelId || !originalTs) {
      await client.chat.postMessage({ channel: body.user.id,
        text: `⚠️ 원문 스레드 정보가 없어. 직접 전달해줘.

메시지:
${finalMsg}` });
      return;
    }

    try {
      await client.conversations.join({ channel: originalChannelId }).catch(() => {});
      await client.chat.postMessage({
        channel:   originalChannelId,
        thread_ts: originalTs,
        text:      finalMsg,
      });
      const langLabel = { en: "영어", ja: "일본어", zh: "중국어" }[targetLang] || "원문 그대로";
      await client.chat.postMessage({ channel: body.user.id,
        text: `✅ 원문 스레드에 댓글 전송 완료 (${langLabel})

${msgToSend}` });
    } catch (e) {
      await client.chat.postMessage({ channel: body.user.id,
        text: `⚠️ 전송 실패: ${e.message}

메시지:
${msgToSend}` });
    }
  });

  // ── 종료 ─────────────────────────────────────────────────────
  app.action("file_order_close", async ({ ack, body, client }) => {
    await ack();
    const data    = draftStore.get(body.actions[0].value);
    const workInfo = data ? `${data.workName} ${data.episode}화` : "";
    await client.chat.update({
      channel: body.channel.id, ts: body.message.ts,
      text: `❌ 파일 순서 수정 종료${workInfo ? ` — ${workInfo}` : ""}`,
      blocks: [
        { type: "section", text: { type: "mrkdwn",
          text: `❌ *파일 순서 수정 종료*${workInfo ? `\n${workInfo}` : ""}\n수정이 필요 없는 것으로 처리했어.` } },
        { type: "context", elements: [
          { type: "mrkdwn", text: `처리자: <@${body.user.id}> · ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}` },
        ]},
      ],
    });
  });

  // 외부에서 호출할 수 있도록 핸들러 반환
  return { handleFileOrderInquiry };
};
