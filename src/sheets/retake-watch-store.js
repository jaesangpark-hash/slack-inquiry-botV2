// 단일 책임: 「리테이크 감시」 시트 append·조회·상태변경 (감시 스토어)
"use strict";

/**
 * 「리테이크 감시」 시트 컬럼 스키마 (A:Q, 17컬럼) — 0-index
 *
 *   0  등록시각(registeredAt) | 1  status         | 2  judgeTaskUuid | 3  allTaskUuids(,)
 *   4  projectUuid           | 5  jobUuid        | 6  episode       | 7  workName
 *   8  operationCode         | 9  operationName  | 10 watchChannel  | 11 watchThreadTs
 *   12 startDate             | 13 endDate        | 14 notifiedAt    | 15 note
 *   16 requesterUserId(완료 알림에서 @멘션할 수정 요청자/CFM Slack ID)
 *   17 ownerUserId(미제출 리마인더에서 @멘션할 "소환한 담당자/APM" Slack ID)
 *   18 workerChannel(작업자 채널 ID — 미제출 리마인더를 작업자 수정요청 스레드에 답글로 달기 위함)
 *   19 workerThreadTs(작업자 채널에 보낸 수정요청 메시지 ts — 그 스레드에 답글)
 *
 * status 값: watching(감시중) → notified(완료 알림 발송) / dropped(DROP) / expired(14일 컷오프) / skipped(감시 대상 채널 아님)
 */
const COL = {
  registeredAt: 0,
  status:       1,
  judgeTaskUuid: 2,
  allTaskUuids: 3,
  projectUuid:  4,
  jobUuid:      5,
  episode:      6,
  workName:     7,
  operationCode: 8,
  operationName: 9,
  watchChannel: 10,
  watchThreadTs: 11,
  startDate:    12,
  endDate:      13,
  notifiedAt:   14,
  note:         15,
  requesterUserId: 16,
  ownerUserId:  17,
  workerChannel: 18,
  workerThreadTs: 19,
};
const COLUMN_COUNT = 20;

/**
 * @param {{
 *   sheetsClient: { getValues: function, append: function, batchUpdate: function },
 *   watchSheetId: string|undefined,
 *   watchSheetRange: string|undefined,
 *   watchGridSheetId: number|undefined,
 * }} deps
 */
// KST(+09:00) ISO 타임스탬프 — 사람이 읽기 쉬우면서 Date.parse로 파싱 가능(14일 컷오프 판정에 사용).
function _kstIsoNow(d = new Date()) {
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, "+09:00");
}

