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

  // ── 그룹 텍스트 파서 ──────────────────────────────────────────────
  // "1-4, 5-8, 9-10" → [{label:"1-4화", episodes:[1,2,3,4]}, ...]
  function parseGroups(text) {
    return (text || "").split(",").map(s => s.trim()).filter(Boolean).map(token => {
      const m = token.match(/^(\d+)-(\d+)$/);
      if (m) {
        const [, a, b] = m;
        const eps = [];
        for (let i = +a; i <= +b; i++) eps.push(i);
        return { label: `${a}-${b}화`, episodes: eps };
      }
      const n = parseInt(token, 10);
      return isNaN(n) ? null : { label: `${n}화`, episodes: [n] };
    }).filter(Boolean);
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
      result.push({ groupLabel: group.label, episodes: group.episodes, startDate: cursor, endDate: groupEnd, opSchedule });
      // 다음 그룹 시작: 이 그룹 마감 익일 + gapDays
      cursor = addDays(groupEnd, 1 + gapDays);
    }
    return result;
  }

  // ── TOTUS: projectUuid 조회 ────────────────────────────────────────
  async function _getProjectUuid(workName) {
    try {
      const res  = await fetch(`${BASE()}/api/v1/projects?name=${encodeURIComponent(workName)}`, {
        headers: { Authorization: `Bearer ${TOKEN()}` },
      });
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
    const { workName, calculatedSchedule, opList, opDurations, gapDays, draftId } = draft;
    const durSummary = (opList || [])
      .filter(op => (opDurations[op.opCode] || 0) > 0)
      .map(op => `${op.opName} ${opDurations[op.opCode]}일`)
      .join(" · ");
    const totalEps = (calculatedSchedule || []).reduce((s, g) => s + g.episodes.length, 0);

    const blocks = [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*📋 ${workName} — 일정 시뮬레이션*\n${durSummary} · 그룹간 갭 ${gapDays}일` },
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
        const nextStart = addDays(group.endDate, 1 + gapDays);
        lines.push(`↓ 다음 그룹: ${toMD(group.endDate)} 익일 + 갭 ${gapDays}일 = ${toMD(nextStart)}`);
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
  function buildModalAView(draftId, dmChannelId) {
    return {
      type: "modal",
      callback_id: "schbulk_step1",
      private_metadata: JSON.stringify({ draftId, dmChannelId }),
      title: { type: "plain_text", text: "일정 일괄 변경" },
      submit: { type: "plain_text", text: "다음 →" },
      close:  { type: "plain_text", text: "취소" },
      blocks: [
        {
          type: "input", block_id: "work_name",
          label: { type: "plain_text", text: "작품명" },
          element: { type: "plain_text_input", action_id: "value", placeholder: { type: "plain_text", text: "예: 二つの世界の主人公" } },
        },
        {
          type: "input", block_id: "groups_text",
          label: { type: "plain_text", text: "회차 그룹 구분" },
          element: { type: "plain_text_input", action_id: "value", placeholder: { type: "plain_text", text: "예: 1-4, 5-8, 9-10" } },
          hint: { type: "plain_text", text: "쉼표로 구분, 연속 회차는 대시 (1-4 = 1·2·3·4화)" },
        },
        {
          type: "input", block_id: "first_start",
          label: { type: "plain_text", text: "첫 번째 그룹 시작일" },
          element: { type: "datepicker", action_id: "value" },
        },
        {
          type: "input", block_id: "gap_days",
          label: { type: "plain_text", text: "그룹간 갭 (일)" },
          element: { type: "number_input", is_decimal_allowed: false, action_id: "value", initial_value: "7", min_value: "0", max_value: "365" },
          hint: { type: "plain_text", text: "직전 그룹 마지막 날 익일 + N일 = 다음 그룹 시작일" },
        },
      ],
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

  // ══════════════════════════════════════════════════════════════════
  // Action: "일정 일괄 변경" 버튼 → Modal A 열기
  // ══════════════════════════════════════════════════════════════════
  app.action("schbulk_open_basic_modal", async ({ ack, body, client }) => {
    await ack();
    try {
      const dmRes = await client.conversations.open({ users: body.user.id });
      const dmChannelId = dmRes.channel.id;
      const draftId = generateDraftId();
      draftStore.set(draftId, { draftId, dmChannelId, userId: body.user.id });
      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildModalAView(draftId, dmChannelId),
      });
    } catch (e) {
      console.error("[scheduleBulk] open_basic_modal 오류:", e.message);
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // View: Modal A submit → TOTUS 조회 → Modal B (update)
  // 로딩 모달을 trigger_id로 먼저 열고, 조회 완료 후 Modal B로 update
  // ══════════════════════════════════════════════════════════════════
  app.view("schbulk_step1", async ({ ack, body, view, client }) => {
    await ack();
    const { draftId, dmChannelId } = JSON.parse(view.private_metadata || "{}");
    const v = view.state.values;

    const workName   = v.work_name?.value?.value?.trim()    || "";
    const groupsText = v.groups_text?.value?.value?.trim()  || "";
    const firstStart = v.first_start?.value?.selected_date  || "";
    const gapDays    = parseInt(v.gap_days?.value?.value    || "7", 10);

    const groups = parseGroups(groupsText);
    if (!groups.length || !workName || !firstStart) return;

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
      const projectUuid = await _getProjectUuid(workName);
      if (!projectUuid) {
        const errView = {
          type: "modal", title: { type: "plain_text", text: "오류" },
          blocks: [{ type: "section", text: { type: "mrkdwn", text: `⚠️ *${workName}* 프로젝트를 찾지 못했어. 작품명을 확인해줘.` } }],
        };
        if (loadingViewId) await client.views.update({ view_id: loadingViewId, view: errView }).catch(() => {});
        else await client.chat.postMessage({ channel: dmChannelId, text: `⚠️ TOTUS에서 *${workName}* 프로젝트를 찾지 못했어.` });
        return;
      }

      // 각 그룹 첫 회차에서 오퍼레이션 조회 (병렬 + union)
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
        if (loadingViewId) await client.views.update({ view_id: loadingViewId, view: errView }).catch(() => {});
        return;
      }

      // draft 업데이트
      const prev = draftStore.get(draftId) || {};
      draftStore.set(draftId, { ...prev, workName, projectUuid, groups, firstStart, gapDays, opList });

      // 로딩 모달 → Modal B
      const modalB = buildModalBView(draftId, opList);
      if (loadingViewId) {
        await client.views.update({ view_id: loadingViewId, view: modalB }).catch(() => {});
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
        await client.chat.postMessage({ channel: dmChannelId, text: `⚠️ 처리 중 오류: ${e.message}` }).catch(() => {});
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
    await client.chat.postMessage({ channel: draft.dmChannelId, text: "⏳ TOTUS에 일정 반영 중..." });
    await _applySchedule(draft, client).catch(async e => {
      await client.chat.postMessage({ channel: draft.dmChannelId, text: `⚠️ 반영 중 오류: ${e.message}` });
    });
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

    await client.chat.postMessage({ channel: draft.dmChannelId, text: "⏳ TOTUS에 일정 반영 중..." });
    await _applySchedule({ ...draft, calculatedSchedule: updatedSchedule }, client).catch(async e => {
      await client.chat.postMessage({ channel: draft.dmChannelId, text: `⚠️ 반영 중 오류: ${e.message}` });
    });
  });
};
