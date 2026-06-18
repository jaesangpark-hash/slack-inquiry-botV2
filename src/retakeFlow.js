// ══════════════════════════════════════════════════════════════════
// retakeFlow.js — 수정·리테이크 플로우 (IB-04)
// app.js 에서 require("./retakeFlow")(app, { ai, GEMINI_MODEL, matchWorkTitleFromSheet, generateDraftId, draftStore }) 로 호출
// ══════════════════════════════════════════════════════════════════

module.exports = function registerRetakeFlow(app, { ai, GEMINI_MODEL, matchWorkTitleFromSheet, matchWorkTitleByTokens, matchWorkTitleWithCandidates, generateDraftId, draftStore, sheetsClient, fetchDeliveryDate, resolveApmUserId }) {

  const BASE  = () => process.env.PLATFORM_API_URL;
  const TOKEN = () => process.env.PLATFORM_API_TOKEN;
  const { loggedCall } = require("./apiLogger");

  // fetch + loggedCall 통합 래퍼
  async function _apiFetch(url, options = {}, meta = {}) {
    let returnedCount = null;
    const result = await loggedCall(async () => {
      const res  = await fetch(url, options);
      const json = await res.json();
      if (Array.isArray(json.data))       returnedCount = json.data.length;
      else if (json.data != null)         returnedCount = 1;
      return json;
    }, { ...meta, returnedCount });
    return result;
  }

  const WORKER_SHEET_ID    = process.env.WORKER_SHEET_ID;
  const WORKER_SHEET_RANGE = process.env.WORKER_SHEET_RANGE;
  const workerSheetCache   = { loadedAt: 0, rows: [] };

  // ── 작업자 시트 조회: 이메일 → 채널 ID (5분 캐시) ────────
  async function _getWorkerChannelId(email) {
    try {
      // 5분 캐시
      if (Date.now() - workerSheetCache.loadedAt > 300000 || !workerSheetCache.rows.length) {
        const res    = await sheetsClient.getValues(WORKER_SHEET_ID, WORKER_SHEET_RANGE);
        workerSheetCache.rows     = (res || []).slice(1);
        workerSheetCache.loadedAt = Date.now();
        console.log(`[retake] 작업자 시트 캐시 갱신 — ${workerSheetCache.rows.length}건`);
      }
      const rows  = workerSheetCache.rows;
      console.log(`[retake] 작업자 시트 rows:${rows.length} / 찾는 이메일: ${email}`);
      const found = rows.find(row => (row[1] || "").trim().toLowerCase() === email.toLowerCase());
      console.log(`[retake] 매칭된 행 raw:`, JSON.stringify(found));
      console.log(`[retake] 작업자 채널 ID: ${found?.[3] || "없음"} / Slack IDs: ${found?.[2] || "없음"}`);
      return found ? { channelId: found[3]?.trim() || null, slackIds: found[2]?.trim() || null } : null;
    } catch (e) {
      console.error("[retake] 작업자 시트 조회 실패:", e.message);
      return null;
    }
  }

  // ── 리테이크 가능 오퍼레이션 고정 목록 ───────────────────
  const RETAKE_OPERATIONS = [
    { code: "OTC0012", name: "번역" },
    { code: "OTC0013", name: "번역검수" },
    { code: "OTC0014", name: "식자" },
    { code: "OTC0024", name: "식자번역검수" },
    { code: "OTC0015", name: "식자검수" },
    { code: "OTC0087", name: "납품검수" },
  ];

  // ── AI 파싱: 작품명 / 회차 추출 ──────────────────────────
  async function parseRetakeInquiry(text) {
    const prompt = `
아래 문의에서 정보를 추출해줘.
괄호(「」『』<>《》【】 등)가 있으면 제거하고 작품명만 반환해.

1) work_title_ja : 일본어 또는 중국어 작품명 (없으면 null)
2) work_title_ko : 한국어 작품명 (없으면 null)
3) episode       : 회차 숫자만 (예: "204話" → "204", "60화" → "60", 없으면 null)

JSON만 출력. 코드블록 금지.
문의: ${text}`.trim();

    const res = await ai.models.generateContent({ model: GEMINI_MODEL, contents: prompt });
    return JSON.parse((res.text || "").replace(/```json|```/g, "").trim());
  }

  // ── Totus API: 작품명으로 projectUuid 조회 ───────────────
  async function _getProjectUuid(workName, pivoId = null) {
    const query = pivoId
      ? `pivoId=${encodeURIComponent(pivoId)}`
      : `name=${encodeURIComponent(workName)}`;
    console.log(`[Totus] 프로젝트 조회 → ${query}`);
    const json = await _apiFetch(`${BASE()}/api/v1/projects?${query}`, {
      headers: { Authorization: `Bearer ${TOKEN()}` },
    }, { bot: "retake", endpoint: "/projects", params: { query }, expectedCount: 1 });
    console.log(`[Totus] 응답 success:${json.success} count:${(json.data||[]).length}`, (json.data||[]).map(p => `${p.uuid}/${p.name}`));
    if (!json.success) throw new Error(json.error?.message || "프로젝트 검색 실패");
    const projects = (json.data || []).filter(p => {
      const detail = p._detail || p;
      return detail.진행상태 !== "CANCELED" && detail.pivoId != null;
    });
    console.log(`[Totus] 필터 후 count:${projects.length}`, projects.map(p => `${p.uuid}/${(p._detail||p).진행상태}/${(p._detail||p).pivoId}`));
    if (!projects.length) return null;
    return projects[0].uuid;
  }

  // ── Totus API: delivery-target-task로 회차 단건 조회 ────
  // GET /api/v1/projects/{uuid}/delivery-target-task?episode={n}
  // 반환: { jobUuid, jobName, jobIndex, tasks: [{ taskUuid, operationUuid, operationTypeCode, operationTypeName, state, stateName }] }
  async function _getDeliveryTargetTask(projectUuid, episode) {
    const epNum = parseInt(episode, 10);
    const json = await _apiFetch(
      `${BASE()}/api/v1/projects/${projectUuid}/delivery-target-task?episode=${epNum}`,
      { headers: { Authorization: `Bearer ${TOKEN()}` } },
      { bot: "retake", endpoint: "/projects/{uuid}/delivery-target-task", params: { episode: epNum }, expectedCount: 1 }
    );
    console.log(`[retake] delivery-target-task 응답 success:${json.success} episode:${epNum}`);
    if (!json.success) {
      // 404 = 에피소드 없음 → null 반환 (에러 throw 없이)
      console.warn(`[retake] delivery-target-task 실패: ${json.error?.message}`);
      return null;
    }
    return json.data || null;
  }

  // ── 메인 핸들러: 수정&리테이크 문의 처리 ────────────────
  async function handleRetakeInquiry(client, dmChannel, analysis, linkInfo, originalText, requesterName = "", requesterUserId = null) {
    let parsed;
    try { parsed = await parseRetakeInquiry(originalText); } catch (e) { parsed = {}; }

    const titleJa = parsed.work_title_ja || analysis.title_ja;
    const titleKo = parsed.work_title_ko || analysis.title_ko;

    let matchedTitle = null;

    // 후보 감지 매칭 (부분일치 복수 체크 포함)
    if (matchWorkTitleWithCandidates && (titleJa || titleKo)) {
      const candResult = await matchWorkTitleWithCandidates(titleJa, titleKo).catch(() => null);
      if (candResult?.single) {
        matchedTitle = candResult.single;
      } else if (candResult?.multiple) {
        const pendingId = `rt_pending_${Date.now()}`;
        draftStore.set(pendingId, { type: "retake_pending", workName: "", workNameKo: "", episode: parsed.episode || "", sourceLink: linkInfo?.url || "", dmChannelId: dmChannel, originalText, requesterName, requesterUserId });
        await client.chat.postMessage({
          channel: dmChannel,
          text: "작품 후보가 여러 개야. 선택해줘.",
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: `*작품 후보 ${candResult.multiple.length}건* — 해당하는 작품을 선택해줘.` }},
            { type: "actions", elements: candResult.multiple.map((r, i) => ({
              type: "button", action_id: `retake_token_pick_${i}`,
              text: { type: "plain_text", text: r.projectName || r.jaDisplay || `후보 ${i+1}` },
              value: JSON.stringify({ pendingId, pivoId: r.pivoId, projectName: r.projectName }),
            }))},
          ],
        });
        return;
      } else if (candResult?.tooMany) {
        // 후보 너무 많음 → 토큰 매칭 시도
        if (matchWorkTitleByTokens) {
          const tokenResult = await matchWorkTitleByTokens(titleKo, titleJa).catch(() => null);
          if (tokenResult?.single) {
            matchedTitle = tokenResult.single;
          } else if (tokenResult?.multiple) {
            const pendingId = `rt_pending_${Date.now()}`;
            draftStore.set(pendingId, { type: "retake_pending", workName: "", workNameKo: "", episode: parsed.episode || "", sourceLink: linkInfo?.url || "", dmChannelId: dmChannel, originalText, requesterName, requesterUserId });
            await client.chat.postMessage({
              channel: dmChannel,
              text: "작품 후보가 여러 개야. 선택해줘.",
              blocks: [
                { type: "section", text: { type: "mrkdwn", text: `*작품 후보 ${tokenResult.multiple.length}건* — 해당하는 작품을 선택해줘.` }},
                { type: "actions", elements: tokenResult.multiple.slice(0, 5).map((r, i) => ({
                  type: "button", action_id: `retake_token_pick_${i}`,
                  text: { type: "plain_text", text: r.projectName || r.jaDisplay || `후보 ${i+1}` },
                  value: JSON.stringify({ pendingId, pivoId: r.pivoId, projectName: r.projectName }),
                }))},
              ],
            });
            return;
          }
        }
      }
    }

    const workNameDisplay = matchedTitle?.projectName || parsed.work_title_ko || parsed.work_title_ja || null;
    const workNameKo      = matchedTitle?.projectName || parsed.work_title_ko || null;
    // parsed.episode 우선, 없으면 analysis에서 넘어온 값 사용 (복수 문의 경로에서 항목별 화수 보존)
    const episode         = parsed.episode || analysis?.episode || null;

    // 작품명 매칭 실패(pivoId 없음) 또는 화수 미확보 → 수동 입력 유도
    if (!matchedTitle || !workNameDisplay || !episode) {
      const pendingId = `rt_pending_${Date.now()}`;
      draftStore.set(pendingId, {
        type: "retake_pending",
        workName:    workNameDisplay || "",
        workNameKo:  workNameKo     || "",
        episode:     episode        || "",
        sourceLink:  linkInfo?.url  || "",
        dmChannelId: dmChannel,
        originalText,
        requesterName,
        requesterUserId: requesterUserId || null,
      });

      const missingFields = [];
      if (!matchedTitle) missingFields.push("작품명 (시트 매칭 실패)");
      else if (!workNameDisplay) missingFields.push("작품명");
      if (!episode) missingFields.push("화수");

      const linkText = linkInfo?.url ? `\n・ 🔗 <${linkInfo.url}|원본 링크>` : "";
      await client.chat.postMessage({
        channel: dmChannel,
        text: `${missingFields.join(", ")}을 특정할 수 없어.`,
        blocks: [
          { type: "section", text: { type: "mrkdwn",
            text: `*🔄 태스크 재생성 요청*${linkText}\n⚠️ *${missingFields.join(", ")}*을 특정할 수 없어. 직접 입력해줘.` } },
          { type: "actions", elements: [
            { type: "button", action_id: "open_retake_info_modal",
              text: { type: "plain_text", text: "정보 직접 입력" },
              style: "primary", value: pendingId },
          ]},
        ],
      });
      return;
    }

    await _proceedRetakeOperationSelect(client, dmChannel, {
      workName: workNameDisplay,
      workNameKo: workNameKo || workNameDisplay,
      pivoId: matchedTitle?.pivoId || null,
      episode,
      sourceLink: linkInfo?.url || "",
      requesterName,
      requesterUserId: requesterUserId || null,
    });
  }

  // ── 토큰 매칭 후보 선택 버튼 ────────────────────────────
  app.action(/^retake_token_pick_\d+$/, async ({ ack, body, client }) => {
    await ack();
    const { pendingId, pivoId, projectName } = JSON.parse(body.actions[0].value || "{}");
    const pending = draftStore.get(pendingId);
    if (!pending) return;

    draftStore.delete(pendingId);
    await _proceedRetakeOperationSelect(client, pending.dmChannelId, {
      workName:        projectName,
      workNameKo:      projectName,
      pivoId:          pivoId || null,
      episode:         pending.episode,
      sourceLink:      pending.sourceLink || "",
      requesterName:   pending.requesterName   || "",
      requesterUserId: pending.requesterUserId || null,
    });
  });

  // ── 오퍼레이션 선택 DM 표시 ──────────────────────────────
  async function _proceedRetakeOperationSelect(client, dmChannel, info) {
    const { workName, workNameKo, pivoId, episode, sourceLink, requesterName, requesterUserId } = info;
    const draftId = generateDraftId();

    // 납품 시트 D열에서 실제 담당 APM 조회 (zh-ja 탭 → 미매칭 시 ko-ja 탭)
    let actualApm   = null;
    let actualApmId = null;
    if (fetchDeliveryDate && episode) {
      try {
        const dlv = await fetchDeliveryDate(workNameKo || workName, episode);
        actualApm = (dlv?.apm || "").normalize("NFC").trim() || null;
        if (!actualApm) {
          const dlvKo = await fetchDeliveryDate(workNameKo || workName, episode, "ko-ja");
          actualApm = (dlvKo?.apm || "").normalize("NFC").trim() || null;
        }
      } catch (_) {}
    }
    if (actualApm) {
      if (typeof resolveApmUserId === "function") {
        actualApmId = resolveApmUserId(actualApm) || null;
        console.log(`[retake] APM 이름→ID 변환: "${actualApm}" → ${actualApmId || "매핑 없음"}`);
      } else {
        console.warn("[retake] resolveApmUserId 미주입 — APM ID 변환 불가");
      }
    }
    console.log(`[retake] _proceedRetakeOperationSelect — requesterUserId: ${requesterUserId || "없음"}, actualApm: "${actualApm || ""}", actualApmId: ${actualApmId || "없음"}`);

    draftStore.set(draftId, {
      type: "retake",
      workName, workNameKo, pivoId: pivoId || null, episode, sourceLink,
      requesterName:   requesterName   || "",
      requesterUserId: requesterUserId || null,
      actualApm:       actualApm       || "",
      actualApmId:     actualApmId     || null,
      dmChannelId: dmChannel,
    });

    const linkText    = sourceLink   ? `\n*원본 링크:* ${sourceLink}` : "";
    const senderText  = requesterName ? `\n*발송자:* ${requesterName}` : "";
    const apmDisplay  = actualApmId ? `<@${actualApmId}>` : actualApm;
    const apmText     = apmDisplay   ? `\n*담당 APM:* ${apmDisplay}`  : "";

    await client.chat.postMessage({
      channel: dmChannel,
      text: `${workName} ${episode}화 태스크 재생성 — 작업 유형을 선택해주세요.`,
      blocks: [
        { type: "section", text: { type: "mrkdwn",
          text: `*🔄 태스크 재생성 요청*${senderText}${apmText}\n*작품명:* ${workName}　*회차:* ${episode}화${linkText}\n\n내용을 확인하고 작업 유형을 선택해줘.` } },
        { type: "actions", elements: [
          { type: "button", action_id: "retake_select_operation",
            text: { type: "plain_text", text: "작업 유형 선택" },
            style: "primary", value: draftId },
          { type: "button", action_id: "retake_close",
            text: { type: "plain_text", text: "❌ 종료" },
            value: draftId },
        ]},
      ],
    });
  }

  // ── [작업 유형 선택] 버튼 → jobs 조회 후 실제 오퍼레이션만 드롭다운 ───
  app.action("retake_select_operation", async ({ ack, body, client }) => {
    await ack();
    const draftId = body.actions[0].value;
    const data = draftStore.get(draftId);
    if (!data) return;

    try {
      // jobs API 미리 조회 → 실제 오퍼레이션 목록 추출
      const projectUuid = await _getProjectUuid(data.workNameKo || data.workName, data.pivoId);
      if (!projectUuid) {
        await client.chat.postMessage({ channel: data.dmChannelId,
          text: `❌ 작품 "${data.workName}"을 Totus에서 찾을 수 없어.` });
        return;
      }

      // delivery-target-task API로 단건 조회 (전체 jobs 조회 불필요)
      const jobData = await _getDeliveryTargetTask(projectUuid, data.episode);
      if (!jobData) {
        await client.chat.postMessage({ channel: data.dmChannelId,
          text: `❌ ${data.episode}화 JOB을 찾을 수 없어.` });
        return;
      }

      // RETAKE 가능 오퍼레이션 코드 set
      const retakeCodes = new Set(RETAKE_OPERATIONS.map(o => o.code));

      // tasks 배열에서 리테이크 가능 + 작업자 배정된 오퍼레이션만 추출
      // delivery-target-task 응답에 작업자 필드가 포함되어 /tasks/{uuid} 개별 호출 불필요
      const seenCodes = new Set();
      const availableOps = (jobData.tasks || [])
        .filter(t =>
          retakeCodes.has(t.operationTypeCode) &&
          !seenCodes.has(t.operationTypeCode) && seenCodes.add(t.operationTypeCode) &&
          t.작업자 != null  // 작업자 미배정 태스크 제외
        )
        .map(t => ({
          code:      t.operationTypeCode,
          name:      RETAKE_OPERATIONS.find(o => o.code === t.operationTypeCode)?.name || t.operationTypeName || t.operationTypeCode,
          opUuid:    t.operationUuid,
          taskUuid:  t.taskUuid,
          hasWorker: true,
        }));

      console.log(`[retake] availableOps (작업자 배정):`, JSON.stringify(availableOps));

      if (!availableOps.length) {
        await client.chat.postMessage({ channel: data.dmChannelId,
          text: `❌ ${data.episode}화에 재생성 가능한 오퍼레이션이 없어.` });
        return;
      }

      // projectUuid, jobData, availableOps 저장
      draftStore.set(draftId, { ...data, projectUuid, jobData, availableOps });

      // 조회 중 메시지 전송 후 인라인 버튼으로 오퍼레이션 선택 표시
      // action_id는 버튼마다 고유하게 (Slack 중복 금지)
      await client.chat.postMessage({
        channel: data.dmChannelId,
        text: `${data.workName} ${data.episode}화 — 재생성할 작업 유형을 선택해줘.`,
        blocks: [
          { type: "section", text: { type: "mrkdwn",
            text: `*${data.workName} ${data.episode}화*
재생성할 작업 유형을 선택해줘.` } },
          { type: "actions", elements: availableOps.map((op, i) => ({
            type: "button",
            action_id: `retake_pick_operation_${i}`,
            text: { type: "plain_text", text: op.name },
            value: JSON.stringify({ draftId, operationCode: op.code, operationName: op.name, operationUuid: op.opUuid, sourceTaskUuid: op.taskUuid }),
          }))},
        ],
      });
    } catch (e) {
      console.error("[retake] 오퍼레이션 조회 오류:", e.message);
      await client.chat.postMessage({ channel: data.dmChannelId,
        text: `❌ 오류 발생: ${e.message}` });
    }
  });

  // ── 작업 유형 인라인 버튼 선택 ──────────────────────────
  app.action(/^retake_pick_operation_\d+$/, async ({ ack, body, client }) => {
    await ack();
    const { draftId, operationCode, operationName, operationUuid, sourceTaskUuid } =
      JSON.parse(body.actions[0].value || "{}");
    const data = draftStore.get(draftId);
    if (!data) return;

    draftStore.set(draftId, {
      ...data, operationCode, operationName,
      operationUuid, sourceTaskUuid,
    });

    console.log(`[retake] 오퍼레이션 선택: ${operationName} (${operationCode}) / taskUuid: ${sourceTaskUuid}`);
    await _showRetakeDateModal(client, data.dmChannelId, draftId, body.user.id);
  });

  // ── 태스크 선택 버튼 ─────────────────────────────────────
  app.action(/^retake_select_task_\d+$/, async ({ ack, body, client }) => {
    await ack();
    const { draftId, taskUuid } = JSON.parse(body.actions[0].value || "{}");
    const data = draftStore.get(draftId);
    if (!data) return;

    draftStore.set(draftId, { ...data, sourceTaskUuid: taskUuid });
    await _showRetakeDateModal(client, data.dmChannelId, draftId, body.user.id);
  });

  // ── 일정 입력 모달 표시 ───────────────────────────────────
  async function _showRetakeDateModal(client, dmChannel, draftId, userId) {
    const data = draftStore.get(draftId);

    // 오늘 날짜를 시작일 default로
    const today = new Date().toLocaleDateString("ko-KR", {
      timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    }).replace(/\. /g, "-").replace(".", "").trim(); // YYYY-MM-DD

    await client.chat.postMessage({
      channel: dmChannel,
      text: `${data.workName} ${data.episode}화 [${data.operationName}] 태스크 재생성 일정 입력`,
      blocks: [
        { type: "section", text: { type: "mrkdwn",
          text: `*${data.workName} ${data.episode}화 [${data.operationName}] 태스크 재생성*\n일정을 입력하고 실행해줘.` } },
        { type: "actions", elements: [
          { type: "button", action_id: "retake_open_date_modal",
            text: { type: "plain_text", text: "📅 일정 입력 후 태스크 재생성 실행" },
            style: "primary", value: draftId },
          { type: "button", action_id: "retake_close",
            text: { type: "plain_text", text: "❌ 종료" }, value: draftId },
        ]},
      ],
    });
  }

  // ── 일정 입력 모달 열기 ───────────────────────────────────
  app.action("retake_open_date_modal", async ({ ack, body, client }) => {
    await ack();
    const draftId = body.actions[0].value;
    const data = draftStore.get(draftId);
    if (!data) return;

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal", callback_id: "submit_retake_date_modal",
        private_metadata: JSON.stringify({ draftId }),
        title:  { type: "plain_text", text: "태스크 재생성 일정 입력" },
        submit: { type: "plain_text", text: "태스크 재생성 실행" },
        close:  { type: "plain_text", text: "취소" },
        blocks: [
          { type: "section", text: { type: "mrkdwn",
            text: `*${data.workName} ${data.episode}화 [${data.operationName}]*` } },
          { type: "input", block_id: "rt_start_block",
            label: { type: "plain_text", text: "시작일" },
            element: {
              type: "datepicker", action_id: "value",
              initial_date: today,
              placeholder: { type: "plain_text", text: "날짜 선택" },
            },
          },
          { type: "input", block_id: "rt_end_block",
            label: { type: "plain_text", text: "마감일" },
            element: {
              type: "datepicker", action_id: "value",
              initial_date: today,
              placeholder: { type: "plain_text", text: "날짜 선택" },
            },
          },
          { type: "input", block_id: "rt_end_time_block",
            label: { type: "plain_text", text: "마감 시간 (선택, 미입력 시 23:59)" },
            optional: true,
            element: {
              type: "timepicker", action_id: "value",
              initial_time: "23:59",
              placeholder: { type: "plain_text", text: "시간 선택" },
            },
          },
        ],
      },
    });
  });

  // ── 일정 입력 완료 → retake API 호출 ─────────────────────
  app.view("submit_retake_date_modal", async ({ ack, body, view, client }) => {
    await ack();
    const { draftId } = JSON.parse(view.private_metadata || "{}");
    const data = draftStore.get(draftId);
    if (!data) return;

    const startDateOnly = view.state.values.rt_start_block?.value?.selected_date || "";
    const startDate = startDateOnly ? `${startDateOnly}T00:00:00+09:00` : "";
    const endDateOnly = view.state.values.rt_end_block?.value?.selected_date || "";
    const endTime = view.state.values.rt_end_time_block?.value?.selected_time || "23:59";
    const endDate = endDateOnly ? `${endDateOnly}T${endTime}:00+09:00` : "";

    if (!startDate || !endDateOnly) {
      await client.chat.postMessage({ channel: data.dmChannelId,
        text: "⚠️ 시작일과 마감일을 모두 선택해줘." });
      return;
    }

    try {
      const reqBody = {
        operationUuid:     data.operationUuid,
        creationReason:    "RETAKE",
        sourceTaskUuid:    data.sourceTaskUuid,
        requiredSetting: {
          taskType:  "NORMAL",
          startDate: startDate,
          endDate:   endDate,
        },
      };

      console.log("[retake] 요청 body:", JSON.stringify(reqBody, null, 2));

      const json = await _apiFetch(`${BASE()}/api/v1/tasks/${data.sourceTaskUuid}/retake`, {
        method:  "POST",
        headers: { Authorization: `Bearer ${TOKEN()}`, "Content-Type": "application/json" },
        body:    JSON.stringify(reqBody),
      }, { bot: "retake", endpoint: "/tasks/{uuid}/retake", params: {}, expectedCount: null });
      console.log("[retake] 응답:", JSON.stringify(json));

      if (!json.success) throw new Error(json.error?.message || "태스크 재생성 실패");

      const createdUuids = json.data?.createdTaskUuids || [];

      // 일정 할당: POST /api/v1/tasks/dates
      if (createdUuids.length > 0 && startDate && endDate) {
        try {
          const dateJson = await _apiFetch(`${BASE()}/api/v1/tasks/dates`, {
            method:  "POST",
            headers: { Authorization: `Bearer ${TOKEN()}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              tasks: createdUuids.map(uuid => ({
                taskUuid:  uuid,
                startDate: startDate,
                endDate:   endDate,
              })),
            }),
          }, { bot: "retake", endpoint: "/tasks/dates", params: {}, expectedCount: null });
          console.log("[retake] 일정 할당 응답:", JSON.stringify(dateJson));
          if (dateJson.data?.실패 > 0) {
            console.warn("[retake] 일정 할당 일부 실패:", JSON.stringify(dateJson.data.failedTaskUuids));
          }
        } catch (dateErr) {
          console.error("[retake] 일정 할당 API 오류:", dateErr.message);
        }
      }

      // 작업자 채널 선조회 후 초안 메시지 버튼 결정
      let resolvedChannelId  = null;
      let resolvedSlackIds   = null;
      let resolvedWorkerEmail = null;

      if (createdUuids.length > 0) {
        try {
          const taskJson = await _apiFetch(`${BASE()}/api/v1/tasks/${createdUuids[0]}`, {
            headers: { Authorization: `Bearer ${TOKEN()}` },
          }, { bot: "retake", endpoint: "/tasks/{uuid}", params: {}, expectedCount: 1 });
          resolvedWorkerEmail = taskJson.data?.작업자?.이메일 || null;
          console.log(`[retake] 작업자 이메일: ${resolvedWorkerEmail}`);

          if (resolvedWorkerEmail) {
            const workerInfo = await _getWorkerChannelId(resolvedWorkerEmail);
            resolvedChannelId  = workerInfo?.channelId || null;
            resolvedSlackIds   = workerInfo?.slackIds  || null;
            console.log(`[retake] 채널 ID: ${resolvedChannelId} / Slack IDs: ${resolvedSlackIds}`);
            if (resolvedChannelId) {
              draftStore.set(draftId, { ...data, workerChannelId: resolvedChannelId, workerSlackIds: resolvedSlackIds, endDate });
              console.log(`[retake] 작업자 채널 ID 확보 → ${resolvedChannelId}`);
            }
          }
        } catch (preErr) {
          console.error('[retake] 작업자 채널 선조회 실패:', preErr.message);
        }
      }

      // APM에게 완료 메시지 — 채널 확보 여부에 따라 버튼 분기
      const completeMsgMeta = JSON.stringify({ draftId });
      const hasChannel = !!resolvedChannelId;
      await client.chat.postMessage({
        channel: data.dmChannelId,
        text: `✅ ${data.workName} ${data.episode}화 [${data.operationName}] 태스크 재생성 완료`,
        blocks: [
          { type: "section", text: { type: "mrkdwn",
            text: `✅ *${data.workName} ${data.episode}화 [${data.operationName}] 태스크 재생성 완료*\n\n*시작일:* ${startDate}\n*마감일:* ${endDate}\n*생성된 태스크:* ${createdUuids.map(u => `\`${u.slice(0,8)}...\``).join(", ") || "-"}` } },
          { type: "context", elements: [
            { type: "mrkdwn", text: `처리자: <@${body.user.id}> · ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}` },
          ]},
          { type: "actions", elements: hasChannel ? [
            { type: "button", action_id: "retake_worker_request_send",
              text: { type: "plain_text", text: "👤 작업자 요청" },
              style: "primary", value: completeMsgMeta },
            { type: "button", action_id: "retake_open_worker_msg_modal",
              text: { type: "plain_text", text: "🔧 내부 수정" },
              value: completeMsgMeta },
          ] : [
            { type: "button", action_id: "retake_manual_channel_input",
              text: { type: "plain_text", text: "✏️ 채널 ID 직접 입력" },
              style: "primary", value: JSON.stringify({ draftId, workerEmail: resolvedWorkerEmail || '' }) },
          ]},
          ...(!hasChannel && resolvedWorkerEmail ? [{ type: "section", text: { type: "mrkdwn",
            text: `⚠️ 작업자 \`${resolvedWorkerEmail}\` 채널 ID를 찾을 수 없어. 직접 입력해줘.` } }] : []),
        ],
      });

      if (createdUuids.length > 0) {
        try {
          // 채널 조회 이미 완료 — 결과 재사용
          const workerEmail     = resolvedWorkerEmail;
          const workerChannelId = resolvedChannelId;
          const workerSlackIds  = resolvedSlackIds;

          if (workerEmail) {
            if (workerChannelId) {
              // 이미 draftStore 업데이트됨
            } else {
              // 채널 없음 — 버튼으로 이미 안내됨 (별도 메시지 불필요)
            }
          } else {
            console.warn(`[retake] 작업자 미배정 또는 이메일 없음 — taskUuid: ${createdUuids[0]}`);
            await client.chat.postMessage({ channel: data.dmChannelId,
              text: `⚠️ 재생성된 태스크에 작업자가 배정되어 있지 않아. 직접 확인해줘.` });
          }
        } catch (dmErr) {
          console.error("[retake] 작업자 채널 메시지 전송 실패:", dmErr.message);
          await client.chat.postMessage({ channel: data.dmChannelId,
            text: `⚠️ 작업자 채널 메시지 전송 실패: ${dmErr.message}` });
        }
      }
    } catch (e) {
      console.error("[retake] 오류:", e.message);
      await client.chat.postMessage({ channel: data.dmChannelId,
        text: `❌ 태스크 재생성 실패: ${e.message}` });
    }
  });

  // ── 작품명·화수 수동 입력 모달 ────────────────────────────
  // ── DM 직접 소환: 리테이크봇 ─────────────────────────────
  app.action("direct_retake_btn", async ({ ack, body, client }) => {
    await ack();
    const sourceLink = body.actions?.[0]?.value || "";
    const pendingId  = `rt_pending_${Date.now()}`;
    draftStore.set(pendingId, {
      type:          "retake_pending",
      workName:      "",
      workNameKo:    "",
      episode:       "",
      sourceLink:    sourceLink !== "direct" ? sourceLink : "",
      dmChannelId:   body.user.id,
      originalText:  "",
      requesterName: "",
    });
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal", callback_id: "submit_retake_info_modal",
        private_metadata: JSON.stringify({ pendingId }),
        title:  { type: "plain_text", text: "태스크 재생성" },
        submit: { type: "plain_text", text: "다음" },
        close:  { type: "plain_text", text: "취소" },
        blocks: [
          { type: "input", block_id: "rt_work_block",
            label: { type: "plain_text", text: "작품명 (한국어 또는 일본어)" },
            optional: true,
            element: { type: "plain_text_input", action_id: "value",
              placeholder: { type: "plain_text", text: "예: 祭品新娘拐恶龙 / ゾンビさん / 서우전" } } },
          { type: "input", block_id: "rt_pivoid_block",
            label: { type: "plain_text", text: "pivoId (작품명 대신 입력 가능)" },
            optional: true,
            element: { type: "plain_text_input", action_id: "value",
              placeholder: { type: "plain_text", text: "예: 38873" } } },
          { type: "input", block_id: "rt_episode_block",
            label: { type: "plain_text", text: "화수 (숫자만)" },
            element: { type: "plain_text_input", action_id: "value",
              placeholder: { type: "plain_text", text: "예: 3" } } },
        ],
      },
    });
  });

  // ── 작품명·화수 수동 입력 모달 ────────────────────────────
  app.action("open_retake_info_modal", async ({ ack, body, client }) => {
    await ack();
    const pending = draftStore.get(body.actions[0].value);
    if (!pending) return;

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal", callback_id: "submit_retake_info_modal",
        private_metadata: JSON.stringify({ pendingId: body.actions[0].value }),
        title:  { type: "plain_text", text: "작품 정보 입력" },
        submit: { type: "plain_text", text: "다음" },
        close:  { type: "plain_text", text: "취소" },
        blocks: [
          { type: "section", text: { type: "mrkdwn",
            text: `AI 추출값 — 작품명: \`${pending.workName || "없음"}\`　화수: \`${pending.episode || "없음"}\`` } },
          { type: "input", block_id: "rt_work_block",
            label: { type: "plain_text", text: "작품명 (한국어 또는 일본어)" },
            optional: true,
            element: { type: "plain_text_input", action_id: "value",
              initial_value: pending.workName || "",
              placeholder: { type: "plain_text", text: "예: 祭品新娘拐恶龙 / ゾンビさん / 서우전" } } },
          { type: "input", block_id: "rt_pivoid_block",
            label: { type: "plain_text", text: "pivoId (작품명 대신 입력 가능)" },
            optional: true,
            element: { type: "plain_text_input", action_id: "value",
              placeholder: { type: "plain_text", text: "예: 38873" } } },
          { type: "input", block_id: "rt_episode_block",
            label: { type: "plain_text", text: "화수 (숫자만)" },
            element: { type: "plain_text_input", action_id: "value",
              initial_value: pending.episode || "",
              placeholder: { type: "plain_text", text: "예: 3" } } },
        ],
      },
    });
  });

  app.view("submit_retake_info_modal", async ({ ack, body, view, client }) => {
    await ack();
    const { pendingId } = JSON.parse(view.private_metadata || "{}");
    const pending = draftStore.get(pendingId);
    if (!pending) return;

    const v        = view.state.values;
    const workName = v.rt_work_block?.value?.value?.trim() || "";
    const pivoId   = v.rt_pivoid_block?.value?.value?.trim() || "";
    const episode  = v.rt_episode_block?.value?.value?.trim() || "";

    if (!workName && !pivoId) {
      await client.chat.postMessage({ channel: pending.dmChannelId, text: "작품명 또는 pivoId 중 하나는 입력해줘." });
      return;
    }
    if (!episode) {
      await client.chat.postMessage({ channel: pending.dmChannelId, text: "화수를 입력해줘." });
      return;
    }

    let resolvedWorkName, resolvedWorkNameKo, resolvedPivoId;

    if (pivoId) {
      // pivoId 직접 입력 → Totus API 선 조회, 실패 시 마스터 시트 폴백
      // ※ 한일 작품 전용: pivoOriginalTitle(한국어 원제) 우선 반환
      //   중일 작품은 pivoOriginalTitle이 중국어로 오므로 마스터 시트를 통해 처리할 것
      console.log(`[retake] pivoId 입력 → Totus API 선 조회 (pivoId: ${pivoId})`);
      try {
        const _pivoRes = await _apiFetch(`${BASE()}/api/v1/projects?pivoId=${encodeURIComponent(pivoId)}`, {
          headers: { Authorization: `Bearer ${TOKEN()}` },
        }, { bot: "retake", endpoint: "/projects", params: { pivoId }, expectedCount: 1 });
        const list = _pivoRes?.data || [];
        const proj = list.find(p => {
          const d = p._detail || p;
          return d.진행상태 !== "CANCELED" && d.pivoId != null;
        });
        // [한일 기준] 1순위: proj.name(Totus 설정 프로젝트명) → 2순위: pivoOriginalTitle(한국어 원제) → 3순위: pivoTitle(일본어)
        // ※ 중일 작품은 추후 봇 분기 시 마스터 시트 우선으로 별도 처리 예정
        const totusName = proj?.name
                       || proj?._detail?.pivoOriginalTitle || proj?.detail?.pivoOriginalTitle
                       || proj?._detail?.pivoTitle        || proj?.detail?.pivoTitle
                       || null;

        if (totusName) {
          // Totus 조회 성공 → 마스터 시트에서 한국어 표시명 우선 확인
          const matchedByPivo = await matchWorkTitleFromSheet(null, null, pivoId).catch(() => null);
          resolvedWorkName   = matchedByPivo?.projectName || totusName;
          resolvedWorkNameKo = matchedByPivo?.projectName || matchedByPivo?.ko || totusName;
          console.log(`[retake] Totus 조회 성공: ${totusName} → 표시명: ${resolvedWorkName}`);
        } else {
          // Totus에 이름 없음 → 마스터 시트 폴백
          console.log(`[retake] Totus 이름 없음 → 마스터 시트 폴백`);
          const matchedByPivo = await matchWorkTitleFromSheet(null, null, pivoId).catch(() => null);
          resolvedWorkName   = matchedByPivo?.projectName || matchedByPivo?.ko || `(pivoId: ${pivoId})`;
          resolvedWorkNameKo = matchedByPivo?.ko || resolvedWorkName;
        }
      } catch (e) {
        // Totus API 실패 → 마스터 시트 폴백
        console.error(`[retake] Totus 조회 실패 → 마스터 시트 폴백:`, e.message);
        const matchedByPivo = await matchWorkTitleFromSheet(null, null, pivoId).catch(() => null);
        resolvedWorkName   = matchedByPivo?.projectName || matchedByPivo?.ko || `(pivoId: ${pivoId})`;
        resolvedWorkNameKo = matchedByPivo?.ko || resolvedWorkName;
      }
      resolvedPivoId = pivoId;
    } else {
      const matchedTitle = await matchWorkTitleFromSheet(workName, workName).catch(() => null);
      resolvedWorkName   = matchedTitle?.projectName || workName;
      resolvedWorkNameKo = matchedTitle?.projectName || workName;
      resolvedPivoId     = matchedTitle?.pivoId || null;
    }

    draftStore.delete(pendingId);

    await _proceedRetakeOperationSelect(client, pending.dmChannelId, {
      workName:      resolvedWorkName,
      workNameKo:    resolvedWorkNameKo,
      pivoId:        resolvedPivoId,
      episode,
      sourceLink:      pending.sourceLink      || "",
      requesterName:   pending.requesterName   || "",
      requesterUserId: pending.requesterUserId || null,
    });
  });



  // ── 작업자 요청 — 자동 메시지 전송 ──────────────────────
  app.action("retake_worker_request_send", async ({ ack, body, client }) => {
    await ack();
    const { draftId } = JSON.parse(body.actions[0].value || "{}");
    const data = draftStore.get(draftId);
    if (!data) return;

    const workerChannelId = data.workerChannelId || null;
    if (!workerChannelId) {
      const manualMeta2 = JSON.stringify({ draftId, workerEmail: data.workerEmail || '' });
      await client.chat.postMessage({ channel: body.user.id,
        text: '⚠️ 작업자 채널 정보가 없어. 직접 입력해줘.',
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: '⚠️ 작업자 채널 ID를 찾을 수 없어.\n직접 입력해서 메시지를 보내줘.' } },
          { type: 'actions', elements: [
            { type: 'button', action_id: 'retake_manual_channel_input',
              text: { type: 'plain_text', text: '✏️ 채널 ID 직접 입력' },
              style: 'primary', value: manualMeta2 },
          ]},
        ],
      });
      return;
    }

    // 마감일 포맷: YYYY-MM-DDTHH:MM:SS+09:00 → YYYY-MM-DD HH:MM
    const endDateDisplay = data.endDate
      ? data.endDate.replace("T", " ").slice(0, 16)
      : "미정";

    const mentionText = data.workerSlackIds
      ? data.workerSlackIds.split(",").map(id => `<@${id.trim()}>`).join(" ")
      : "";

    const msgText = `${data.workName} ${data.episode}화 작업을 다시 요청 드렸습니다.\n마감일 : ${endDateDisplay}`;

    const senderCtxAuto = data.requesterUserId
      ? `발송자: <@${data.requesterUserId}>`
      : data.requesterName ? `발송자: ${data.requesterName}` : null;
    const _resolvedApmIdAuto = data.actualApmId || (resolveApmUserId && data.actualApm ? resolveApmUserId(data.actualApm) : null);
    const apmCtxAuto = _resolvedApmIdAuto
      ? `담당 APM: <@${_resolvedApmIdAuto}>`
      : data.actualApm ? `담당 APM: ${data.actualApm}` : `담당 APM: <@${body.user.id}>`;
    const autoContextElements = [
      ...(senderCtxAuto ? [{ type: "mrkdwn", text: senderCtxAuto }] : []),
      { type: "mrkdwn", text: apmCtxAuto },
    ];

    try {
      try { await client.conversations.join({ channel: workerChannelId }); } catch (_) {}
      await client.chat.postMessage({
        channel: workerChannelId,
        text: `${mentionText} ${msgText}`.trim(),
        blocks: [
          ...(mentionText ? [{ type: "section", text: { type: "mrkdwn", text: mentionText } }] : []),
          { type: "section", text: { type: "mrkdwn", text: msgText } },
          { type: "divider" },
          { type: "context", elements: autoContextElements },
        ],
      });
      await client.chat.postMessage({ channel: body.user.id,
        text: `✅ 작업자 채널에 메시지를 전송했어.\n\n${msgText}` });
    } catch (e) {
      console.error("[retake] 작업자 요청 메시지 전송 실패:", e.message);
      await client.chat.postMessage({ channel: body.user.id,
        text: `⚠️ 전송 실패: ${e.message}` });
    }
  });

  // ── 작업자 메시지 모달 열기 ──────────────────────────────
  app.action("retake_open_worker_msg_modal", async ({ ack, body, client }) => {
    await ack();
    const { draftId } = JSON.parse(body.actions[0].value || "{}");
    const data = draftStore.get(draftId);
    if (!data) return;

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal", callback_id: "submit_retake_worker_msg_modal",
        private_metadata: JSON.stringify({ draftId }),
        title:  { type: "plain_text", text: "작업자에게 메시지 보내기" },
        submit: { type: "plain_text", text: "전송" },
        close:  { type: "plain_text", text: "취소" },
        blocks: [
          { type: "section", text: { type: "mrkdwn",
            text: `*${data.workName} ${data.episode}화 [${data.operationName}]* 작업자 채널에 전송할 메시지를 작성해줘.` } },
          { type: "input", block_id: "rt_worker_workname_block",
            label: { type: "plain_text", text: "작품명 (수정 가능)" },
            element: { type: "plain_text_input", action_id: "value",
              initial_value: data.workName || "",
              placeholder: { type: "plain_text", text: "작품명" } } },
          { type: "input", block_id: "rt_worker_apm_block",
            label: { type: "plain_text", text: "담당 APM (수정 가능)" },
            hint: { type: "plain_text", text: "납품 시트에서 자동 조회. Slack ID(U...) 입력 시 멘션으로 발송됩니다." },
            optional: true,
            element: { type: "plain_text_input", action_id: "value",
              initial_value: data.actualApmId || data.actualApm || "",
              placeholder: { type: "plain_text", text: "예: 서주원 또는 U07E0QPL8MV" } } },
          { type: "input", block_id: "rt_worker_msg_block",
            label: { type: "plain_text", text: "수정 내용" },
            element: { type: "plain_text_input", action_id: "value", multiline: true,
              placeholder: { type: "plain_text", text: "수정 내용을 입력해줘." } } },
          { type: "input", block_id: "rt_worker_img_block",
            label: { type: "plain_text", text: "이미지 URL (여러 장은 줄바꿈으로 구분, 선택)" },
            optional: true,
            element: { type: "plain_text_input", action_id: "value", multiline: true,
              placeholder: { type: "plain_text", text: "https://files.slack.com/...\nhttps://files.slack.com/..." } } },
        ],
      },
    });
  });

  // ── 작업자 메시지 모달 제출 → 채널 전송 ─────────────────
  app.view("submit_retake_worker_msg_modal", async ({ ack, body, view, client }) => {
    await ack();
    const { draftId } = JSON.parse(view.private_metadata || "{}");
    const data = draftStore.get(draftId);
    if (!data) return;

    const workNameEdited = view.state.values.rt_worker_workname_block?.value?.value?.trim() || data.workName || "";
    const apmEdited      = view.state.values.rt_worker_apm_block?.value?.value?.trim()      || data.actualApm || "";
    const msgText        = view.state.values.rt_worker_msg_block?.value?.value?.trim() || "";
    const imgRaw         = view.state.values.rt_worker_img_block?.value?.value?.trim() || "";
    const imgUrls        = imgRaw ? imgRaw.split("\n").map(u => u.trim()).filter(Boolean) : [];

    if (!msgText) {
      await client.chat.postMessage({ channel: body.user.id, text: "⚠️ 수정 내용을 입력해줘." });
      return;
    }

    // 작업자 채널 ID 조회
    let workerChannelId = data.workerChannelId || null;
    if (!workerChannelId) {
      const manualMeta3 = JSON.stringify({ draftId, workerEmail: data.workerEmail || '' });
      await client.chat.postMessage({ channel: body.user.id,
        text: '⚠️ 작업자 채널 정보가 없어. 직접 입력해줘.',
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: '⚠️ 작업자 채널 ID를 찾을 수 없어.\n직접 입력해서 메시지를 보내줘.' } },
          { type: 'actions', elements: [
            { type: 'button', action_id: 'retake_manual_channel_input',
              text: { type: 'plain_text', text: '✏️ 채널 ID 직접 입력' },
              style: 'primary', value: manualMeta3 },
          ]},
        ],
      });
      return;
    }

    try {
      const sharp  = require("sharp");
      const axios  = require("axios");
      const fs     = require("fs");
      const path   = require("path");
      const os     = require("os");

      // C열에 쉼표로 여러 ID 저장 가능 (예: "U0123,U0456")
      const mentionText = data.workerSlackIds
        ? data.workerSlackIds.split(",").map(id => `<@${id.trim()}>`).join(" ")
        : "";

      const endDateDisplay = data.endDate
        ? data.endDate.replace("T", " ").slice(0, 16)
        : "미정";

      const templateMsg =
`안녕하세요.
리테이크 작업 요청 드립니다.

・ 작품명: ${workNameEdited}
・ 회차: ${data.episode}화
・ 수정 내용
${msgText}

・ 제출 희망일 : ${endDateDisplay}`;

      // 채널 미참여 시 자동 join (not_in_channel 방지)
      try { await client.conversations.join({ channel: workerChannelId }); } catch (_) {}
      console.log("[retake] 💬 작업자 채널 전송 시도 — channel:", workerChannelId);

      // 발송자·담당 APM 컨텍스트 구성
      // - 발송자: requesterUserId(Slack ID) 우선, 없으면 이름 텍스트
      // - 담당 APM: 모달 입력값. U로 시작하면 멘션, 아니면 텍스트
      const senderCtx = data.requesterUserId
        ? `발송자: <@${data.requesterUserId}>`
        : data.requesterName ? `발송자: ${data.requesterName}` : null;
      const _apmEditedId = /^U[A-Z0-9]{6,}$/.test(apmEdited)
        ? apmEdited
        : (resolveApmUserId && apmEdited ? resolveApmUserId(apmEdited) : null);
      const apmCtxText = _apmEditedId
        ? `담당 APM: <@${_apmEditedId}>`
        : apmEdited ? `담당 APM: ${apmEdited}` : `담당 APM: <@${body.user.id}>`;
      const contextElements = [
        ...(senderCtx ? [{ type: "mrkdwn", text: senderCtx }] : []),
        { type: "mrkdwn", text: apmCtxText },
      ];

      // 메인 메시지 전송 (이미지 제외)
      const mainMsg = await client.chat.postMessage({
        channel: workerChannelId,
        text: `${mentionText} 리테이크 작업 요청 드립니다.`,
        blocks: [
          ...(mentionText ? [{ type: "section", text: { type: "mrkdwn", text: mentionText } }] : []),
          { type: "section", text: { type: "mrkdwn", text: templateMsg } },
          { type: "divider" },
          { type: "context", elements: contextElements },
        ],
      });

      // 이미지 첨부 (URL이 있을 경우)
      if (imgUrls.length > 0) {
        const tmpDir    = os.tmpdir();
        const failedLinks = [];

        for (const [i, url] of imgUrls.entries()) {
          try {
            // Slack 파일 URL에서 파일 ID 추출 → files.info로 url_private_download 조회
            // URL 형식: https://jamake.slack.com/files/U.../F0B04ENE8LB/filename
            let downloadUrl = url;
            const fileIdMatch = url.match(/\/(F[A-Z0-9]{8,})\//);
            if (fileIdMatch) {
              try {
                const infoRes = await client.files.info({ file: fileIdMatch[1] });
                downloadUrl = infoRes.file?.url_private_download || infoRes.file?.url_private || url;
                console.log(`[retake] 이미지 ${i + 1} download URL 확보: ${downloadUrl}`);
              } catch (infoErr) {
                console.warn(`[retake] 이미지 ${i + 1} files.info 실패, 원본 URL 사용:`, infoErr.message);
              }
            }

            // 실제 바이너리 다운로드 (봇 토큰 인증)
            const res = await axios.get(downloadUrl, {
              responseType: 'arraybuffer',
              headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
            });

            // sharp 리사이즈 (가로 320px, 여백 20px)
            const tmpPath = path.join(tmpDir, `retake_thumb_${Date.now()}_${i}.png`);
            await sharp(Buffer.from(res.data))
              .resize({ width: 320, withoutEnlargement: true })
              .extend({ top: 20, bottom: 20, left: 20, right: 20,
                background: { r: 255, g: 255, b: 255, alpha: 1 } })
              .png()
              .toFile(tmpPath);

            // 썸네일 업로드
            await client.files.uploadV2({
              channel_id: workerChannelId,
              file: fs.createReadStream(tmpPath),
              filename: `retake_thumb_${i + 1}.png`,
              initial_comment: '',
            });
            fs.unlink(tmpPath, () => {});
          } catch (imgErr) {
            console.error(`[retake] 이미지 ${i + 1} 전처리 실패:`, imgErr.message);
            failedLinks.push(`<${url}|이미지 ${i + 1} 원본>`);
          }
        }

        // 실패한 이미지만 스레드 댓글로 전송
        if (failedLinks.length > 0) {
          await client.chat.postMessage({
            channel: workerChannelId,
            thread_ts: mainMsg.ts,
            text: failedLinks.join('\n'),
            blocks: [{ type: 'section', text: { type: 'mrkdwn',
              text: '⚠️ *썸네일 생성 실패 — 원본 링크로 확인해주세요*\n' + failedLinks.join('\n') } }],
          });
        }
      }

      await client.chat.postMessage({ channel: body.user.id, text: "✅ 작업자 채널에 메시지를 전송했어." });
    } catch (e) {
      console.error("[retake] 작업자 메시지 전송 실패:", e.message);
      await client.chat.postMessage({ channel: body.user.id, text: `⚠️ 전송 실패: ${e.message}` });
    }
  });

  // ── 채널 ID 직접 입력 모달 ───────────────────────────────
  app.action('retake_manual_channel_input', async ({ ack, body, client }) => {
    await ack();
    const { draftId, workerEmail } = JSON.parse(body.actions[0].value || '{}');
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'submit_retake_manual_channel',
        private_metadata: JSON.stringify({ draftId }),
        title: { type: 'plain_text', text: '채널 ID 직접 입력' },
        submit: { type: 'plain_text', text: '전송' },
        close:  { type: 'plain_text', text: '취소' },
        blocks: [
          { type: 'section', text: { type: 'mrkdwn',
            text: workerEmail ? `작업자: \`${workerEmail}\`` : '작업자 이메일 정보 없음' } },
          { type: 'input', block_id: 'manual_slack_id_block',
            label: { type: 'plain_text', text: 'Slack User ID' },
            hint:  { type: 'plain_text', text: '예: U0123456789' },
            element: { type: 'plain_text_input', action_id: 'value',
              placeholder: { type: 'plain_text', text: 'U0123456789' } } },
          { type: 'input', block_id: 'manual_channel_id_block',
            label: { type: 'plain_text', text: '채널 ID' },
            hint:  { type: 'plain_text', text: '예: C0123456789' },
            element: { type: 'plain_text_input', action_id: 'value',
              placeholder: { type: 'plain_text', text: 'C0123456789' } } },
        ],
      },
    });
  });

  // ── 채널 ID 직접 입력 모달 제출 ────────────────────────────
  app.view('submit_retake_manual_channel', async ({ ack, body, view, client }) => {
    await ack();
    const { draftId } = JSON.parse(view.private_metadata || '{}');
    const data = draftStore.get(draftId);
    if (!data) {
      await client.chat.postMessage({ channel: body.user.id,
        text: '⚠️ 초안 정보가 만료됐어. 태스크 재생성을 다시 시도해줘.' });
      return;
    }

    const manualSlackId   = view.state.values.manual_slack_id_block?.value?.value?.trim() || '';
    const manualChannelId = view.state.values.manual_channel_id_block?.value?.value?.trim() || '';

    if (!manualChannelId) {
      await client.chat.postMessage({ channel: body.user.id, text: '⚠️ 채널 ID를 입력해줘.' });
      return;
    }

    // draftStore 업데이트
    draftStore.set(draftId, {
      ...data,
      workerChannelId: manualChannelId,
      workerSlackIds:  manualSlackId || data.workerSlackIds || '',
    });

    // 👤 작업자 요청 / 💬 메시지 보내기 버튼 다시 표시
    const workName    = data.workName    || '';
    const episode     = data.episode     || '';
    const endDate     = data.endDate     || '';
    const endDisplay  = endDate ? endDate.replace('T', ' ').slice(0, 16) : '미정';

    await client.chat.postMessage({
      channel: body.user.id,
      text: `✅ 채널 ID 등록 완료. 작업자에게 메시지를 보내줘.`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn',
          text: `✅ *채널 ID 등록 완료*\n작품명: ${workName} / ${episode}화 / 마감: ${endDisplay}\n채널: ${manualChannelId}` } },
        { type: 'actions', elements: [
          { type: 'button', action_id: 'retake_worker_request_send',
            text: { type: 'plain_text', text: '👤 작업자 요청' },
            style: 'primary', value: JSON.stringify({ draftId }) },
          { type: 'button', action_id: 'retake_open_worker_msg_modal',
            text: { type: 'plain_text', text: '🔧 내부 수정' },
            value: JSON.stringify({ draftId }) },
        ]},
      ],
    });
  });

  // ── 종료 버튼 ─────────────────────────────────────────────
  app.action("retake_close", async ({ ack, body, client }) => {
    await ack();
    const data = draftStore.get(body.actions[0].value);
    const info = data ? `${data.workName || ""} ${data.episode || ""}화` : "";
    await client.chat.update({
      channel: body.channel.id, ts: body.message.ts,
      text: `❌ 태스크 재생성 종료${info ? ` — ${info}` : ""}`,
      blocks: [
        { type: "section", text: { type: "mrkdwn",
          text: `❌ *태스크 재생성 종료*${info ? `\n${info}` : ""}\n태스크 재생성 없이 종료했어.` } },
        { type: "context", elements: [
          { type: "mrkdwn", text: `처리자: <@${body.user.id}> · ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}` },
        ]},
      ],
    });
  });

  return { handleRetakeInquiry };
};