module.exports = function createRetakeWatchStore({ sheetsClient, watchSheetId, watchSheetRange, watchGridSheetId }) {
  // 감시 활성 조건: 시트ID·범위·gridId가 모두 있어야 켠다.
  // gridId만 빠지면 상태 기록(markStatus)이 안 돼 같은 완료 답글이 30분마다 반복되므로,
  // 하나라도 없으면 등록·조회·기록 전부 끈다(부분 활성 금지).
  const enabled = Boolean(watchSheetId) && Boolean(watchSheetRange) && watchGridSheetId != null;

  /**
   * 시트 전체 행을 읽어 파싱한다 (헤더 1행 제외).
   * @returns {Promise<Array<object>>} 각 원소는 컬럼 필드 + rowIndex(1-base, 실제 시트 행번호)
   */
  async function _loadRows() {
    if (!enabled) return [];
    const values = await sheetsClient.getValues(watchSheetId, watchSheetRange);
    const rows = values || [];
    // 첫 행은 헤더 → index 1부터가 데이터. rowIndex는 시트 실제 행번호(1-base): 헤더가 1행이므로 데이터 i는 i+2행.
    const parsed = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] || [];
      parsed.push({
        rowIndex:      i + 1, // 시트 실제 행번호 (헤더=1행, 데이터 0번째=2행)
        registeredAt:  r[COL.registeredAt]  || "",
        status:        (r[COL.status] || "").trim(),
        judgeTaskUuid: (r[COL.judgeTaskUuid] || "").trim(),
        allTaskUuids:  r[COL.allTaskUuids] || "",
        projectUuid:   r[COL.projectUuid]  || "",
        jobUuid:       r[COL.jobUuid]      || "",
        episode:       r[COL.episode]      || "",
        workName:      r[COL.workName]     || "",
        operationCode: r[COL.operationCode] || "",
        operationName: r[COL.operationName] || "",
        watchChannel:  r[COL.watchChannel]  || "",
        watchThreadTs: r[COL.watchThreadTs] || "",
        startDate:     r[COL.startDate]     || "",
        endDate:       r[COL.endDate]       || "",
        notifiedAt:    r[COL.notifiedAt]    || "",
        note:          r[COL.note]          || "",
        requesterUserId: (r[COL.requesterUserId] || "").trim(),
        ownerUserId:     (r[COL.ownerUserId] || "").trim(),
        workerChannel:   (r[COL.workerChannel] || "").trim(),
        workerThreadTs:  (r[COL.workerThreadTs] || "").trim(),
      });
    }
    return parsed;
  }

  /**
   * 감시행 1건을 append한다. judgeTaskUuid가 이미 있으면(상태 무관) skip.
   * 같은 리테이크가 수정 항목 수만큼 여러 번 들어올 수 있어(실측: 동일 taskUuid 3행) 중복을 막는다.
   *
   * @param {object} watch — 감시 대상 필드
   * @returns {Promise<{ skipped: boolean, rowIndex: number|null, reason?: string }>}
   */
  async function registerWatch(watch) {
    if (!enabled) {
      // 시트ID·범위·gridId 중 하나라도 없으면 어떤 스프레드시트에도 쓰지 않고 skip. 운영 시트 오기록·부분 활성 방지.
      return { skipped: true, rowIndex: null, reason: "감시 비활성(시트ID/범위/gridId 미설정)" };
    }
    const judgeTaskUuid = (watch.judgeTaskUuid || "").trim();
    if (!judgeTaskUuid) return { skipped: true, rowIndex: null, reason: "judgeTaskUuid 없음" };

    // 중복 방지: 기존 행(상태 무관)에 같은 judgeTaskUuid가 있으면 append 하지 않는다.
    const existing = await _loadRows();
    if (existing.some(row => row.judgeTaskUuid === judgeTaskUuid)) {
      console.log(`[retake-watch] 중복 skip — judgeTaskUuid: ${judgeTaskUuid}`);
      return { skipped: true, rowIndex: null, reason: "중복" };
    }

    const now = _kstIsoNow();
    const allTaskUuids = Array.isArray(watch.allTaskUuids) ? watch.allTaskUuids.join(",") : (watch.allTaskUuids || "");
    const row = new Array(COLUMN_COUNT).fill("");
    row[COL.registeredAt]  = now;
    row[COL.status]        = "watching";
    row[COL.judgeTaskUuid] = judgeTaskUuid;
    row[COL.allTaskUuids]  = allTaskUuids;
    row[COL.projectUuid]   = watch.projectUuid   || "";
    row[COL.jobUuid]       = watch.jobUuid        || "";
    row[COL.episode]       = watch.episode        || "";
    row[COL.workName]      = watch.workName       || "";
    row[COL.operationCode] = watch.operationCode  || "";
    row[COL.operationName] = watch.operationName  || "";
    row[COL.watchChannel]  = watch.watchChannel   || "";
    row[COL.watchThreadTs] = watch.watchThreadTs  || "";
    row[COL.startDate]     = watch.startDate      || "";
    row[COL.endDate]       = watch.endDate        || "";
    row[COL.notifiedAt]    = "";
    row[COL.note]          = watch.note           || "";
    row[COL.requesterUserId] = watch.requesterUserId || "";
    row[COL.ownerUserId]     = watch.ownerUserId     || "";

    // RAW: 값을 시트 UI처럼 해석하지 않고 문자열 그대로 저장한다.
    // USER_ENTERED면 watchThreadTs("1700000000.000100")가 숫자로 바뀌어 소수부가 사라지고,
    // 그 ts로 답글을 달면 납품 스레드를 벗어난다. ts·uuid 등은 반드시 원문 그대로 보존해야 한다.
    const appendRes = await sheetsClient.append(watchSheetId, watchSheetRange, [row], {
      valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
    });
    const updatedRange = appendRes.data.updates?.updatedRange || "";
    const rowMatch = updatedRange.match(/(\d+)(?::[A-Z]+\d+)?$/);
    const rowIndex = rowMatch ? parseInt(rowMatch[1]) : null;
    console.log(`[retake-watch] 감시행 등록 — row:${rowIndex} judgeTaskUuid:${judgeTaskUuid}`);
    return { skipped: false, rowIndex };
  }

  /**
   * status === "watching" 인 감시행만 반환한다 (폴러 tick 대상).
   * @returns {Promise<Array<object>>}
   */
  async function loadWatching() {
    const rows = await _loadRows();
    return rows.filter(r => r.status === "watching");
  }

  /**
   * 감시행의 status(및 선택적으로 notifiedAt/note)를 갱신한다.
   * @param {number} rowIndex — 시트 실제 행번호(1-base)
   * @param {string} status   — notified | dropped | expired 등
   * @param {{ notifiedAt?: string, note?: string }} [extra]
   */
  async function markStatus(rowIndex, status, extra = {}) {
    if (!enabled || !rowIndex) {
      console.warn(`[retake-watch] markStatus skip — enabled:${enabled} rowIndex:${rowIndex}`);
      return;
    }
    const requests = [{
      updateCells: {
        range: {
          sheetId: watchGridSheetId,
          startRowIndex: rowIndex - 1,
          endRowIndex: rowIndex,
          startColumnIndex: COL.status,
          endColumnIndex: COL.status + 1,
        },
        rows: [{ values: [{ userEnteredValue: { stringValue: String(status) } }] }],
        fields: "userEnteredValue.stringValue",
      },
    }];

    // notifiedAt(14)·note(15)는 인접 컬럼 → 필요 시 한 updateCells로 함께 기록
    const hasNotifiedAt = extra.notifiedAt != null;
    const hasNote       = extra.note != null;
    if (hasNotifiedAt || hasNote) {
      requests.push({
        updateCells: {
          range: {
            sheetId: watchGridSheetId,
            startRowIndex: rowIndex - 1,
            endRowIndex: rowIndex,
            startColumnIndex: COL.notifiedAt,
            endColumnIndex: COL.note + 1,
          },
          rows: [{ values: [
            { userEnteredValue: { stringValue: String(extra.notifiedAt != null ? extra.notifiedAt : "") } },
            { userEnteredValue: { stringValue: String(extra.note != null ? extra.note : "") } },
          ] }],
          fields: "userEnteredValue.stringValue",
        },
      });
    }

    await sheetsClient.batchUpdate(watchSheetId, requests);
    console.log(`[retake-watch] 상태 갱신 — row:${rowIndex} status:${status}`);
  }

  /**
   * 여러 행의 status(+선택 note)를 "한 번의 batchUpdate 호출"로 갱신한다.
   * 범위 밖 채널 행을 첫 tick에 다량 정리할 때 markStatus를 행마다 부르면
   * Sheets 호출이 연달아 터져 한도에 걸릴 수 있어, 모아서 1회로 쓴다.
   * @param {Array<{ rowIndex: number, status: string, note?: string }>} items
   */
  async function markStatusMany(items) {
    if (!enabled) {
      console.warn(`[retake-watch] markStatusMany skip — enabled:${enabled}`);
      return;
    }
    const list = (items || []).filter(it => it && it.rowIndex);
    if (!list.length) return;

    const requests = [];
    for (const { rowIndex, status, note } of list) {
      requests.push({
        updateCells: {
          range: { sheetId: watchGridSheetId, startRowIndex: rowIndex - 1, endRowIndex: rowIndex, startColumnIndex: COL.status, endColumnIndex: COL.status + 1 },
          rows: [{ values: [{ userEnteredValue: { stringValue: String(status) } }] }],
          fields: "userEnteredValue.stringValue",
        },
      });
      if (note != null) {
        requests.push({
          updateCells: {
            range: { sheetId: watchGridSheetId, startRowIndex: rowIndex - 1, endRowIndex: rowIndex, startColumnIndex: COL.note, endColumnIndex: COL.note + 1 },
            rows: [{ values: [{ userEnteredValue: { stringValue: String(note) } }] }],
            fields: "userEnteredValue.stringValue",
          },
        });
      }
    }

    await sheetsClient.batchUpdate(watchSheetId, requests);
    console.log(`[retake-watch] 상태 일괄 갱신 — ${list.length}건(호출 1회)`);
  }

  /**
   * 오래된 감시행을 삭제한다(rolling 보존) — 헤더(1행)는 유지, 데이터 행만.
   *
   * 등록시각(registeredAt)이 maxAgeDays일보다 오래된 행만 지운다. 최근·진행 중 건은 보존.
   * registeredAt을 못 읽는(빈값/파싱 불가) 행은 안전하게 보존(삭제 안 함).
   *
   * ⚠️ 행 삭제는 아래 행 인덱스를 당긴다. 그래서 삭제 범위를 "행번호 내림차순"으로 보내
   *    먼저 지운(위쪽 큰 번호) 삭제가 아직 안 지운(아래쪽 작은 번호) 범위를 어긋나게 하지 않게 한다.
   *
   * @param {{ maxAgeDays?: number, now?: Date }} [opts]
   * @returns {Promise<{ deleted: number, scanned: number, skippedUnparsable: number }>}
   */
  async function cleanupOldRows({ maxAgeDays = 21, now = new Date() } = {}) {
    if (!enabled) {
      console.warn(`[retake-watch] cleanupOldRows skip — enabled:${enabled}`);
      return { deleted: 0, scanned: 0, skippedUnparsable: 0 };
    }
    const rows = await _loadRows();
    const cutoffMs = now.getTime() - maxAgeDays * 24 * 3600 * 1000;

    // 삭제 대상의 0-base 행인덱스(rowIndex-1) 수집
    let skippedUnparsable = 0;
    const targets = []; // 0-base
    for (const r of rows) {
      const t = Date.parse(r.registeredAt);
      if (Number.isNaN(t)) { skippedUnparsable++; continue; } // 날짜 못 읽으면 보존
      if (t < cutoffMs) targets.push(r.rowIndex - 1);
    }
    if (!targets.length) {
      console.log(`[retake-watch] 정리 대상 없음 — scanned:${rows.length} (보존 기준 ${maxAgeDays}일)`);
      return { deleted: 0, scanned: rows.length, skippedUnparsable };
    }

    // 연속 구간으로 병합 → [startIndex, endIndex) (endIndex는 exclusive)
    targets.sort((a, b) => a - b);
    const ranges = [];
    let start = targets[0], prev = targets[0];
    for (let i = 1; i < targets.length; i++) {
      if (targets[i] === prev + 1) { prev = targets[i]; continue; }
      ranges.push([start, prev + 1]);
      start = prev = targets[i];
    }
    ranges.push([start, prev + 1]);

    // 내림차순(아래쪽 구간부터) 삭제 — 인덱스 밀림 방지
    ranges.sort((a, b) => b[0] - a[0]);
    const requests = ranges.map(([s, e]) => ({
      deleteDimension: {
        range: { sheetId: watchGridSheetId, dimension: "ROWS", startIndex: s, endIndex: e },
      },
    }));

    await sheetsClient.batchUpdate(watchSheetId, requests);
    console.log(`[retake-watch] 오래된 감시행 ${targets.length}건 삭제(구간 ${ranges.length}개, ${maxAgeDays}일 경과) — scanned:${rows.length}`);
    return { deleted: targets.length, scanned: rows.length, skippedUnparsable };
  }

  /**
   * judgeTaskUuid로 행을 찾아 작업자 채널·스레드ts(인접 2칸)를 기록한다.
   * 작업자 채널 수정요청 메시지를 보낸 "뒤"에 그 ts를 저장해, 미제출 리마인더가
   * 그 스레드에 답글로 달 수 있게 한다. 해당 행이 없으면 no-op(감시 대상 아님 등).
   * @param {string} judgeTaskUuid
   * @param {{ workerChannel: string, workerThreadTs: string }} info
   */
  async function setWorkerThread(judgeTaskUuid, { workerChannel, workerThreadTs } = {}) {
    if (!enabled || !judgeTaskUuid) return { updated: false };
    const rows = await _loadRows();
    const hit = rows.find(r => r.judgeTaskUuid === judgeTaskUuid);
    if (!hit) return { updated: false, reason: "행 없음" };

    const requests = [{
      updateCells: {
        range: {
          sheetId: watchGridSheetId,
          startRowIndex: hit.rowIndex - 1,
          endRowIndex: hit.rowIndex,
          startColumnIndex: COL.workerChannel,
          endColumnIndex: COL.workerThreadTs + 1,
        },
        rows: [{ values: [
          { userEnteredValue: { stringValue: String(workerChannel || "") } },
          { userEnteredValue: { stringValue: String(workerThreadTs || "") } }, // stringValue라 ts 소수부 보존
        ] }],
        fields: "userEnteredValue.stringValue",
      },
    }];
    await sheetsClient.batchUpdate(watchSheetId, requests);
    console.log(`[retake-watch] 작업자 스레드 기록 — row:${hit.rowIndex} ch:${workerChannel} ts:${workerThreadTs}`);
    return { updated: true, rowIndex: hit.rowIndex };
  }

  return { registerWatch, loadWatching, markStatus, markStatusMany, setWorkerThread, cleanupOldRows, enabled, _loadRows, COL };
};
