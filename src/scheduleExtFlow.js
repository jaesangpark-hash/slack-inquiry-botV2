// ══════════════════════════════════════════════════════════════════
// scheduleExtFlow.js — 스케줄 연장 플로우
// app.js 에서 require("./scheduleExtFlow")(app, { ai, GEMINI_MODEL, matchWorkTitleFromSheet,
//   generateDraftId, draftStore, fetchDeliveryDate }) 로 호출
// ══════════════════════════════════════════════════════════════════

module.exports = function registerScheduleExtFlow(app, {
  ai, GEMINI_MODEL, matchWorkTitleFromSheet, generateDraftId, draftStore,
  fetchDeliveryDate, sheetsClient,
}) {

  const BASE  = () => process.env.PLATFORM_API_URL;
  const TOKEN = () => process.env.PLATFORM_API_TOKEN;
  const { loggedCall } = require("./apiLogger");

  async function _apiFetch(url, options = {}, meta = {}) {
    return loggedCall(async () => {
      const res  = await fetch(url, options);
      const json = await res.json();
      return json;
    }, meta);
  }
  const SCHEDULE_CHANNEL_ID = () => process.env.SCHEDULE_CHANNEL_ID;
  const PM_SLACK_ID         = () => process.env.PM_SLACK_ID;

  const WORKER_SHEET_ID    = process.env.WORKER_SHEET_ID;
  const WORKER_SHEET_RANGE = process.env.WORKER_SHEET_RANGE;
  const workerSheetCache   = { loadedAt: 0, rows: [] };

  // 납품검수 오퍼레이션 코드 — 항상 제외
  const EXCLUDE_OP_CODES = new Set(["OTC0087", "OTC0077"]); // 납품검수, 피코마검수 제외

  // ── 작업자 시트 조회 (5분 캐시) ──────────────────────────
  async function _getWorkerInfo(email) {
    try {
      if (Date.now() - workerSheetCache.loadedAt > 300000 || !workerSheetCache.rows.length) {
        const res    = await sheetsClient.getValues(WORKER_SHEET_ID, WORKER_SHEET_RANGE);
        workerSheetCache.rows     = (res || []).slice(1);
        workerSheetCache.loadedAt = Date.now();
      }
      const found = workerSheetCache.rows.find(row => (row[1] || "").trim().toLowerCase() === email.toLowerCase());
      return found ? { channelId: found[3]?.trim() || null, slackIds: found[2]?.trim() || null } : null;
    } catch (e) {
      console.error("[scheduleExt] 작업자 시트 조회 실패:", e.message);
      return null;
    }
  }

  // ── Totus: projectUuid 조회 ───────────────────────────────
  async function _getProjectUuid(pivoId) {
    const json = await _apiFetch(`${BASE()}/api/v1/projects?pivoId=${encodeURIComponent(pivoId)}`, {
      headers: { Authorization: `Bearer ${TOKEN()}` },
    }, { bot: "schedule", endpoint: "/projects", params: { pivoId }, expectedCount: 1 });
    if (!json.success) return null;
    const proj = (json.data || []).find(p => {
      const d = p._detail || p;
      return d.진행상태 !== "CANCELED" && d.pivoId != null;
    });
    return proj?.uuid || null;
  }

  // ── Totus: JOB 전체 조회 → 회차 필터 ─────────────────────
  async function _getJobTasks(projectUuid, episode) {
    const json = await _apiFetch(`${BASE()}/api/v1/projects/${projectUuid}/jobs?episode=${parseInt(episode, 10)}`, {
      headers: { Authorization: `Bearer ${TOKEN()}` },
    }, { bot: "schedule", endpoint: "/projects/{uuid}/jobs", params: { episode }, expectedCount: 1 });
    if (!json.success) return null;
    // jobs API가 episode 서버 사이드 필터 지원 → 첫 번째 JOB 사용
    const job = (json.data || [])[0] || null;
    if (!job) return null;

  // 일정 변경 불필요한 상태 제외
  const EXCLUDE_TASK_STATES = new Set(["COMPLETED", "DROP", "DELIVERED", "CONFIRMED"]);

    // 오퍼레이션 평탄화
    const tasks = [];
    for (const op of (job.오퍼레이션 || [])) {
      for (const task of (op.태스크 || [])) {
        if (EXCLUDE_OP_CODES.has(task.오퍼레이션유형)) continue; // 납품검수 제외
        if (!task.작업자) continue; // 작업자 미배정 제외
        if (EXCLUDE_TASK_STATES.has(task.상태)) continue; // 완료/취소/제출 제외
        tasks.push({
          taskUuid:      task.uuid,
          opCode:        task.오퍼레이션유형,
          opName:        task.오퍼레이션유형명,
          workerEmail:   task.작업자?.이메일 || null,
          workerName:    task.작업자?.bid    || null,
          startDateOrig: task.시작일원본 || null,
          endDateOrig:   task.마감일원본 || null,
          startDateDisp: task.시작일 || null,  // YYYY.MM.DD
          endDateDisp:   task.마감일 || null,
        });
      }
    }
    return tasks;
  }

  // ── 날짜 유틸 ────────────────────────────────────────────
  function addDays(isoDate, days) {
    if (!isoDate) return null;
    const d = new Date(isoDate);
    d.setDate(d.getDate() + days);
    return d.toISOString();
  }

  function toDisplayDate(isoDate) {
    if (!isoDate) return "-";
    const d = new Date(isoDate);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${mm}-${dd}`;
  }

  function toApiDate(isoDate) {
    if (!isoDate) return null;
    return new Date(isoDate).toISOString().slice(0, 10); // YYYY-MM-DD
  }

  function isAfter(isoA, deliveryDateStr) {
    // deliveryDateStr: "2026-04-30" 또는 "2026.04.30"
    if (!isoA || !deliveryDateStr) return false;
    const a = new Date(isoA);
    const b = new Date(deliveryDateStr.replace(/\./g, "-"));
    return a > b;
  }

  // ── 화수 라벨 ────────────────────────────────────────────
  // [4,5,6] → "4-6화" / [4,6] → "4, 6화" / [5] → "5화"
  function _formatEpisodeLabel(episodes) {
    if (!episodes || !episodes.length) return "-";
    const nums = episodes.map(e => parseInt(e, 10)).filter(n => !isNaN(n)).sort((a, b) => a - b);
    if (!nums.length) return episodes.map(e => `${e}화`).join(", ");
    if (nums.length === 1) return `${nums[0]}화`;
    const contiguous = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
    if (contiguous) return `${nums[0]}-${nums[nums.length - 1]}화`;
    return nums.map(n => `${n}화`).join(", ");
  }

  // ── task 시그니처 (opCode|email|시작일|마감일 정렬 후 결합) ─
  // 화수 묶음 시 동일 일정인지 판단에 사용
  function _taskSignature(tasks) {
    if (!tasks || !tasks.length) return "";
    return tasks
      .map(t => `${t.opCode}|${(t.workerEmail || "").toLowerCase()}|${t.startDateOrig || ""}|${t.endDateOrig || ""}`)
      .sort()
      .join(":::");
  }

  // ── 화수 묶음 호환성 판정 ─────────────────────────────────
  // 두 화수를 한 카드로 묶어도 되는 기준 (작성자 합의 SSOT):
  //   ① 납품일(납품 시트 G열값)이 같음
  //   ② 공통으로 존재하는 오퍼레이션의 작업자(이메일 전체)가 동일인
  //   ③ 오퍼 개수가 달라도 겹치는 오퍼만 일치하면 OK (시작/마감일은 비교하지 않음)
  // 비추이적(예: A·B 호환, B·C 호환이라도 A·C 비호환 가능)이라 그리디 클러스터에서 쌍별로 호출.
  function _episodesCompatible(tasksA, tasksB, deliveryA, deliveryB) {
    // ① 납품일 — 둘 다 유효하고 같아야 함 (미상이면 묶지 않음)
    if (!deliveryA || !deliveryB || deliveryA === "확인 불가" || deliveryB === "확인 불가") return false;
    if (deliveryA !== deliveryB) return false;
    // ②③ 공통 오퍼코드의 작업자 이메일 일치 + 겹치는 오퍼 1개 이상
    const mapB = new Map((tasksB || []).map(t => [t.opCode, (t.workerEmail || "").toLowerCase()]));
    let shared = 0;
    for (const t of (tasksA || [])) {
      if (mapB.has(t.opCode)) {
        shared++;
        if (mapB.get(t.opCode) !== (t.workerEmail || "").toLowerCase()) return false;
      }
    }
    return shared > 0;
  }

  // ── 여러 화수의 납품일 조회 (연속 범위면 한 번에) ─────────
  async function _fetchDeliveryForEpisodes(workNameKo, projectName, episodes) {
    const sorted = [...episodes].map(e => parseInt(e, 10)).filter(n => !isNaN(n)).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const isContiguous = sorted.every((ep, i) => i === 0 || ep === sorted[i - 1] + 1);
    const rangeStr = isContiguous && sorted.length > 1
      ? `${sorted[0]}-${sorted[sorted.length - 1]}`
      : String(sorted[0]);
    return await fetchDeliveryDate(workNameKo, rangeStr, "zh-ja", projectName).catch(() => null);
  }

  // ── 슬랙 멘션 텍스트 생성 ────────────────────────────────
  async function _getMentionText(email) {
    const info = await _getWorkerInfo(email).catch(() => null);
    if (!info?.slackIds) return null;
    return info.slackIds.split(",").map(id => `<@${id.trim()}>`).join(" ");
  }

  async function _getChannelId(email) {
    const info = await _getWorkerInfo(email).catch(() => null);
    return info?.channelId || null;
  }

  // ══════════════════════════════════════════════════════════
  // 메인 진입: 단일 화수 — 스케줄 연장 플로우 시작
  // parsed: parseScheduleInquiry 결과 (extend_days, work_title_*, episode 등)
  // matchedTitle: matchWorkTitleFromSheet 결과
  // delivery: fetchDeliveryDate 결과
  // ══════════════════════════════════════════════════════════
  async function handleScheduleExt(client, dmChannel, parsed, matchedTitle, delivery, sourceLink) {
    const pivoId   = matchedTitle?.pivoId || null;
    const workName = matchedTitle?.projectName || matchedTitle?.projectName || parsed.work_title_ko || parsed.work_title_ja || "-";
    const episode  = parsed.episode || null;
    const requesterUserId = parsed.requesterUserId || null;

    // 연장 일수 파싱 — extend_days 없으면 requested_date로 대체, 둘 다 없으면 수동 입력
    const extDays      = parsed.extend_days ? parseInt(parsed.extend_days, 10) : null;
    const requestedDate = parsed.requested_date || null; // YYYY-MM-DD
    if (((!extDays || isNaN(extDays)) && !requestedDate) || !episode) {
      const pendingId = `schext_pending_${Date.now()}`;
      draftStore.set(pendingId, {
        type: "schext_pending",
        workName, pivoId, episode,
        episodes: episode ? [parseInt(episode, 10)] : [],
        delivery, sourceLink,
        requesterUserId,
        originalChannelId: parsed.originalChannelId || null,
        originalTs:        parsed.originalTs        || null,
        dmChannelId: dmChannel,
      });
      await client.chat.postMessage({
        channel: dmChannel,
        text: !episode ? "회차 또는 연장 일수를 특정할 수 없어. 직접 입력해줘." : "연장 일수를 특정할 수 없어. 직접 입력해줘.",
        blocks: [
          { type: "section", text: { type: "mrkdwn",
            text: `*📅 일정 연장 요청*\n*작품명:* ${workName}　*회차:* ${episode}화\n⚠️ 연장 일수를 특정할 수 없어. 직접 입력해줘.` } },
          { type: "actions", elements: [
            { type: "button", action_id: "schext_open_days_modal",
              text: { type: "plain_text", text: "연장 일수 입력" },
              style: "primary", value: pendingId },
          ]},
        ],
      });
      return;
    }

    await _proceedScheduleExt(client, dmChannel, {
      workName, pivoId,
      episodes: [parseInt(episode, 10)],
      extDays: extDays || null, requestedDate, delivery, sourceLink, requesterUserId,
      originalChannelId: parsed.originalChannelId || null,
      originalTs:        parsed.originalTs        || null,
    });
  }

  // ══════════════════════════════════════════════════════════
  // 묶음 진입: 복수 문의 다건 스케줄을 받아 시그니처 동일한 화수끼리 묶음 처리
  // items: [{ episode, parsed, matchedTitle, delivery, sourceLink,
  //          originalChannelId, originalTs, requesterUserId }, ...]
  // 동일 작품(pivoId) + 동일 연장 요청(extend_days/requested_date) 가정
  // 시그니처 (시작일/마감일/작업자 이메일) 모두 일치 → 묶음 / 불일치 → 개별
  // ══════════════════════════════════════════════════════════
  async function handleScheduleExtGrouped(client, dmChannel, items) {
    if (!items || items.length === 0) return;

    // 단일 fallback 시 납품일이 비어 있으면 채워주는 헬퍼
    const _fillDelivery = async (it) => {
      if (it.delivery) return it.delivery;
      const workNameKo = it.matchedTitle?.projectName || it.parsed?.work_title_ko;
      if (!workNameKo || !it.episode) return null;
      return await fetchDeliveryDate(workNameKo, String(it.episode), "zh-ja", it.matchedTitle?.projectName || null).catch(() => null);
    };
    const _runSingle = async (it) => {
      const delivery = await _fillDelivery(it);
      await handleScheduleExt(client, dmChannel, it.parsed, it.matchedTitle, delivery, it.sourceLink);
    };

    // 1건이면 그냥 단일 처리
    if (items.length === 1) {
      return _runSingle(items[0]);
    }

    const first  = items[0];
    const pivoId = first.matchedTitle?.pivoId || null;

    // pivoId 없으면 묶음 불가 → 각자 단일 처리
    if (!pivoId) {
      for (const it of items) await _runSingle(it);
      return;
    }

    // 모든 화수의 task 일괄 조회
    let projectUuid = null;
    try { projectUuid = await _getProjectUuid(pivoId); } catch (_) {}

    if (!projectUuid) {
      for (const it of items) await _runSingle(it);
      return;
    }

    // 화수별 task + 납품일(납품 시트) 일괄 조회 — 납품일은 묶음 조건① 비교용
    const tasksByEp    = {};
    const deliveryByEp = {};
    await Promise.all(items.map(async (it) => {
      const ep = parseInt(it.episode, 10);
      if (isNaN(ep)) return;
      try {
        const t = await _getJobTasks(projectUuid, ep);
        if (t && t.length > 0) tasksByEp[ep] = t;
      } catch (e) { console.warn("[scheduleExt] _getJobTasks 실패:", ep, e.message); }
      try {
        const workNameKo = it.matchedTitle?.projectName || it.parsed?.work_title_ko;
        const d = workNameKo
          ? await fetchDeliveryDate(workNameKo, String(ep), "zh-ja", it.matchedTitle?.projectName || null)
          : null;
        deliveryByEp[ep] = d?.episodes?.[0]?.deliveryDate || d?.deliveryDate || null;
      } catch (e) { console.warn("[scheduleExt] 납품일 조회 실패:", ep, e.message); }
    }));

    // task 없는 화수는 개별 처리, 나머지는 호환성 클러스터링 대상
    const noTasksItems = [];
    const withTasks    = [];
    for (const it of items) {
      const ep = parseInt(it.episode, 10);
      if (!tasksByEp[ep]) { noTasksItems.push(it); continue; }
      withTasks.push({ it, ep });
    }
    for (const it of noTasksItems) await _runSingle(it);

    // ── 묶음 클러스터링 (조건①②③ — _episodesCompatible) ──────
    // 시그니처 완전일치가 아니라 "납품일 같음 + 공통 오퍼 동일인" 호환성 기준.
    // 비추이적이라 그리디: 새 화수는 기존 클러스터의 "모든" 멤버와 호환될 때만 합류.
    withTasks.sort((a, b) => a.ep - b.ep);
    const clusters = []; // [{ it, ep }[], ...]
    for (const cur of withTasks) {
      let placed = false;
      for (const cl of clusters) {
        if (cl.every(m => _episodesCompatible(tasksByEp[cur.ep], tasksByEp[m.ep], deliveryByEp[cur.ep], deliveryByEp[m.ep]))) {
          cl.push(cur); placed = true; break;
        }
      }
      if (!placed) clusters.push([cur]);
    }

    // 클러스터 처리 (병렬) — 1건이면 단일, 2건+면 묶음
    const groupPromises = clusters.map(async (cluster) => {
      if (cluster.length === 1) {
        await _runSingle(cluster[0].it);
        return;
      }

      const groupItems = cluster.map(c => c.it);
      const f          = groupItems[0];
      const episodes   = cluster.map(c => c.ep).sort((a, b) => a - b);
      const groupTasksByEp = Object.fromEntries(episodes.map(ep => [ep, tasksByEp[ep]]));
      const workName   = f.matchedTitle?.projectName || f.parsed.work_title_ko || f.parsed.work_title_ja || "-";
      const workNameKo = f.matchedTitle?.projectName || f.matchedTitle?.ko || f.parsed.work_title_ko || workName;

      // 묶음 납품일 재조회 (연속 범위면 한 번에)
      const mergedDelivery = await _fetchDeliveryForEpisodes(workNameKo, f.matchedTitle?.projectName || null, episodes);

      await _proceedScheduleExt(client, dmChannel, {
        workName, pivoId,
        episodes,
        extDays: f.parsed.extend_days ? parseInt(f.parsed.extend_days, 10) : null,
        requestedDate: f.parsed.requested_date || null,
        delivery: mergedDelivery || f.delivery,
        sourceLink: f.sourceLink,
        originalChannelId: f.originalChannelId || f.parsed.originalChannelId || null,
        originalTs:        f.originalTs        || f.parsed.originalTs        || null,
        requesterUserId:   f.requesterUserId   || f.parsed.requesterUserId   || null,
        preFetchedTasksByEpisode: groupTasksByEp,
        preFetchedProjectUuid:    projectUuid,
        preValidatedBatch:        true,
      });
    });

    await Promise.all(groupPromises);
  }

  // ── 연장 일수 수동 입력 모달 ─────────────────────────────
  app.action("schext_open_days_modal", async ({ ack, body, client }) => {
    await ack();
    const pending = draftStore.get(body.actions[0].value);
    if (!pending) return;
    const needsEpisode = !pending.episode;
    const modalBlocks = [
      { type: "section", text: { type: "mrkdwn",
        text: `*${pending.workName}${pending.episode ? ` ${pending.episode}화` : ""}*` } },
    ];
    if (needsEpisode) {
      modalBlocks.push({
        type: "input", block_id: "ext_episode_block",
        label: { type: "plain_text", text: "회차 (숫자만)" },
        element: { type: "plain_text_input", action_id: "value",
          placeholder: { type: "plain_text", text: "예: 130" } },
      });
    }
    modalBlocks.push({
      type: "input", block_id: "ext_days_block",
      label: { type: "plain_text", text: "연장 일수 (숫자만)" },
      element: { type: "plain_text_input", action_id: "value",
        placeholder: { type: "plain_text", text: "예: 3" } },
    });
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal", callback_id: "schext_days_modal_submit",
        private_metadata: JSON.stringify({ pendingId: body.actions[0].value }),
        title:  { type: "plain_text", text: "연장 일수 입력" },
        submit: { type: "plain_text", text: "확인" },
        close:  { type: "plain_text", text: "취소" },
        blocks: modalBlocks,
      },
    });
  });

  app.view("schext_days_modal_submit", async ({ ack, body, view, client }) => {
    await ack();
    const { pendingId } = JSON.parse(view.private_metadata || "{}");
    const pending = draftStore.get(pendingId);
    if (!pending) return;
    const extDays = parseInt(view.state.values.ext_days_block?.value?.value?.trim() || "", 10);
    if (!extDays || isNaN(extDays)) {
      await client.chat.postMessage({ channel: pending.dmChannelId, text: "⚠️ 숫자만 입력해줘." });
      return;
    }
    const episodeInput = view.state.values.ext_episode_block?.value?.value?.trim() || null;
    const episode = episodeInput || pending.episode || null;
    if (!episode) {
      await client.chat.postMessage({ channel: pending.dmChannelId, text: "⚠️ 회차를 입력해줘." });
      return;
    }
    draftStore.delete(pendingId);
    // 회차를 직접 입력했으면 그 화수만, 아니면 묶음(pending.episodes) 유지
    const episodes = episodeInput
      ? [parseInt(episodeInput, 10)]
      : (pending.episodes && pending.episodes.length ? pending.episodes : [parseInt(episode, 10)]);
    await _proceedScheduleExt(client, pending.dmChannelId, {
      ...pending,
      extDays,
      episodes,
    });
  });

  // ── 핵심 처리: 일정 시뮬레이션 + 1단계 메시지 ───────────
  // info.episodes (number[]) — 단일 또는 묶음
  // info.preFetchedTasksByEpisode (옵션) — handleScheduleExtGrouped가 미리 조회한 결과
  async function _proceedScheduleExt(client, dmChannel, info) {
    const { workName, pivoId, delivery, sourceLink,
            originalChannelId, originalTs, requesterUserId,
            requestedDate, isDirectCall } = info;
    let extDays = info.extDays || null;

    // 화수 배열 정규화
    const episodes = Array.isArray(info.episodes) && info.episodes.length
      ? info.episodes.map(e => parseInt(e, 10)).filter(n => !isNaN(n)).sort((a, b) => a - b)
      : (info.episode ? [parseInt(info.episode, 10)] : []);
    if (!episodes.length) {
      await client.chat.postMessage({ channel: dmChannel, text: "⚠️ 회차를 특정할 수 없어. 직접 확인해줘." });
      return;
    }
    const episodeLabel = _formatEpisodeLabel(episodes);
    const isBatch      = episodes.length > 1;

    // Totus에서 JOB 태스크 조회 (이미 조회된 경우 재사용)
    let tasksByEpisode = info.preFetchedTasksByEpisode || null;
    if (!tasksByEpisode && pivoId) {
      tasksByEpisode = {};
      try {
        const projectUuid = info.preFetchedProjectUuid || await _getProjectUuid(pivoId);
        if (projectUuid) {
          await Promise.all(episodes.map(async (ep) => {
            const t = await _getJobTasks(projectUuid, ep);
            if (t && t.length > 0) tasksByEpisode[ep] = t;
          }));
        }
      } catch (e) {
        console.error("[scheduleExt] JOB 조회 실패:", e.message);
      }
    }

    // 어느 한 화수라도 task 없으면 실패
    const missingEps = episodes.filter(ep => !tasksByEpisode || !tasksByEpisode[ep] || tasksByEpisode[ep].length === 0);
    if (missingEps.length === episodes.length) {
      const pendingId = generateDraftId();
      draftStore.set(pendingId, { ...info, episodes, episodeLabel, dmChannelId: dmChannel });
      await client.chat.postMessage({ channel: dmChannel,
        text: `⚠️ ${workName} ${episodeLabel} 태스크를 Totus에서 찾을 수 없어.`,
        blocks: [
          { type: "section", text: { type: "mrkdwn",
            text: `⚠️ *${workName} ${episodeLabel}* 태스크를 Totus에서 찾을 수 없어.\nTotus를 확인한 후 재시도하거나 PIVO ID를 확인해줘.` } },
          { type: "actions", elements: [
            { type: "button", action_id: "schext_retry_proceed", style: "primary",
              text: { type: "plain_text", text: "🔄 재시도" },
              value: pendingId },
          ]},
        ],
      });
      return;
    }
    if (missingEps.length > 0) {
      await client.chat.postMessage({ channel: dmChannel,
        text: `⚠️ ${workName} ${missingEps.map(e => e + "화").join(", ")} 태스크를 Totus에서 찾을 수 없어. 나머지 화수만 처리할게.` });
      // 누락 화수 제외하고 진행
      const validEps = episodes.filter(ep => !missingEps.includes(ep));
      if (!validEps.length) return;
      episodes.length = 0;
      episodes.push(...validEps);
    }

    // 묶음 검증: 시그니처 재확인 (defensive)
    // preValidatedBatch=true 면 handleScheduleExtGrouped가 이미 호환성(납품일+공통 오퍼 동일인)으로
    // 묶은 것이므로 엄격 시그니처 재분할을 건너뛴다 (안 그러면 완화한 묶음이 여기서 도로 쪼개짐).
    const sigs = episodes.map(ep => _taskSignature(tasksByEpisode[ep]));
    const allSigSame = sigs.every(s => s === sigs[0]);
    if (isBatch && !info.preValidatedBatch && !allSigSame) {
      // 시그니처 불일치 시 — 단독으로 분리
      console.log("[scheduleExt] 묶음 검증 실패 — 화수별로 분리 처리");
      for (const ep of episodes) {
        await _proceedScheduleExt(client, dmChannel, {
          ...info,
          episodes: [ep],
          preFetchedTasksByEpisode: { [ep]: tasksByEpisode[ep] },
        });
      }
      return;
    }

    // 대표 tasks (시그니처 동일하므로 첫 번째 사용)
    const tasks = tasksByEpisode[episodes[0]];

    // ── 요청 작업자 특정: Slack 이메일 도메인 vs task 작업자 도메인 매칭 ──
    let requesterTaskIndex = null;
    if (requesterUserId) {
      try {
        const userInfo    = await app.client.users.info({ user: requesterUserId });
        const slackEmail = (userInfo.user?.profile?.email || "").toLowerCase();
        console.log(`[scheduleExt] 요청자 Slack 이메일: ${slackEmail}`);

        if (slackEmail) {
          const matched = tasks
            .map((t, i) => ({ i, email: (t.workerEmail || "").toLowerCase() }))
            .filter(x => x.email === slackEmail);

          if (matched.length === 1) {
            requesterTaskIndex = matched[0].i;
            console.log(`[scheduleExt] 요청 작업자 자동 특정 → index:${requesterTaskIndex} (${tasks[requesterTaskIndex].opName})`);
          } else {
            console.log(`[scheduleExt] 도메인 매칭 결과 ${matched.length}건 → 수동 선택 필요`);
          }
        }
      } catch (e) {
        console.warn("[scheduleExt] Slack 이메일 조회 실패:", e.message);
      }
    }

    // requestedDate 있고 extDays 없으면 → 마지막 태스크 마감일 기준으로 일수 계산
    if (!extDays && requestedDate) {
      const lastTaskEndDate = tasks[tasks.length - 1]?.endDateOrig;
      if (lastTaskEndDate) {
        const diff = Math.round(
          (new Date(requestedDate) - new Date(lastTaskEndDate.slice(0, 10))) / (1000 * 60 * 60 * 24)
        );
        console.log(`[scheduleExt] requestedDate(${requestedDate}) - lastEndDate(${lastTaskEndDate.slice(0,10)}) = diff:${diff}`);
        const _makePending = () => {
          const pendingId = `schext_pending_${Date.now()}`;
          draftStore.set(pendingId, { type: "schext_pending", workName, pivoId, episode: episodes[0], episodes, delivery, sourceLink, requesterUserId, originalChannelId, originalTs, dmChannelId: dmChannel });
          return pendingId;
        };
        if (diff === 0) {
          const pendingId = _makePending();
          await client.chat.postMessage({ channel: dmChannel,
            text: `ℹ️ *${workName} ${episodeLabel}* — 희망 마감일(${requestedDate})이 현재 마감일과 동일해. 연장이 필요 없는 것 같아.`,
            blocks: [
              { type: "section", text: { type: "mrkdwn",
                text: `ℹ️ *${workName} ${episodeLabel}*\n희망 마감일 *${requestedDate}* 이 현재 마감일과 동일해. 연장이 필요 없는 것 같아.` } },
              { type: "actions", elements: [
                { type: "button", action_id: "schext_open_days_modal",
                  text: { type: "plain_text", text: "연장 일수 직접 입력" },
                  style: "primary", value: pendingId },
                { type: "button", action_id: "schext_cancel",
                  text: { type: "plain_text", text: "종료" }, value: "cancel" },
              ]},
            ],
          });
          return;
        }
        if (diff < 0) {
          const pendingId = _makePending();
          await client.chat.postMessage({ channel: dmChannel,
            text: `⚠️ *${workName} ${episodeLabel}* — 희망 마감일(${requestedDate})이 현재 마감일(${lastTaskEndDate.slice(0,10)})보다 이전이야. 문의 내용을 확인해줘.`,
            blocks: [
              { type: "section", text: { type: "mrkdwn",
                text: `⚠️ *${workName} ${episodeLabel}*\n희망 마감일 *${requestedDate}* 이 현재 마감일 *${lastTaskEndDate.slice(0,10)}* 보다 이전이야. 문의 내용이 맞는지 확인해줘.` } },
              { type: "actions", elements: [
                { type: "button", action_id: "schext_open_days_modal",
                  text: { type: "plain_text", text: "연장 일수 직접 입력" },
                  style: "primary", value: pendingId },
                { type: "button", action_id: "schext_cancel",
                  text: { type: "plain_text", text: "종료" }, value: "cancel" },
              ]},
            ],
          });
          return;
        }
        extDays = diff;
      }
    }

    if (!extDays || extDays <= 0) {
      // 자동 계산 실패(파싱 불가/희망일 없음 등) — 버튼으로 직접 입력받기.
      // 묶음(episodes 여러 개)이면 이미 조회·검증한 tasksByEpisode를 그대로 넘겨 재진입 시 재조회/재분할 방지.
      const pendingId = `schext_pending_${Date.now()}`;
      draftStore.set(pendingId, {
        type: "schext_pending",
        workName, pivoId,
        episode: episodes[0], episodes,
        delivery, sourceLink, requesterUserId,
        originalChannelId, originalTs,
        dmChannelId: dmChannel,
        preFetchedTasksByEpisode: tasksByEpisode,
        preFetchedProjectUuid:    info.preFetchedProjectUuid || null,
        preValidatedBatch:        !!info.preValidatedBatch,
      });
      await client.chat.postMessage({
        channel: dmChannel,
        text: `${workName} ${episodeLabel} — 연장 일수를 특정할 수 없어. 직접 입력해줘.`,
        blocks: [
          { type: "section", text: { type: "mrkdwn",
            text: `*📅 일정 연장 요청*\n*작품명:* ${workName}　*회차:* ${episodeLabel}\n⚠️ 연장 일수를 자동으로 계산하지 못했어. 직접 입력해줘.` } },
          { type: "actions", elements: [
            { type: "button", action_id: "schext_open_days_modal",
              text: { type: "plain_text", text: "연장 일수 입력" },
              style: "primary", value: pendingId },
          ]},
        ],
      });
      return;
    }

    // 연장 시뮬레이션: requesterTaskIndex 이후 오퍼레이션만 연장, 이전은 그대로
    const fromIdx = requesterTaskIndex !== null ? requesterTaskIndex : 0;
    const simTasks = tasks.map((t, i) => ({
      ...t,
      newStartDateOrig: i >= fromIdx ? addDays(t.startDateOrig, extDays) : t.startDateOrig,
      newEndDateOrig:   i >= fromIdx ? addDays(t.endDateOrig,   extDays) : t.endDateOrig,
    }));

    // 납품일 초과 여부
    const deliveryDateStr = delivery?.allSame ? delivery.deliveryDate : null;
    const lastEndDate     = simTasks[simTasks.length - 1]?.newEndDateOrig;
    const isOverDelivery  = deliveryDateStr ? isAfter(lastEndDate, deliveryDateStr) : false;

    const draftId = generateDraftId();
    draftStore.set(draftId, {
      type: "schext",
      workName, pivoId,
      episode: episodes[0],   // backward-compat
      episodes,
      episodeLabel,
      extDays,
      delivery, sourceLink,
      originalChannelId, originalTs, requesterUserId,
      dmChannelId: dmChannel,
      tasks,                  // 대표 (시그니처 동일)
      tasksByEpisode,         // 전체 (apply 시 사용)
      simTasks,
      isOverDelivery,
      deliveryDateStr,
      requesterTaskIndex,
      isDirectCall: !!isDirectCall,
    });

    // 텍스트 직접 소환 → 요청 작업자 선택 건너뛰고 2단계(전체 오퍼레이션 수정)로 바로
    if (isDirectCall) {
      await _sendStep2(client, dmChannel, draftId);
      return;
    }

    // 도메인 매칭 실패 → 수동 선택 메시지 먼저
    if (requesterTaskIndex === null) {
      await _sendRequesterSelectMsg(client, dmChannel, draftId);
      return;
    }

    await _sendStep1(client, dmChannel, draftId);
  }

  // ── 요청 작업자 수동 선택 메시지 (도메인 불일치 시) ─────
  async function _sendRequesterSelectMsg(client, dmChannel, draftId) {
    const data = draftStore.get(draftId);
    const { workName, episodeLabel, tasks } = data;

    const elements = tasks.map((t, i) => ({
      type: "button",
      action_id: `schext_select_requester_${i}`,
      text: { type: "plain_text", text: `${t.opName}` },
      value: JSON.stringify({ draftId, taskIndex: i }),
    }));

    const taskLines = tasks.map(t =>
      `・ *${t.opName}*　${toDisplayDate(t.startDateOrig)}~${toDisplayDate(t.endDateOrig)}　${t.workerEmail || "-"}`
    ).join("\n");

    const batchNote = data.episodes && data.episodes.length > 1
      ? `\n_${data.episodes.length}개 화수 동일 일정 묶음 처리_`
      : "";

    await client.chat.postMessage({
      channel: dmChannel,
      text: "요청 작업자를 선택해줘.",
      blocks: [
        { type: "section", text: { type: "mrkdwn",
          text: `*📋 ${workName} ${episodeLabel} — 요청 작업자를 선택해줘.*
작업자 도메인이 일치하지 않아 직접 선택이 필요해.${batchNote}

${taskLines}` } },
        { type: "actions", elements },
      ],
    });
  }

  // ── 요청 작업자 선택 버튼 ────────────────────────────────
  app.action(/^schext_select_requester_\d+$/, async ({ ack, body, client }) => {
    await ack();
    const { draftId, taskIndex } = JSON.parse(body.actions[0].value || "{}");
    const data = draftStore.get(draftId);
    if (!data) return;
    draftStore.set(draftId, { ...data, requesterTaskIndex: taskIndex });
    console.log(`[scheduleExt] 요청 작업자 수동 선택 → index:${taskIndex} (${data.tasks[taskIndex].opName})`);
    await _sendStep1(client, data.dmChannelId, draftId);
  });

  // ── 1단계 메시지 전송 ────────────────────────────────────
  async function _sendStep1(client, dmChannel, draftId) {
    const data = draftStore.get(draftId);
    const { workName, episodeLabel, extDays, tasks, isOverDelivery, deliveryDateStr, requesterTaskIndex } = data;

    const currentLines = tasks.map((t, i) => {
      const marker = i === requesterTaskIndex ? "👤" : "・";
      return `${marker} ${t.opName.padEnd(6)}　${toDisplayDate(t.startDateOrig)} ~ ${toDisplayDate(t.endDateOrig)}　@${t.workerEmail?.split("@")[0] || "-"}`;
    }).join("\n");

    const statusText = isOverDelivery
      ? `⚠️ ${extDays}일 연장 시 납품일(${deliveryDateStr}) 초과 — 조정이 필요해.`
      : `✅ ${extDays}일 연장 시 납품일(${deliveryDateStr || "미확인"}) 내 완료 가능`;

    const batchNote = data.episodes && data.episodes.length > 1
      ? `\n・ 📚 묶음: ${data.episodes.length}개 화수 동일 일정`
      : "";

    await client.chat.postMessage({
      channel: dmChannel,
      text: `${workName} ${episodeLabel} 일정 연장 요청`,
      blocks: [
        { type: "section", text: { type: "mrkdwn",
          text: `*📋 ${workName} ${episodeLabel} — 일정 연장 요청*\n・ 🗓 납품예정일: ${deliveryDateStr || "확인 불가"}\n・ 📆 연장 요청: ${extDays}일\n・ 👤 요청 작업자: ${requesterTaskIndex !== null ? tasks[requesterTaskIndex].opName : "미확인"}${batchNote}${data.sourceLink ? `\n・ 🔗 <${data.sourceLink}|원문 링크>` : ""}` } },
        { type: "section", text: { type: "mrkdwn",
          text: `*현재 일정*\n${currentLines}` } },
        { type: "section", text: { type: "mrkdwn", text: statusText } },
        { type: "actions", elements: [
          { type: "button", action_id: "schext_confirm_step1",
            text: { type: "plain_text", text: "✅ 이대로 반영" },
            style: "primary", value: draftId },
          { type: "button", action_id: "schext_goto_step2",
            text: { type: "plain_text", text: "❌ 아니오 — 직접 조정" },
            value: draftId },
        ]},
      ],
    });
  }

  // ── [이대로 반영] → 일정 API 호출 ────────────────────────
  app.action("schext_confirm_step1", async ({ ack, body, client }) => {
    await ack();
    const draftId = body.actions[0].value;
    const data    = draftStore.get(draftId);
    if (!data) return;
    await _applySchedule(client, body.user.id, draftId, data.simTasks);
  });

  // ── [직접 조정] → 2단계 메시지 ───────────────────────────
  app.action("schext_goto_step2", async ({ ack, body, client }) => {
    await ack();
    const draftId = body.actions[0].value;
    const data    = draftStore.get(draftId);
    if (!data) return;
    await _sendStep2(client, data.dmChannelId, draftId);
  });

  // ── 2단계 메시지: 변경 전/후 비교 + 수정 버튼 ───────────
  async function _sendStep2(client, dmChannel, draftId) {
    const data = draftStore.get(draftId);
    const { workName, episodeLabel, simTasks, isOverDelivery, deliveryDateStr } = data;

    const overText = isOverDelivery
      ? `\n⚠️ 납품일(${deliveryDateStr}) 초과 — 수동으로 조정해줘.`
      : "";

    const batchNote = data.episodes && data.episodes.length > 1
      ? `\n_${data.episodes.length}개 화수에 동일하게 적용돼._`
      : "";

    const opBlocks = simTasks.map((t, i) => {
      const beforeStr = `${toDisplayDate(t.startDateOrig)}~${toDisplayDate(t.endDateOrig)}`;
      const afterStr  = `${toDisplayDate(t.newStartDateOrig)}~${toDisplayDate(t.newEndDateOrig)}`;
      const isOver    = deliveryDateStr ? isAfter(t.newEndDateOrig, deliveryDateStr) : false;
      const afterMark = isOver ? `~${afterStr}~ ⚠️` : afterStr;
      return {
        type: "section",
        text: { type: "mrkdwn",
          text: `・ *${t.opName}*　${beforeStr} → ${afterMark}` },
        accessory: {
          type: "button",
          action_id: `schext_edit_task_${i}`,
          text: { type: "plain_text", text: "✏️ 수정" },
          value: JSON.stringify({ draftId, taskIndex: i }),
        },
      };
    });

    await client.chat.postMessage({
      channel: dmChannel,
      text: `${workName} ${episodeLabel} 변경 후 일정 미리보기`,
      blocks: [
        { type: "section", text: { type: "mrkdwn",
          text: `*📋 ${workName} ${episodeLabel} — 변경 후 일정 미리보기*${batchNote}${overText}` } },
        ...opBlocks,
        { type: "divider" },
        { type: "actions", elements: [
          { type: "button", action_id: "schext_apply_all",
            text: { type: "plain_text", text: "✅ 일정 일괄 반영" },
            style: "primary", value: draftId },
          { type: "button", action_id: "schext_ask_pm",
            text: { type: "plain_text", text: "📢 PM에게 납품일 연장 요청" },
            value: draftId },
        ]},
      ],
    });
  }

  // ── [✏️ 수정] 버튼 → 1개짜리 모달 ───────────────────────
  app.action(/^schext_edit_task_\d+$/, async ({ ack, body, client }) => {
    await ack();
    const { draftId, taskIndex } = JSON.parse(body.actions[0].value || "{}");
    const data = draftStore.get(draftId);
    if (!data) return;
    const t = data.simTasks[taskIndex];

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal", callback_id: "schext_edit_task_modal_submit",
        private_metadata: JSON.stringify({ draftId, taskIndex }),
        title:  { type: "plain_text", text: `일정 수정 — ${t.opName}` },
        submit: { type: "plain_text", text: "저장" },
        close:  { type: "plain_text", text: "취소" },
        blocks: [
          { type: "input", block_id: "edit_start_block",
            label: { type: "plain_text", text: "시작일" },
            element: { type: "datepicker", action_id: "value",
              initial_date: toApiDate(t.newStartDateOrig) || toApiDate(t.startDateOrig),
              placeholder: { type: "plain_text", text: "날짜 선택" } } },
          { type: "input", block_id: "edit_end_block",
            label: { type: "plain_text", text: "마감일" },
            element: { type: "datepicker", action_id: "value",
              initial_date: toApiDate(t.newEndDateOrig) || toApiDate(t.endDateOrig),
              placeholder: { type: "plain_text", text: "날짜 선택" } } },
        ],
      },
    });
  });

  // ── 수정 모달 제출 → draftStore 업데이트 후 2단계 재렌더 ─
  app.view("schext_edit_task_modal_submit", async ({ ack, body, view, client }) => {
    await ack();
    const { draftId, taskIndex } = JSON.parse(view.private_metadata || "{}");
    const data = draftStore.get(draftId);
    if (!data) return;

    const newStart = view.state.values.edit_start_block?.value?.selected_date || "";
    const newEnd   = view.state.values.edit_end_block?.value?.selected_date   || "";

    // simTasks 업데이트 (API 미호출)
    const simTasks = [...data.simTasks];
    simTasks[taskIndex] = {
      ...simTasks[taskIndex],
      newStartDateOrig: newStart ? `${newStart}T00:00:00+09:00` : simTasks[taskIndex].newStartDateOrig,
      newEndDateOrig:   newEnd   ? `${newEnd}T23:59:59+09:00`   : simTasks[taskIndex].newEndDateOrig,
    };
    draftStore.set(draftId, { ...data, simTasks });

    // 2단계 메시지 새로 전송 (업데이트된 값 반영)
    await _sendStep2(client, data.dmChannelId, draftId);
  });

  // ── [일정 일괄 반영] ─────────────────────────────────────
  app.action("schext_apply_all", async ({ ack, body, client }) => {
    await ack();
    const draftId = body.actions[0].value;
    const data    = draftStore.get(draftId);
    if (!data) return;
    await _applySchedule(client, body.user.id, draftId, data.simTasks);
  });

  // ── TOTUS 태스크 조회 재시도 ──────────────────────────────
  app.action("schext_retry_proceed", async ({ ack, body, client }) => {
    await ack();
    const pendingId = body.actions[0].value;
    const pending   = draftStore.get(pendingId);
    if (!pending) return;
    draftStore.delete(pendingId);
    const { dmChannelId, ...info } = pending;
    await _proceedScheduleExt(client, dmChannelId, { ...info, preFetchedTasksByEpisode: null });
  });

  // ── 일정 API 호출 (공통) ──────────────────────────────────
  async function _applySchedule(client, userId, draftId, simTasks) {
    const data = draftStore.get(draftId);
    try {
      // 묶음/단일 공통: tasksByEpisode 전체 화수의 task에 simTasks 시뮬레이션 결과 매핑
      // simTasks의 인덱스 i는 대표 tasks(data.tasks)의 opCode 순서와 일치
      // 각 화수별 task에서 동일 opCode를 찾아 일괄 반영
      const apiTasks = [];
      const tasksByEp = data.tasksByEpisode || { [data.episodes?.[0] || data.episode]: data.tasks };
      const episodes  = data.episodes && data.episodes.length ? data.episodes : Object.keys(tasksByEp).map(Number);

      for (const ep of episodes) {
        const epTasks = tasksByEp[ep] || [];
        for (let i = 0; i < simTasks.length; i++) {
          const sim = simTasks[i];
          // opCode 매칭 (없으면 인덱스로 fallback)
          const matching = epTasks.find(t => t.opCode === data.tasks[i].opCode) || epTasks[i];
          if (matching) {
            apiTasks.push({
              taskUuid:  matching.taskUuid,
              startDate: sim.newStartDateOrig,
              endDate:   sim.newEndDateOrig,
            });
          }
        }
      }

      console.log(`[scheduleExt] 일괄 반영 — 화수:${episodes.length}, task:${apiTasks.length}`);

      const json = await _apiFetch(`${BASE()}/api/v1/tasks/dates`, {
        method:  "POST",
        headers: { Authorization: `Bearer ${TOKEN()}`, "Content-Type": "application/json" },
        body:    JSON.stringify({ tasks: apiTasks }),
      }, { bot: "schedule", endpoint: "/tasks/dates", params: {}, expectedCount: null });
      console.log("[scheduleExt] 일정 반영 응답:", JSON.stringify(json));

      if (json.data?.실패 > 0) {
        console.warn("[scheduleExt] 일정 반영 일부 실패:", JSON.stringify(json.data.failedTaskUuids));
      }

      // 완료 메시지
      const changeLines = simTasks.map(t =>
        `・ ${t.opName}　${toDisplayDate(t.startDateOrig)}~${toDisplayDate(t.endDateOrig)} → ${toDisplayDate(t.newStartDateOrig)}~${toDisplayDate(t.newEndDateOrig)}`
      ).join("\n");

      const isOver       = data.isOverDelivery;
      const overNote     = isOver ? `\n⚠️ 납품예정일(${data.deliveryDateStr}) 초과 — PM 확인이 필요해.` : `\n✅ 납품예정일(${data.deliveryDateStr || "미확인"}) 이내`;
      const completeMeta = JSON.stringify({ draftId });
      const batchNote    = data.episodes && data.episodes.length > 1
        ? `\n_${data.episodes.length}개 화수 일괄 반영됨_`
        : "";

      await client.chat.postMessage({
        channel: data.dmChannelId,
        text:    `✅ ${data.workName} ${data.episodeLabel} 일정 반영 완료`,
        blocks: [
          { type: "section", text: { type: "mrkdwn",
            text: `✅ *${data.workName} ${data.episodeLabel} 일정 반영 완료*${batchNote}${overNote}\n\n${changeLines}` } },
          { type: "context", elements: [
            { type: "mrkdwn", text: `처리자: <@${userId}> · ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}` },
          ]},
          { type: "actions", elements: [
            { type: "button", action_id: "schext_open_worker_msg_modal",
              text: { type: "plain_text", text: "💬 작업자에게 안내하기" },
              style: "primary", value: completeMeta },
            { type: "button", action_id: "schext_skip_worker_msg",
              text: { type: "plain_text", text: "건너뛰기" },
              value: completeMeta },
          ]},
        ],
      });

      // 납품 초과 시 PM 채널에도 자동 전송
      if (isOver) {
        await _sendPmNotice(client, userId, data, simTasks);
      }

    } catch (e) {
      console.error("[scheduleExt] 일정 반영 실패:", e.message);
      await client.chat.postMessage({ channel: data.dmChannelId,
        text: `❌ 일정 반영 실패: ${e.message}`,
        blocks: [
          { type: "section", text: { type: "mrkdwn",
            text: `❌ *일정 반영 실패*\n\`${e.message}\`\n\n초안은 유지되고 있어. 아래 버튼으로 재시도할 수 있어.` } },
          { type: "actions", elements: [
            { type: "button", action_id: "schext_apply_all", style: "primary",
              text: { type: "plain_text", text: "🔄 재시도" },
              value: draftId },
          ]},
        ],
      });
    }
  }


  // ── 종료 버튼 ────────────────────────────────────────────────
  app.action("schext_cancel", async ({ ack, body, client }) => {
    await ack();
    await client.chat.update({
      channel: body.channel.id, ts: body.message.ts,
      text: "❌ 일정 연장 처리 종료",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "❌ *일정 연장 처리 종료*\n문의 내용을 다시 확인해줘." } },
      ],
    });
  });

  // ── [PM에게 납품일 연장 요청] 버튼 → 모달 ───────────────
  app.action("schext_ask_pm", async ({ ack, body, client }) => {
    await ack();
    const draftId = body.actions[0].value;
    const data    = draftStore.get(draftId);
    if (!data) return;
    const deliveryDate = data.deliveryDateStr || "-";

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal", callback_id: "schext_pm_modal_submit",
        private_metadata: JSON.stringify({ draftId }),
        title:  { type: "plain_text", text: "PM 납품일 변경 요청" },
        submit: { type: "plain_text", text: "PM 채널에 전송" },
        close:  { type: "plain_text", text: "취소" },
        blocks: [
          { type: "section", text: { type: "mrkdwn",
            text: `*${data.workName} ${data.episodeLabel}*　현재 납품일: ${deliveryDate}` } },
          { type: "input", block_id: "pm_desired_date_block",
            label: { type: "plain_text", text: "희망 납품일 (예: 2026-05-10)" },
            element: { type: "plain_text_input", action_id: "value",
              placeholder: { type: "plain_text", text: "YYYY-MM-DD" } } },
          { type: "input", block_id: "pm_reason_block",
            label: { type: "plain_text", text: "사유 (선택)" },
            optional: true,
            element: { type: "plain_text_input", action_id: "value", multiline: true,
              placeholder: { type: "plain_text", text: "전달할 내용이 있으면 입력해줘" } } },
        ],
      },
    });
  });

  app.view("schext_pm_modal_submit", async ({ ack, body, view, client }) => {
    await ack();
    const { draftId } = JSON.parse(view.private_metadata || "{}");
    const data = draftStore.get(draftId);
    if (!data) return;

    const desiredDate = view.state.values.pm_desired_date_block?.value?.value?.trim() || "-";
    const reason      = view.state.values.pm_reason_block?.value?.value?.trim() || "";

    const changeLines = data.simTasks.map(t =>
      `・ ${t.opName}　${toDisplayDate(t.startDateOrig)}~${toDisplayDate(t.endDateOrig)} → ${toDisplayDate(t.newStartDateOrig)}~${toDisplayDate(t.newEndDateOrig)}`
    ).join("\n");

    const lines = [
      `<@${PM_SLACK_ID()}>`,
      `안녕하세요. 아래 작품 납품일 변경이 가능할지 문의 드립니다.`,
      ``,
      `・ 담당자: <@${body.user.id}>`,
      `・ 작품명: ${data.workName}`,
      `・ 회차: ${data.episodeLabel}`,
      `・ 현재 납품일: ${data.deliveryDateStr || "-"}`,
      `・ 희망 납품일: ${desiredDate}`,
      ``,
      `*변경 일정*`,
      changeLines,
    ];
    if (reason) { lines.push(""); lines.push(reason); }

    await client.chat.postMessage({
      channel: SCHEDULE_CHANNEL_ID(),
      text: lines.join("\n"),
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
        { type: "actions", elements: [
          { type: "button", action_id: "schext_pm_delivery_confirm",
            text: { type: "plain_text", text: "✅ 연장 가능" },
            style: "primary",
            value: JSON.stringify({ workName: data.workName, episodeLabel: data.episodeLabel, apmUserId: body.user.id, desiredDate }) },
          { type: "button", action_id: "schext_pm_delivery_no",
            text: { type: "plain_text", text: "❌ 연장 불가" },
            value: JSON.stringify({ workName: data.workName, episodeLabel: data.episodeLabel, apmUserId: body.user.id, desiredDate }) },
        ]},
      ],
    });
    await client.chat.postMessage({ channel: body.user.id,
      text: `🔄 <#${SCHEDULE_CHANNEL_ID()}> 채널에 납품일 변경 요청을 전송했어. 희망 납품일: ${desiredDate}` });
  });

  // ── PM 채널 자동 전송 (납품 초과 + 일괄 반영 시) ─────────
  async function _sendPmNotice(client, userId, data, simTasks) {
    const changeLines = simTasks.map(t =>
      `・ ${t.opName}　${toDisplayDate(t.startDateOrig)}~${toDisplayDate(t.endDateOrig)} → ${toDisplayDate(t.newStartDateOrig)}~${toDisplayDate(t.newEndDateOrig)}`
    ).join("\n");

    await client.chat.postMessage({
      channel: SCHEDULE_CHANNEL_ID(),
      text:    `${data.workName} ${data.episodeLabel} 납품일 초과 — PM 확인 필요`,
      blocks: [
        { type: "section", text: { type: "mrkdwn",
          text: `<@${PM_SLACK_ID()}>\n*📢 ${data.workName} ${data.episodeLabel} 일정이 변경되었습니다.*\n⚠️ 납품예정일(${data.deliveryDateStr}) 초과 — PM 확인이 필요해.\n\n${changeLines}\n\n담당 APM: <@${userId}>` } },
        { type: "actions", elements: [
          { type: "button", action_id: "schext_pm_delivery_confirm",
            text: { type: "plain_text", text: "✅ 연장 가능" },
            style: "primary", value: JSON.stringify({ workName: data.workName, episodeLabel: data.episodeLabel, apmUserId: userId, desiredDate: null }) },
          { type: "button", action_id: "schext_pm_delivery_no",
            text: { type: "plain_text", text: "❌ 연장 불가" },
            value: JSON.stringify({ workName: data.workName, episodeLabel: data.episodeLabel, apmUserId: userId, desiredDate: null }) },
        ]},
      ],
    });
  }

  // ── PM 납품일 연장 확인/불필요 버튼 ──────────────────────
  app.action("schext_pm_delivery_confirm", async ({ ack, body, client }) => {
    await ack();
    const parsed = JSON.parse(body.actions[0].value || "{}");
    const workName     = parsed.workName;
    const episodeLabel = parsed.episodeLabel || (parsed.episode ? `${parsed.episode}화` : "-"); // backward-compat
    const apmUserId    = parsed.apmUserId;
    const desiredDate  = parsed.desiredDate;
    const dateText     = desiredDate ? `\n변경된 납품일 : ${desiredDate}` : "";
    // PM 채널 메시지 완료 처리
    await client.chat.update({
      channel: body.channel.id, ts: body.message.ts,
      text: `✅ ${workName} ${episodeLabel} 납품일 연장 승인됨`,
      blocks: [
        { type: "section", text: { type: "mrkdwn",
          text: `✅ *${workName} ${episodeLabel} 납품일 연장 승인됨*` } },
        { type: "context", elements: [
          { type: "mrkdwn", text: `확인자: <@${body.user.id}> · ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}` },
        ]},
      ],
    });
    // APM에게 스레드 댓글로 결과 전달
    if (apmUserId) {
      const dmRes = await client.conversations.open({ users: apmUserId }).catch(() => null);
      if (dmRes) {
        await client.chat.postMessage({
          channel: dmRes.channel.id,
          text: `<@${apmUserId}>\n요청하신 *${workName} ${episodeLabel}* 납품일 연장이 승인되었습니다.${dateText}\n확인자: <@${body.user.id}>`,
        });
      }
    }
  });

  app.action("schext_pm_delivery_no", async ({ ack, body, client }) => {
    await ack();
    const parsed = JSON.parse(body.actions[0].value || "{}");
    const workName     = parsed.workName;
    const episodeLabel = parsed.episodeLabel || (parsed.episode ? `${parsed.episode}화` : "-"); // backward-compat
    const apmUserId    = parsed.apmUserId;
    // PM 채널 메시지 완료 처리
    await client.chat.update({
      channel: body.channel.id, ts: body.message.ts,
      text: `❌ ${workName} ${episodeLabel} 납품일 연장 거절됨`,
      blocks: [
        { type: "section", text: { type: "mrkdwn",
          text: `❌ *${workName} ${episodeLabel} 납품일 연장 거절됨*` } },
        { type: "context", elements: [
          { type: "mrkdwn", text: `확인자: <@${body.user.id}> · ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}` },
        ]},
      ],
    });
    // APM에게 결과 전달
    if (apmUserId) {
      const dmRes = await client.conversations.open({ users: apmUserId }).catch(() => null);
      if (dmRes) {
        await client.chat.postMessage({
          channel: dmRes.channel.id,
          text: `<@${apmUserId}>\n요청하신 *${workName} ${episodeLabel}* 납품일 연장이 거절되었습니다.\n자세한 거절 사유는 PM에게 문의 부탁 드립니다.\n확인자: <@${body.user.id}>`,
        });
      }
    }
  });

  // ══════════════════════════════════════════════════════════
  // 4단계: 작업자 메시지 모달
  // ══════════════════════════════════════════════════════════
  app.action("schext_open_worker_msg_modal", async ({ ack, body, client }) => {
    await ack();
    const { draftId } = JSON.parse(body.actions[0].value || "{}");
    const data = draftStore.get(draftId);
    if (!data) return;

    // 요청 작업자 / 후속 오퍼레이션 분리 (requesterTaskIndex 기준)
    const reqIdx         = data.requesterTaskIndex ?? 0;
    const requesterTask  = data.simTasks[reqIdx];
    const followupTasks  = data.simTasks.filter((_, i) => i !== reqIdx);
    const defaultMsg     = `${data.workName} ${data.episodeLabel} 작업 일정이 변경되었습니다.\n\n확인 부탁드립니다.`;

    const checkboxOptions = followupTasks.map((t, i) => ({
      text:  { type: "mrkdwn", text: `*${t.opName}*　${toDisplayDate(t.newStartDateOrig)}~${toDisplayDate(t.newEndDateOrig)}` },
      value: String(data.simTasks.indexOf(t)), // simTasks 인덱스
    }));

    const blocks = [
      { type: "section", text: { type: "mrkdwn",
        text: `*일정 변경 안내 메시지 전송*\n${data.workName} ${data.episodeLabel}` } },
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn",
        text: `*요청 작업자*\n・ ${requesterTask.opName}　<@${requesterTask.workerEmail?.split("@")[0] || "-"}>　${toDisplayDate(requesterTask.newStartDateOrig)}~${toDisplayDate(requesterTask.newEndDateOrig)}` },
        accessory: { type: "button", action_id: "schext_open_requester_reply_modal",
          text: { type: "plain_text", text: "✏️ 답변 작성" },
          value: JSON.stringify({ draftId }) } },
      { type: "divider" },
    ];

    if (checkboxOptions.length > 0) {
      blocks.push(
        { type: "input", block_id: "followup_select_block",
          label: { type: "plain_text", text: "후속 오퍼레이션 (일괄 전송)" },
          optional: true,
          element: { type: "checkboxes", action_id: "value", options: checkboxOptions,
            initial_options: checkboxOptions } },
        { type: "input", block_id: "followup_msg_block",
          label: { type: "plain_text", text: "공통 메시지" },
          optional: true,
          element: { type: "plain_text_input", action_id: "value", multiline: true,
            initial_value: defaultMsg } },
      );
    }

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal", callback_id: "schext_worker_msg_modal_submit",
        private_metadata: JSON.stringify({ draftId }),
        title:  { type: "plain_text", text: "작업자 안내 메시지" },
        submit: { type: "plain_text", text: "전송" },
        close:  { type: "plain_text", text: "건너뛰기" },
        blocks,
      },
    });
  });

  app.action("schext_skip_worker_msg", async ({ ack }) => { await ack(); });

  // ── 요청 작업자 답변 작성 모달 ───────────────────────────
  app.action("schext_open_requester_reply_modal", async ({ ack, body, client }) => {
    await ack();
    const { draftId } = JSON.parse(body.actions[0].value || "{}");
    const data = draftStore.get(draftId);
    if (!data) return;

    const t = data.simTasks[data.requesterTaskIndex ?? 0];
    const defaultMsg = `${data.workName} ${data.episodeLabel} 작업 일정이 변경되었습니다.\n\n・ 시작일: ${toDisplayDate(t.newStartDateOrig)}\n・ 마감일: ${toDisplayDate(t.newEndDateOrig)}\n\n확인 부탁드립니다.`;

    await client.views.push({
      trigger_id: body.trigger_id,
      view: {
        type: "modal", callback_id: "schext_requester_reply_submit",
        private_metadata: JSON.stringify({ draftId }),
        title:  { type: "plain_text", text: `답변 작성 — ${t.opName}` },
        submit: { type: "plain_text", text: "전송" },
        close:  { type: "plain_text", text: "취소" },
        blocks: [
          { type: "section", text: { type: "mrkdwn",
            text: `*${t.opName}*　${toDisplayDate(t.newStartDateOrig)}~${toDisplayDate(t.newEndDateOrig)}` } },
          { type: "input", block_id: "reply_msg_block",
            label: { type: "plain_text", text: "메시지" },
            element: { type: "plain_text_input", action_id: "value", multiline: true,
              initial_value: defaultMsg } },
        ],
      },
    });
  });

  // ── 요청 작업자 답변 전송 ────────────────────────────────
  app.view("schext_requester_reply_submit", async ({ ack, body, view, client }) => {
    await ack();
    const { draftId } = JSON.parse(view.private_metadata || "{}");
    const data = draftStore.get(draftId);
    if (!data) return;

    const msgText = view.state.values.reply_msg_block?.value?.value?.trim() || "";
    const t       = data.simTasks[data.requesterTaskIndex ?? 0];

    // 원문 스레드에 댓글 또는 DM 전송 시도
    const originalChannelId = data.originalChannelId;
    const originalTs        = data.originalTs;

    try {
      if (originalChannelId && originalTs) {
        // 원문 스레드 댓글
        await client.chat.postMessage({
          channel:   originalChannelId,
          thread_ts: originalTs,
          text:      msgText,
        });
      } else {
        // 작업자 채널 DM 폴백
        const channelId = await _getChannelId(t.workerEmail);
        if (channelId) {
          try { await client.conversations.join({ channel: channelId }); } catch (_) {}
          const mentionText = await _getMentionText(t.workerEmail) || "";
          await client.chat.postMessage({
            channel: channelId,
            text:    `${mentionText} ${msgText}`.trim(),
          });
        }
      }
      await client.chat.postMessage({ channel: body.user.id, text: "✅ 요청 작업자에게 답변을 전송했어." });
    } catch (e) {
      console.error("[scheduleExt] 요청 작업자 답변 전송 실패:", e.message);
      await client.chat.postMessage({ channel: body.user.id, text: `⚠️ 전송 실패: ${e.message}` });
    }
  });

  // ── 후속 오퍼레이션 일괄 전송 ────────────────────────────
  app.view("schext_worker_msg_modal_submit", async ({ ack, body, view, client }) => {
    await ack();
    const { draftId } = JSON.parse(view.private_metadata || "{}");
    const data = draftStore.get(draftId);
    if (!data) return;

    const selectedIdxs = (view.state.values.followup_select_block?.value?.selected_options || [])
      .map(o => parseInt(o.value, 10));
    const msgText = view.state.values.followup_msg_block?.value?.value?.trim() || "";

    if (!selectedIdxs.length || !msgText) return;

    let successCount = 0;
    for (const idx of selectedIdxs) {
      const t = data.simTasks[idx];
      if (!t?.workerEmail) continue;
      try {
        const channelId = await _getChannelId(t.workerEmail);
        if (!channelId) {
          console.warn(`[scheduleExt] 채널 없음 — ${t.workerEmail}`);
          continue;
        }
        try { await client.conversations.join({ channel: channelId }); } catch (_) {}
        const mentionText = await _getMentionText(t.workerEmail) || "";
        await client.chat.postMessage({
          channel: channelId,
          text:    `${mentionText} ${msgText}`.trim(),
        });
        successCount++;
      } catch (e) {
        console.error(`[scheduleExt] 후속 작업자 전송 실패 (${t.workerEmail}):`, e.message);
      }
    }

    await client.chat.postMessage({ channel: body.user.id,
      text: `✅ 후속 오퍼레이션 작업자 ${successCount}명에게 메시지를 전송했어.` });
  });

  return { handleScheduleExt, handleScheduleExtGrouped };
};
