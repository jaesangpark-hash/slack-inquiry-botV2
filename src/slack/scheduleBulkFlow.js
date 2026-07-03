"use strict";

// ══════════════════════════════════════════════════════════════════
// scheduleBulkFlow.js — 여러 회차 일정 일괄 변경 플로우
//
// 흐름:
//   schbulk_open_basic_modal (action) → Modal A (schbulk_step1)
//     → TOTUS 오퍼레이션 조회 → Modal B (schbulk_step2)
//     → 일정 계산 → DM 시뮬레이션 메시지
//     → schbulk_apply (action)  : TOTUS 반영
//     → schbulk_open_adjust (action) → Modal C (schbulk_adjust)
//                                       → TOTUS 반영
// ══════════════════════════════════════════════════════════════════

const EXCLUDE_OP_CODES    = new Set(["OTC0087", "OTC0077"]); // 납품검수·피코마검수 제외
const EXCLUDE_TASK_STATES = new Set(["COMPLETED", "DROP", "DELIVERED", "CONFIRMED"]);
const TRANSLATION_OP      = "OTC0012"; // 번역 (리테이크 기준 오퍼레이션)

module.exports = function registerScheduleBulkFlow(app, { draftStore, generateDraftId }) {
  const BASE  = () => process.env.PLATFORM_API_URL;
  const TOKEN = () => process.env.PLATFORM_API_TOKEN;

  // ── 날짜 유틸 ────────────────────────────────────────────────────
  function addDays(isoDate, n) {
    const d = new Date(isoDate);
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function toMD(isoDate) {
    if (!isoDate) return "-";
    const [, mm, dd] = isoDate.split("-");
    return `${parseInt(mm)}/${parseInt(dd)}`;
  }

  // ── 회차 범위 + 그룹당 회차 수 → 그룹 배열 ─────────────────────
  // startEp=1, endEp=11, groupSize=3 → [{label:"1-3화",[1,2,3]}, ..., {label:"10-11화",[10,11]}]
  function buildGroups(startEp, endEp, groupSize) {
    if (!(groupSize >= 1)) groupSize = 3; // 0/음수/NaN 방어
    const groups = [];
    for (let i = startEp; i <= endEp; i += groupSize) {
      const gEnd = Math.min(i + groupSize - 1, endEp);
      const episodes = [];
      for (let ep = i; ep <= gEnd; ep++) episodes.push(ep);
      const label = i === gEnd ? `${i}화` : `${i}-${gEnd}화`;
      groups.push({ label, episodes });
    }
    return groups;
  }

  // ── 일정 계산 ─────────────────────────────────────────────────────
  // opList: [{opCode, opName}] (조회된 순서)
  // opDurations: { opCode: days } — 0이면 스킵
  // 반환: [{ groupLabel, episodes, startDate, endDate, opSchedule }]
  function calcSchedule(groups, firstStart, gapDays, opList, opDurations) {
    const result = [];
    let cursor = firstStart;
    for (const group of groups) {
      const opSchedule = [];
      let day = cursor;
      for (const { opCode, opName } of opList) {
        const days = opDurations[opCode] || 0;
        if (!days) continue;
        const opEnd = addDays(day, days - 1);
        opSchedule.push({ opCode, opName, startDate: day, endDate: opEnd });
        day = addDays(opEnd, 1);
      }
      const groupEnd = opSchedule.length ? opSchedule[opSchedule.length - 1].endDate : cursor;
      const groupStart = cursor;
      result.push({ groupLabel: group.label, episodes: group.episodes, startDate: groupStart, endDate: groupEnd, opSchedule });
      // 다음 그룹 시작 = 이 그룹 시작 + gapDays
      // (같은 오퍼레이션 마감일 간격이 gap이 되도록: 그룹1 번역마감 + N일 = 그룹2 번역마감)
      cursor = addDays(groupStart, gapDays);
    }
    return result;
  }

  // ── TOTUS: projectUuid 조회 (작품명 또는 pivoId) ─────────────────────
  async function _getProjectUuid(workName, pivoId) {
    try {
      const query = pivoId
        ? `pivoId=${encodeURIComponent(pivoId)}`
        : `name=${encodeURIComponent(workName)}`;
      const res  = await fetch(`${BASE()}/api/v1/projects?${query}`, {
        headers: { Authorization: `Bearer ${TOKEN()}` },
      });
      // 비-JSON 응답(HTML 오류 페이지 등)은 파싱 전에 HTTP status·content-type을 담은 에러로 변환 (원인 판독성)
      const ct   = res.headers.get("content-type") || "";
      if (!ct.includes("application/json")) {
        throw new Error(`TOTUS API 비-JSON 응답 (HTTP ${res.status}, content-type: ${ct || "없음"}) — ${(await res.text()).slice(0, 200)}`);
      }
      const json = await res.json();
      if (!json.success || !json.data?.length) return null;
      return json.data[0]?.uuid || null;
    } catch (e) {
      console.error("[scheduleBulk] projectUuid 조회 오류:", e.message);
      return null;
    }
  }

  // ── TOTUS: 단일 회차에서 오퍼레이션 목록 추출 ──────────────────────
  async function _getOpsForEpisode(projectUuid, episode) {
    try {
      const res  = await fetch(`${BASE()}/api/v1/projects/${projectUuid}/jobs?episode=${parseInt(episode, 10)}`, {
        headers: { Authorization: `Bearer ${TOKEN()}` },
      });
      const ct   = res.headers.get("content-type") || "";
      if (!ct.includes("application/json")) {
        throw new Error(`TOTUS API 비-JSON 응답 (HTTP ${res.status}, content-type: ${ct || "없음"}) — ${(await res.text()).slice(0, 200)}`);
      }
      const json = await res.json();
      if (!json.success) return [];
      const job = (json.data || [])[0];
      if (!job) return [];
      const seen = new Set();
      const ops  = [];
      for (const op of (job.오퍼레이션 || [])) {
        for (const task of (op.태스크 || [])) {
          const code = task.오퍼레이션유형;
          if (!code || EXCLUDE_OP_CODES.has(code) || seen.has(code)) continue;
          seen.add(code);
          ops.push({ opCode: code, opName: task.오퍼레이션유형명 || code });
        }
      }
      return ops;
    } catch (e) {
      console.error("[scheduleBulk] 오퍼레이션 조회 오류 (ep=" + episode + "):", e.message);
      return [];
    }
  }

  // ── TOTUS: 단일 회차의 opCode → taskUuid 맵 ───────────────────────
  async function _getTaskMap(projectUuid, episode) {
    try {
      const res  = await fetch(`${BASE()}/api/v1/projects/${projectUuid}/jobs?episode=${parseInt(episode, 10)}`, {
        headers: { Authorization: `Bearer ${TOKEN()}` },
      });
      const ct   = res.headers.get("content-type") || "";
      if (!ct.includes("application/json")) {
        throw new Error(`TOTUS API 비-JSON 응답 (HTTP ${res.status}, content-type: ${ct || "없음"}) — ${(await res.text()).slice(0, 200)}`);
      }
      const json = await res.json();
      if (!json.success) return {};
      const job = (json.data || [])[0];
      if (!job) return {};
      const map = {};
      for (const op of (job.오퍼레이션 || [])) {
        for (const task of (op.태스크 || [])) {
          const code = task.오퍼레이션유형;
          if (!code || EXCLUDE_OP_CODES.has(code)) continue;
          if (EXCLUDE_TASK_STATES.has(task.상태)) continue;
          if (!map[code]) map[code] = task.uuid; // 복수 태스크일 경우 첫 번째
        }
      }
      return map;
    } catch (e) {
      console.error("[scheduleBulk] taskMap 조회 오류 (ep=" + episode + "):", e.message);
      return {};
    }
  }

  // ── TOTUS: 태스크 재생성 + 날짜 반영 (execMode="retake") ──────────
  async function _applyRetakeSchedule(draft, client) {
    const { projectUuid, calculatedSchedule, dmChannelId } = draft;
    const allEps = calculatedSchedule.flatMap(g => g.episodes);
    let ok = 0, fail = 0;
    for (const ep of allEps) {
      try {
        const taskMap = await _getTaskMap(projectUuid, ep);
        const srcUuid = taskMap[TRANSLATION_OP];
        if (!srcUuid) {
          console.warn(`[scheduleBulk/retake] ep${ep} 번역 태스크 없음 — 스킵`);
          fail++;
          continue;
        }
        const res  = await fetch(`${BASE()}/api/v1/tasks/${srcUuid}/retake`, {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN()}`, "Content-Type": "application/json" },
        });
        const ct   = res.headers.get("content-type") || "";
        if (!ct.includes("application/json")) {
          throw new Error(`TOTUS API 비-JSON 응답 (HTTP ${res.status}, content-type: ${ct || "없음"}) — ${(await res.text()).slice(0, 200)}`);
        }
        const json = await res.json();
        if (!json.success) throw new Error(json.message || "retake API 오류");
        ok++;
      } catch (e) {
        console.error(`[scheduleBulk/retake] ep${ep} 실패:`, e.message);
        fail++;
      }
    }
    if (ok === 0) {
      await client.chat.postMessage({ channel: dmChannelId,
        text: "⚠️ 번역 태스크를 찾을 수 없어. 회차가 TOTUS에 등록되어 있는지 확인해줘." });
      return;
    }
    if (fail > 0) {
      await client.chat.postMessage({ channel: dmChannelId,
        text: `⚠️ ${fail}화 리테이크 실패 — ${ok}화만 날짜 반영 진행할게.` });
    }
    await _applySchedule(draft, client);
  }

  // ── TOTUS: 일정 일괄 반영 ─────────────────────────────────────────
  async function _applySchedule(draft, client) {
    const { projectUuid, calculatedSchedule, workName, dmChannelId } = draft;

    // 전 회차 taskMap 병렬 조회
    const allEps = calculatedSchedule.flatMap(g => g.episodes.map(ep => ({ ep, group: g })));
    const taskMaps = await Promise.all(
      allEps.map(async ({ ep, group }) => ({ ep, group, taskMap: await _getTaskMap(projectUuid, ep) }))
    );

    const payload = [];
    for (const { ep, group, taskMap } of taskMaps) {
      for (const opSch of group.opSchedule) {
        const taskUuid = taskMap[opSch.opCode];
        if (!taskUuid) continue;
        payload.push({ uuid: taskUuid, startDate: opSch.startDate, endDate: opSch.endDate });
      }
    }

    if (!payload.length) {
      await client.chat.postMessage({
        channel: dmChannelId,
        text: "⚠️ 반영할 태스크를 찾지 못했어. 회차가 TOTUS에 등록되어 있는지 확인해줘.",
      });
      return;
    }

    const applyRes  = await fetch(`${BASE()}/api/v1/tasks/dates`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN()}` },
      body:    JSON.stringify(payload),
    });
    const applyCt = applyRes.headers.get("content-type") || "";
    if (!applyCt.includes("application/json")) {
      throw new Error(`TOTUS API 비-JSON 응답 (HTTP ${applyRes.status}, content-type: ${applyCt || "없음"}) — ${(await applyRes.text()).slice(0, 200)}`);
    }
    const applyJson = await applyRes.json();

    if (applyJson.success) {
      const groupSummary = calculatedSchedule.map((g, i) =>
        `그룹 ${i + 1} (${g.groupLabel}) · 납품 ${toMD(g.endDate)} · ${g.episodes.length * g.opSchedule.length}개`
      ).join("\n");
      await client.chat.postMessage({
        channel: dmChannelId,
        text: `✅ *${workName} — 일정 반영 완료*\n${groupSummary}\n\n합계 ${payload.length}개 태스크`,
      });
    } else {
      await client.chat.postMessage({
        channel: dmChannelId,
        text: `❌ TOTUS 반영 중 오류: ${applyJson.error?.message || "알 수 없는 오류"}`,
      });
    }
  }

  // ── 시뮬레이션 DM 블록 빌더 ──────────────────────────────────────
  function buildSimBlocks(draft) {
    const { workName, calculatedSchedule, opList, opDurations, gapDays, draftId, execMode = "schedule" } = draft;
    const isRetake = execMode === "retake";
    const durSummary = (opList || [])
      .filter(op => (opDurations[op.opCode] || 0) > 0)
      .map(op => `${op.opName} ${opDurations[op.opCode]}일`)
      .join(" · ");
    const totalEps = (calculatedSchedule || []).reduce((s, g) => s + g.episodes.length, 0);

    const simTitle = isRetake ? "태스크 재생성 시뮬레이션" : "일정 시뮬레이션";
    const gapNote  = gapDays > 0 ? ` · 그룹간 갭 ${gapDays}일` : "";
    const blocks = [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*📋 ${workName} — ${simTitle}*\n${durSummary}${gapNote}` },
      },
    ];

    for (let gi = 0; gi < calculatedSchedule.length; gi++) {
      const group  = calculatedSchedule[gi];
      const isLast = gi === calculatedSchedule.length - 1;

      const lines = group.opSchedule.map(op => {
        const name = op.opName.slice(0, 8).padEnd(8, " ");
        return `${name}  ${toMD(op.startDate)} ~ ${toMD(op.endDate)}  (${opDurations[op.opCode]}일)`;
      });
      lines.push(`${"납품일".padEnd(8, " ")}  ${toMD(group.endDate)} ✅`);
      if (!isLast) {
        const nextStart = addDays(group.startDate, gapDays);
        lines.push(`↓ 다음 그룹 시작: ${toMD(group.startDate)} + 갭 ${gapDays}일 = ${toMD(nextStart)}`);
      }

      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*그룹 ${gi + 1} · ${group.groupLabel} · 시작일 ${group.startDate}*` },
      });
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: "```\n" + lines.join("\n") + "\n```" },
      });
    }

    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `총 ${totalEps}화 · ${payload_count(calculatedSchedule)}개 태스크 예정` }],
    });
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "schbulk_apply",
          style: "primary",
          text: { type: "plain_text", text: "✅ 이대로 일괄 반영" },
          value: draftId,
          confirm: {
            title: { type: "plain_text", text: "반영하시겠어요?" },
            text: { type: "mrkdwn", text: `*${workName}* ${totalEps}화 일정을 TOTUS에 반영합니다.` },
            confirm: { type: "plain_text", text: "반영" },
            deny: { type: "plain_text", text: "취소" },
          },
        },
        {
          type: "button",
          action_id: "schbulk_open_adjust",
          text: { type: "plain_text", text: "✏️ 세부 조정" },
          value: draftId,
        },
      ],
    });
    return blocks;
  }

  function payload_count(calculatedSchedule) {
    return (calculatedSchedule || []).reduce((s, g) => s + g.episodes.length * g.opSchedule.length, 0);
  }

  // ── Modal A 뷰 빌더 ───────────────────────────────────────────────
  // mode:    "single" | "multi" | "bulk"
  // execMode: "schedule" | "retake"
  function buildModalAView(draftId, dmChannelId, mode = "bulk", execMode = "schedule") {
    const isSingle = mode === "single";
    const isBulk   = mode === "bulk";
    const titleText = execMode === "retake"
      ? (isSingle ? "태스크 재생성" : "태스크 일괄 재생성")
      : (isSingle ? "일정 변경"     : "일정 일괄 변경");

    const blocks = [
      {
        type: "input", block_id: "work_name",
        label: { type: "plain_text", text: "작품명" },
        optional: execMode === "retake",
        element: { type: "plain_text_input", action_id: "value", placeholder: { type: "plain_text", text: "예: 二つの世界の主人公" } },
      },
    ];
    if (execMode === "retake") {
      blocks.push({
        type: "input", block_id: "pivo_id",
        label: { type: "plain_text", text: "PIVO ID (작품명 대신 입력 가능)" },
        optional: true,
        element: { type: "plain_text_input", action_id: "value", placeholder: { type: "plain_text", text: "예: 38873" } },
      });
    }
    blocks.push({
      type: "input", block_id: "ep_start",
      label: { type: "plain_text", text: isSingle ? "화수" : "시작 화수" },
      element: { type: "number_input", is_decimal_allowed: false, action_id: "value", min_value: "1" },
    });
    if (!isSingle) {
      blocks.push({
        type: "input", block_id: "ep_end",
        label: { type: "plain_text", text: "끝 화수" },
        element: { type: "number_input", is_decimal_allowed: false, action_id: "value", min_value: "1" },
      });
    }
    if (isBulk) {
      blocks.push({
        type: "input", block_id: "group_size",
        label: { type: "plain_text", text: "그룹당 회차 수" },
        element: { type: "number_input", is_decimal_allowed: false, action_id: "value", initial_value: "3", min_value: "1" },
        hint: { type: "plain_text", text: "나머지 회차는 마지막 그룹으로 자동 묶음 (예: 1-11화, 3화 그룹 → 1-3 / 4-6 / 7-9 / 10-11)" },
      });
    }
    // 단일 retake는 시작일을 retakeFlow의 datepicker 모달에서 받으므로 스킵
    if (!(isSingle && execMode === "retake")) {
      blocks.push({
        type: "input", block_id: "first_start",
        label: { type: "plain_text", text: isSingle ? "시작일" : "첫 번째 그룹 시작일" },
        element: { type: "datepicker", action_id: "value" },
      });
    }
    if (isBulk) {
      blocks.push({
        type: "input", block_id: "gap_days",
        label: { type: "plain_text", text: "그룹간 갭 (일)" },
        element: { type: "number_input", is_decimal_allowed: false, action_id: "value", initial_value: "7", min_value: "0", max_value: "365" },
        hint: { type: "plain_text", text: "이전 그룹 시작일 + N일 = 다음 그룹 시작일 (번역 마감 기준 N일 간격)" },
      });
    }
    return {
      type: "modal",
      callback_id: "schbulk_step1",
      private_metadata: JSON.stringify({ draftId, dmChannelId, mode, execMode }),
      title:  { type: "plain_text", text: titleText },
      submit: { type: "plain_text", text: "다음 →" },
      close:  { type: "plain_text", text: "취소" },
      blocks,
    };
  }

  // ── Modal B 뷰 빌더 (TOTUS 오퍼레이션 기반, 동적 생성) ───────────
  function buildModalBView(draftId, opList) {
    const blocks = [
      {
        type: "section",
        text: { type: "mrkdwn", text: "그룹 내 모든 회차에 동일 적용. *0일*이면 해당 오퍼레이션 건너뜀." },
      },
      { type: "divider" },
    ];
    for (const { opCode, opName } of opList) {
      blocks.push({
        type: "input",
        block_id: `op_${opCode}`,
        label: { type: "plain_text", text: opName },
        element: {
          type: "number_input", is_decimal_allowed: false, action_id: "value",
          initial_value: "5", min_value: "0", max_value: "365",
        },
        hint: { type: "plain_text", text: "일 단위" },
      });
    }
    return {
      type: "modal",
      callback_id: "schbulk_step2",
      private_metadata: JSON.stringify({ draftId }),
      title: { type: "plain_text", text: "오퍼레이션 일수" },
      submit: { type: "plain_text", text: "시뮬레이션 보기 →" },
      close:  { type: "plain_text", text: "취소" },
      blocks,
    };
  }

  // ── Modal C 뷰 빌더 (세부 조정) ──────────────────────────────────
  function buildModalCView(draftId, calculatedSchedule) {
    const blocks = [
      {
        type: "section",
        text: { type: "mrkdwn", text: "수정 후 즉시 반영. 이후 오퍼레이션은 자동 연동 없이 각각 직접 수정." },
      },
    ];
    for (let gi = 0; gi < calculatedSchedule.length; gi++) {
      const group = calculatedSchedule[gi];
      blocks.push({ type: "divider" });
      blocks.push({ type: "section", text: { type: "mrkdwn", text: `*그룹 ${gi + 1} · ${group.groupLabel}*` } });
      for (let oi = 0; oi < group.opSchedule.length; oi++) {
        const op = group.opSchedule[oi];
        blocks.push({
          type: "input", block_id: `adj_g${gi}_o${oi}_s`,
          label: { type: "plain_text", text: `${op.opName} — 시작일` },
          element: { type: "datepicker", action_id: "value", initial_date: op.startDate },
        });
        blocks.push({
          type: "input", block_id: `adj_g${gi}_o${oi}_e`,
          label: { type: "plain_text", text: `${op.opName} — 종료일` },
          element: { type: "datepicker", action_id: "value", initial_date: op.endDate },
        });
      }
    }
    return {
      type: "modal",
      callback_id: "schbulk_adjust",
      private_metadata: JSON.stringify({ draftId }),
      title: { type: "plain_text", text: "세부 조정" },
      submit: { type: "plain_text", text: "수정 후 반영 →" },
      close:  { type: "plain_text", text: "취소" },
      blocks,
    };
  }

  // ── 모드 선택 DM 전송 헬퍼 ─────────────────────────────────────
  async function _sendModePicker(client, channelId, execMode) {
    const header = execMode === "retake" ? "📋 태스크 재생성" : "📅 일정 일괄 변경";
    await client.chat.postMessage({
      channel: channelId,
      text: `${header} — 화수 구성을 선택해줘.`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*${header}* — 화수 구성을 선택해줘.` } },
        { type: "actions", elements: [
          { type: "button", action_id: "schbulk_mode_open_single",
            text: { type: "plain_text", text: "단일 화수" },
            value: JSON.stringify({ mode: "single", execMode }) },
          { type: "button", action_id: "schbulk_mode_open_multi",
            text: { type: "plain_text", text: "복수 화수" },
            value: JSON.stringify({ mode: "multi", execMode }) },
          { type: "button", action_id: "schbulk_mode_open_bulk", style: "primary",
            text: { type: "plain_text", text: "복수 + 그룹 갭" },
            value: JSON.stringify({ mode: "bulk", execMode }) },
        ]},
      ],
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // Action: "일정 일괄 변경" 버튼 → 모드 선택 DM
  // ══════════════════════════════════════════════════════════════════
  app.action("schbulk_open_basic_modal", async ({ ack, body, client }) => {
    await ack();
    try {
      await _sendModePicker(client, body.user.id, "schedule");
    } catch (e) {
      console.error("[scheduleBulk] open_basic_modal 오류:", e.message);
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // Action: 모드 선택 버튼 → Modal A 열기
  // ══════════════════════════════════════════════════════════════════
  app.action(/^schbulk_mode_open/, async ({ ack, body, client }) => {
    await ack();
    try {
      const { mode = "bulk", execMode = "schedule" } = JSON.parse(body.actions[0].value || "{}");
      const dmChannelId = body.channel?.id || body.user.id;
      const draftId = generateDraftId();
      draftStore.set(draftId, { draftId, dmChannelId, userId: body.user.id, execMode });
      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildModalAView(draftId, dmChannelId, mode, execMode),
      });
    } catch (e) {
      console.error("[scheduleBulk] mode_open 오류:", e.message);
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // View: Modal A submit → TOTUS 조회 → Modal B (update)
  // 로딩 모달을 trigger_id로 먼저 열고, 조회 완료 후 Modal B로 update
  // ══════════════════════════════════════════════════════════════════
  app.view("schbulk_step1", async ({ ack, body, view, client }) => {
    await ack();
    const { draftId, dmChannelId, mode = "bulk", execMode = "schedule" } = JSON.parse(view.private_metadata || "{}");
    const v = view.state.values;

    const workName   = v.work_name?.value?.value?.trim() || "";
    const pivoId     = v.pivo_id?.value?.value?.trim() || "";
    const epStart    = parseInt(v.ep_start?.value?.value || "1", 10);
    const firstStart = v.first_start?.value?.selected_date || "";
    let epEnd, groupSize, gapDays;
    if (mode === "single") {
      epEnd = epStart; groupSize = 1; gapDays = 0;
    } else if (mode === "multi") {
      epEnd     = parseInt(v.ep_end?.value?.value || String(epStart), 10);
      groupSize = Math.max(1, epEnd - epStart + 1);
      gapDays   = 0;
    } else {
      epEnd     = parseInt(v.ep_end?.value?.value     || "1", 10);
      groupSize = parseInt(v.group_size?.value?.value || "3", 10);
      gapDays   = parseInt(v.gap_days?.value?.value   || "7", 10);
    }

    const groups = buildGroups(epStart, epEnd, groupSize);
    const workIdentifier   = execMode === "retake" ? (workName || pivoId) : workName;
    const isSingleRetake   = mode === "single" && execMode === "retake";
    const needsStartDate   = !isSingleRetake;
    if (!groups.length || !workIdentifier || (needsStartDate && !firstStart)) {
      if (dmChannelId) await client.chat.postMessage({
        channel: dmChannelId,
        text: isSingleRetake
          ? "⚠️ 입력을 확인해줘 (작품명 또는 PIVO ID·화수 필수)."
          : execMode === "retake"
            ? "⚠️ 입력을 확인해줘 (시작 화수 ≤ 끝 화수, 작품명 또는 PIVO ID·시작일 필수)."
            : "⚠️ 입력을 확인해줘 (시작 화수 ≤ 끝 화수, 작품명·시작일 필수).",
      }).catch(e => console.error("[scheduleBulk] 입력검증 DM 실패:", e.message));
      return;
    }

    // 즉시 로딩 모달 열기 (trigger_id는 제출 후 3초 유효)
    let loadingViewId = null;
    try {
      const lv = await client.views.open({
        trigger_id: body.trigger_id,
        view: {
          type: "modal",
          title: { type: "plain_text", text: "TOTUS 조회 중..." },
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "⏳ 오퍼레이션 정보를 가져오는 중..." } }],
        },
      });
      loadingViewId = lv.view?.id || null;
    } catch (e) {
      console.error("[scheduleBulk] 로딩 모달 열기 실패:", e.message);
    }

    // TOTUS 조회 (비동기)
    try {
      const displayName = workName || `PIVO ${pivoId}`;
      const projectUuid = await _getProjectUuid(workName, pivoId);
      if (!projectUuid) {
        const errView = {
          type: "modal", title: { type: "plain_text", text: "오류" },
          blocks: [{ type: "section", text: { type: "mrkdwn", text: `⚠️ *${displayName}* 프로젝트를 찾지 못했어. 작품명 또는 PIVO ID를 확인해줘.` } }],
        };
        if (loadingViewId) await client.views.update({ view_id: loadingViewId, view: errView }).catch(e => console.error("[scheduleBulk] 프로젝트미발견 errView update 실패:", e.message));
        else await client.chat.postMessage({ channel: dmChannelId, text: `⚠️ TOTUS에서 *${displayName}* 프로젝트를 찾지 못했어.` });
        return;
      }

      // 단일 화수 + retake → retakeFlow의 오퍼레이션 선택 경로로 라우팅
      if (isSingleRetake) {
        draftStore.set(draftId, {
          type:            "retake",
          workName:        displayName,
          workNameKo:      displayName,
          pivoId:          pivoId || null,
          episode:         String(epStart),
          sourceLink:      "",
          requesterName:   "",
          requesterUserId: null,
          actualApm:       "",
          actualApmId:     null,
          dmChannelId,
        });
        if (loadingViewId) {
          await client.views.update({
            view_id: loadingViewId,
            view: {
              type:  "modal",
              title: { type: "plain_text", text: "완료" },
              close: { type: "plain_text", text: "닫기" },
              blocks: [{ type: "section", text: { type: "mrkdwn", text: "✅ DM에서 작업 유형을 선택해줘." } }],
            },
          }).catch(e => console.error("[scheduleBulk] 단일retake 완료모달 실패:", e.message));
        }
        await client.chat.postMessage({
          channel: dmChannelId,
          text: `${displayName} ${epStart}화 태스크 재생성 — 작업 유형을 선택해줘.`,
          blocks: [
            { type: "section", text: { type: "mrkdwn",
              text: `*🔄 태스크 재생성 요청*\n*작품명:* ${displayName}　*회차:* ${epStart}화\n\n내용을 확인하고 작업 유형을 선택해줘.` } },
            { type: "actions", elements: [
              { type: "button", action_id: "retake_select_operation",
                text: { type: "plain_text", text: "작업 유형 선택" },
                style: "primary", value: draftId },
              { type: "button", action_id: "retake_close",
                text: { type: "plain_text", text: "❌ 종료" }, value: draftId },
            ]},
          ],
        });
        return;
      }

      // 복수/그룹: 오퍼레이션 기간 조회 후 Modal B로 진행
      const sampleEps = groups.map(g => g.episodes[0]);
      const opSets    = await Promise.all(sampleEps.map(ep => _getOpsForEpisode(projectUuid, ep)));
      const seen = new Set();
      const opList = [];
      for (const ops of opSets) {
        for (const op of ops) {
          if (!seen.has(op.opCode)) { seen.add(op.opCode); opList.push(op); }
        }
      }

      if (!opList.length) {
        const errView = {
          type: "modal", title: { type: "plain_text", text: "오류" },
          blocks: [{ type: "section", text: { type: "mrkdwn", text: `⚠️ 조회된 오퍼레이션이 없어. 회차 번호를 확인해줘.` } }],
        };
        if (loadingViewId) await client.views.update({ view_id: loadingViewId, view: errView }).catch(e => console.error("[scheduleBulk] 오퍼레이션0 errView update 실패:", e.message));
        return;
      }

      // draft 업데이트
      const prev = draftStore.get(draftId) || {};
      draftStore.set(draftId, { ...prev, workName: displayName, projectUuid, groups, firstStart, gapDays, opList, execMode });

      // 로딩 모달 → Modal B
      const modalB = buildModalBView(draftId, opList);
      if (loadingViewId) {
        await client.views.update({ view_id: loadingViewId, view: modalB }).catch(e => console.error("[scheduleBulk] Modal B update 실패(사용자 로딩모달 정지 가능):", e.message));
      } else {
        // fallback: 로딩 모달 열기 실패 시 DM으로 안내
        await client.chat.postMessage({
          channel: dmChannelId,
          text: `오퍼레이션 조회 완료 (${opList.map(o => o.opName).join(", ")}). 다음 입력으로 진행해줘.`,
        });
      }
    } catch (e) {
      console.error("[scheduleBulk] step1 오류:", e.message);
      if (dmChannelId) {
        await client.chat.postMessage({ channel: dmChannelId, text: `⚠️ 처리 중 오류: ${e.message}` }).catch(e2 => console.error("[scheduleBulk] fallback DM 실패:", e2.message));
      }
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // View: Modal B submit → 일정 계산 → DM 시뮬레이션 메시지
  // ══════════════════════════════════════════════════════════════════
  app.view("schbulk_step2", async ({ ack, body, view, client }) => {
    await ack();
    const { draftId } = JSON.parse(view.private_metadata || "{}");
    const draft = draftStore.get(draftId);
    if (!draft) return;

    const v = view.state.values;
    const opDurations = {};
    for (const op of (draft.opList || [])) {
      const days = parseInt(v[`op_${op.opCode}`]?.value?.value || "0", 10);
      opDurations[op.opCode] = isNaN(days) ? 0 : Math.max(0, days);
    }

    const calculatedSchedule = calcSchedule(draft.groups, draft.firstStart, draft.gapDays, draft.opList, opDurations);
    const updatedDraft = { ...draft, opDurations, calculatedSchedule };
    draftStore.set(draftId, updatedDraft);

    await client.chat.postMessage({
      channel: draft.dmChannelId,
      text: `📋 ${draft.workName} 일정 시뮬레이션`,
      blocks: buildSimBlocks(updatedDraft),
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Action: "✅ 이대로 일괄 반영"
  // ══════════════════════════════════════════════════════════════════
  app.action("schbulk_apply", async ({ ack, body, client }) => {
    await ack();
    const draftId = body.actions[0].value;
    const draft   = draftStore.get(draftId);
    if (!draft?.calculatedSchedule) {
      await client.chat.postMessage({ channel: body.user.id, text: "⚠️ 세션이 만료됐어. 처음부터 다시 입력해줘." });
      return;
    }
    const isRetake = draft.execMode === "retake";
    await client.chat.postMessage({ channel: draft.dmChannelId, text: isRetake ? "⏳ TOTUS에 태스크 재생성 중..." : "⏳ TOTUS에 일정 반영 중..." });
    const applyFn = isRetake ? _applyRetakeSchedule : _applySchedule;
    await applyFn(draft, client).catch(async e => {
      await client.chat.postMessage({ channel: draft.dmChannelId, text: `⚠️ ${isRetake ? "재생성" : "반영"} 중 오류: ${e.message}` });
    });
    draftStore.delete(draftId);
  });

  // ══════════════════════════════════════════════════════════════════
  // Action: "✏️ 세부 조정" → Modal C 열기
  // ══════════════════════════════════════════════════════════════════
  app.action("schbulk_open_adjust", async ({ ack, body, client }) => {
    await ack();
    const draftId = body.actions[0].value;
    const draft   = draftStore.get(draftId);
    if (!draft?.calculatedSchedule) return;
    try {
      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildModalCView(draftId, draft.calculatedSchedule),
      });
    } catch (e) {
      console.error("[scheduleBulk] open_adjust 오류:", e.message);
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // View: Modal C submit → 조정된 날짜로 TOTUS 반영
  // ══════════════════════════════════════════════════════════════════
  app.view("schbulk_adjust", async ({ ack, body, view, client }) => {
    await ack();
    const { draftId } = JSON.parse(view.private_metadata || "{}");
    const draft = draftStore.get(draftId);
    if (!draft) return;

    const v = view.state.values;
    const updatedSchedule = (draft.calculatedSchedule || []).map((group, gi) => {
      const opSchedule = group.opSchedule.map((op, oi) => ({
        ...op,
        startDate: v[`adj_g${gi}_o${oi}_s`]?.value?.selected_date || op.startDate,
        endDate:   v[`adj_g${gi}_o${oi}_e`]?.value?.selected_date || op.endDate,
      }));
      const endDate = opSchedule.length ? opSchedule[opSchedule.length - 1].endDate : group.endDate;
      return { ...group, opSchedule, endDate };
    });

    draftStore.set(draftId, { ...draft, calculatedSchedule: updatedSchedule });

    const isRetake2 = draft.execMode === "retake";
    await client.chat.postMessage({ channel: draft.dmChannelId, text: isRetake2 ? "⏳ TOTUS에 태스크 재생성 중..." : "⏳ TOTUS에 일정 반영 중..." });
    const applyFn2 = isRetake2 ? _applyRetakeSchedule : _applySchedule;
    await applyFn2({ ...draft, calculatedSchedule: updatedSchedule }, client).catch(async e => {
      await client.chat.postMessage({ channel: draft.dmChannelId, text: `⚠️ ${isRetake2 ? "재생성" : "반영"} 중 오류: ${e.message}` });
    });
    draftStore.delete(draftId);
  });
};
