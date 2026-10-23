// 단일 책임: 미제출(미완료) 리테이크를 모아 지정 시각에 소환 담당자를 태그해 공지한다
"use strict";

const { cleanWorkName } = require("./retakeTitle");

// 공지 대상에서 제외할 Totus 태스크 상태 (이미 완료/드랍된 건)
const DONE_STATES = new Set(["COMPLETED", "DROP"]);

/**
 * 미제출 리테이크 일괄 리마인더 (DI 팩토리)
 *
 * tick(): 감시 시트 전체를 읽어
 *   - status === "watching"(아직 완료 알림 안 나감)
 *   - 오늘(KST) 등록분(registeredAt)
 *   - 감시 대상 채널(watchChannels) 소환건
 *   을 1차로 고른 뒤, 각 행을 judgeTaskUuid로 GET /api/v1/tasks/{uuid} 조회해
 *   이미 COMPLETED·DROP 인 태스크는 제외하고, "확인된 미완료" 건만 채널별 1건으로 공지한다.
 *
 * ⚠️ 왜 Totus를 다시 확인하나 (형민님 검수):
 *   완료 폴러와 리마인더가 같은 18시에 시작하는데, 폴러는 행마다 Totus 조회→답글→notified 기록이라
 *   리마인더의 시트 1회 읽기가 먼저 끝난다. 그래서 17:30 tick~18:00 사이 완료된 행이 아직 "watching"으로
 *   남아 "미제출"로 잘못 공지되고 소환 담당자가 엉뚱하게 태그될 수 있다. 이를 막으려 발송 직전 상태를 재확인한다.
 *
 * ⚠️ 리마인더는 상태를 기록하지 않는다(markStatus 호출 없음) — 읽기 전용.
 *   notified 기록은 완료 폴러 몫. 두 곳에서 기록하면 완료 답글이 두 번 나갈 수 있다.
 *
 * 조회 실패 시: 해당 행은 공지에서 제외한다("확인된 미완료"만 알림 → 완료건 오탐·오태그 방지).
 *
 * @param {{
 *   retakeWatchStore: { _loadRows: function },  // 시트 전체 행 로드
 *   slackClient: object,                        // app.client (chat.postMessage)
 *   watchChannels: Set<string>|undefined,       // 감시 대상 채널 필터
 *   apiFetch: function,                         // retakeFlow._apiFetch 재사용 (url, options, meta) => json
 *   base: function,                             // () => PLATFORM_API_URL
 *   token: function,                            // () => PLATFORM_API_TOKEN
 * }} deps
 */
module.exports = function createRetakeReminderPoller({ retakeWatchStore, slackClient, watchChannels, apiFetch, base, token }) {
  const BASE  = base  || (() => process.env.PLATFORM_API_URL);
  const TOKEN = token || (() => process.env.PLATFORM_API_TOKEN);

  // KST 기준 오늘 날짜 (YYYY-MM-DD) — registeredAt(_kstIsoNow)의 날짜부와 직접 비교
  function _todayKst(d = new Date()) {
    return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  }

  // GET /api/v1/tasks/{uuid} — 판정대상 태스크 상태 조회 (응답 키는 한글 "상태", 값은 COMPLETED·DROP 등 영문)
  // apiFetch 미주입 시(테스트/하위호환) 재확인을 건너뛴다(null 반환 → 포함).
  async function _getTaskState(taskUuid) {
    if (!apiFetch || !taskUuid) return null;
    const json = await apiFetch(
      `${BASE()}/api/v1/tasks/${taskUuid}`,
      { headers: { Authorization: `Bearer ${TOKEN()}` } },
      { bot: "retake-reminder", endpoint: "/tasks/{uuid}", params: {}, expectedCount: 1 }
    );
    if (!json || !json.success) return null;
    return json.data?.["상태"] || null;
  }

  // 후보 행이 "지금도 미완료"인지 — COMPLETED·DROP이면 false(제외). 조회 실패 시 false(제외, 오탐 방지).
  // watching 행의 현재 상태를 3분류한다:
  //   "pending" 지금도 미완료(PROCESSING 등, 또는 apiFetch 미주입)  → 리마인더 대상
  //   "done"    완료/드랍(COMPLETED·DROP)                          → 해결됨
  //   "unknown" 조회 실패/빈값/예외                                 → 알 수 없음(리마인더 제외 + 완료 안내 차단)
  async function _classify(row) {
    if (!apiFetch) return "pending"; // 재확인 생략(시트 watching 신뢰)
    try {
      const state = await _getTaskState(row.judgeTaskUuid);
      if (state == null) {
        console.warn(`[retake-reminder] 상태 조회 실패/빈값 → unknown row:${row.rowIndex} ${row.workName} ${row.episode}화`);
        return "unknown";
      }
      return DONE_STATES.has(state) ? "done" : "pending";
    } catch (e) {
      console.warn(`[retake-reminder] 상태 조회 예외 → unknown row:${row.rowIndex} — ${e.message}`);
      return "unknown";
    }
  }

  // 하위호환: 리마인더 대상(미제출 확정)인지 여부. unknown·done은 false.
  async function _isStillPending(row) {
    return (await _classify(row)) === "pending";
  }

  // 공지 본문 — 헤더에 소환 담당자(들) 태그, 각 줄은 작품·회차·작업유형.
  function _buildText(rows) {
    // 헤더: 소환 담당자 — 여러 명이면 중복 제거해 모두 태그(없으면 생략)
    const owners = [...new Set(rows.map(r => r.ownerUserId).filter(Boolean))];
    const ownerMentions = owners.length ? owners.map(id => `<@${id}>`).join(" ") + " " : "";
    const head = `⏰ *[미제출 리테이크 알림]* ${ownerMentions}오늘 요청된 수정 건 중 아직 완료되지 않은 ${rows.length}건입니다. 제출 확인 부탁드립니다!`;
    const lines = rows.map(r => {
      const work = cleanWorkName(r.workName) || "작품";
      return `• *${work} ${r.episode || "?"}화 [${r.operationName || "-"}]*`;
    });
    return `${head}\n${lines.join("\n")}`;
  }

  // 미제출 0건일 때 납품 스레드에 다는 "전체 제출 완료" 안내 — 아무도 태그하지 않는다.
  function _buildAllClearText() {
    return `✅ 현 시점 기준, 오늘 요청된 리테이크 수정 건이 모두 제출 완료되었습니다. 감사합니다!`;
  }

  // 작업자 수정요청 스레드에 다는 리마인드 답글 — 그 스레드 자체가 해당 건이라 간결하게.
  function _buildWorkerText(rows) {
    const items = rows.map(r => `*${cleanWorkName(r.workName) || "작품"} ${r.episode || "?"}화 [${r.operationName || "-"}]*`).join(", ");
    return `⏰ 아직 제출되지 않은 수정 건이 있어요 — ${items}. 제출 확인 부탁드립니다!`;
  }

  /**
   * 리마인더 1회 실행 — 오늘 등록된 미제출 watching 행 중 Totus상 미완료만 채널별로 공지한다.
   */
  async function tick() {
    let rows;
    try {
      rows = await retakeWatchStore._loadRows();
    } catch (e) {
      console.error("[retake-reminder] 감시행 로드 실패:", e.message);
      return;
    }
    const today = _todayKst();
    // 오늘 등록 + 감시 대상 채널의 모든 행(상태 무관). 완료 안내 판정에 완료(notified)건도 필요해서 상태로 안 거른다.
    const todayWatch = rows.filter(r =>
      (r.registeredAt || "").slice(0, 10) === today &&
      (!watchChannels || watchChannels.has(r.watchChannel))
    );
    if (!todayWatch.length) {
      console.log("[retake-reminder] 오늘 감시 대상 행 없음 — skip");
      return;
    }

    // watching 행을 발송 직전 Totus로 재분류 → pending(미제출 확정)·unknown(조회 실패)을 나눠 담는다.
    // unknown은 리마인더 목록에선 빠지지만(기존대로), "모두 제출 완료" 안내는 차단해야 한다(틀린 완료 안내 방지).
    const pending = [];
    const unknownSet = new Set();
    for (const r of todayWatch) {
      if (r.status !== "watching") continue;
      const cat = await _classify(r);
      if (cat === "pending") pending.push(r);
      else if (cat === "unknown") unknownSet.add(r.rowIndex);
      // done → 둘 다 아님
    }
    const pendingSet = new Set(pending.map(r => r.rowIndex));

    // 납품 스레드(watchThreadTs)별 그룹 → 스레드마다:
    //   - 미제출(pending) 있으면 그 스레드에 리마인더(소환자 태그) 답글
    //   - 미제출·조회실패(unknown) 모두 없고 완료(notified) 있으면 "모두 제출 완료" 안내(태그 없음)
    //   - 조회 실패가 하나라도 있으면 완료 안내 보류(실제로 미제출이 남았을 수 있음 — 형민님 검수)
    //   - 그 외(드랍/만료만) 무발송
    const byThread = new Map(); // key = channel + "\u0000" + threadTs
    for (const r of todayWatch) {
      const threadTs = r.watchThreadTs || "";
      const key = `${r.watchChannel}\u0000${threadTs}`;
      if (!byThread.has(key)) byThread.set(key, { channel: r.watchChannel, threadTs, rows: [] });
      byThread.get(key).rows.push(r);
    }
    for (const { channel, threadTs, rows: grp } of byThread.values()) {
      const grpPending = grp.filter(r => pendingSet.has(r.rowIndex));
      const grpHasUnknown = grp.some(r => unknownSet.has(r.rowIndex));
      let text = null;
      if (grpPending.length) {
        text = _buildText(grpPending); // 미제출 리마인더
      } else if (!grpHasUnknown && grp.some(r => r.status === "notified")) {
        text = _buildAllClearText();   // 모두 제출 완료 안내(조회 실패 없을 때만)
      }
      if (!text) {
        if (grpHasUnknown) console.log(`[retake-reminder] 조회 실패 포함 → 완료 안내 보류 — ch:${channel} thread:${threadTs || "(최상위)"}`);
        continue;
      }
      try {
        const msg = { channel, text };
        if (threadTs) msg.thread_ts = threadTs; // 납품 스레드에 답글
        await slackClient.chat.postMessage(msg);
        console.log(`[retake-reminder] ${grpPending.length ? `미제출 ${grpPending.length}건 공지` : "전체 제출 완료 안내"} — ch:${channel} thread:${threadTs || "(최상위)"}`);
      } catch (e) {
        console.error(`[retake-reminder] 공지 발송 실패 ch:${channel} thread:${threadTs} — ${e.message}`);
      }
    }

    // 작업자 채널 수정요청 스레드에도 리마인드 — 미제출(pending) 건 중 workerChannel·workerThreadTs 있는 행만.
    // 작업자 채널 메시지가 안 나간(ts 없는) 건은 skip.
    const byWorkerThread = new Map(); // key = workerChannel + "\u0000" + workerThreadTs
    for (const r of pending) {
      if (!r.workerChannel || !r.workerThreadTs) continue;
      const key = `${r.workerChannel}\u0000${r.workerThreadTs}`;
      if (!byWorkerThread.has(key)) byWorkerThread.set(key, { channel: r.workerChannel, threadTs: r.workerThreadTs, rows: [] });
      byWorkerThread.get(key).rows.push(r);
    }
    for (const { channel, threadTs, rows: grp } of byWorkerThread.values()) {
      try {
        await slackClient.chat.postMessage({ channel, thread_ts: threadTs, text: _buildWorkerText(grp) });
        console.log(`[retake-reminder] 작업자 스레드 리마인드 — ch:${channel} thread:${threadTs} (${grp.length}건)`);
      } catch (e) {
        console.error(`[retake-reminder] 작업자 리마인드 실패 ch:${channel} thread:${threadTs} — ${e.message}`);
      }
    }
  }

  return { tick, _buildText, _buildWorkerText, _buildAllClearText, _todayKst, _getTaskState, _isStillPending };
};
