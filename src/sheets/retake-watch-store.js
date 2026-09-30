// 단일 책임: 「리테이크 감시」 시트 append·조회·상태변경 (감시 스토어)
"use strict";

/**
 * 「리테이크 감시」 시트 컬럼 스키마 (A:P, 16컬럼) — 0-index
 *
 *   0  등록시각(registeredAt) | 1  status         | 2  judgeTaskUuid | 3  allTaskUuids(,)
 *   4  projectUuid           | 5  jobUuid        | 6  episode       | 7  workName
 *   8  operationCode         | 9  operationName  | 10 watchChannel  | 11 watchThreadTs
 *   12 startDate             | 13 endDate        | 14 notifiedAt    | 15 note
 *
 * status 값: watching(감시중) → notified(완료 알림 발송) / dropped(DROP) / expired(14일 컷오프)
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
};
const COLUMN_COUNT = 16;

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
  /**
   * 시트 전체 행을 읽어 파싱한다 (헤더 1행 제외).
   * @returns {Promise<Array<object>>} 각 원소는 컬럼 필드 + rowIndex(1-base, 실제 시트 행번호)
   */
  async function _loadRows() {
    if (!watchSheetId || !watchSheetRange) return [];
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
    if (!watchSheetId || !watchSheetRange) {
      // 시트 미지정 시 어떤 스프레드시트에도 쓰지 않고 조용히 skip(경고 로그만). 운영 시트 오기록 방지.
      console.warn("[retake-watch] RETAKE_WATCH_SHEET_ID/RANGE 미설정 — 감시행 등록 skip");
      return { skipped: true, rowIndex: null, reason: "sheet 미설정" };
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

    const appendRes = await sheetsClient.append(watchSheetId, watchSheetRange, [row], {
      valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS",
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
    if (!rowIndex || !watchSheetId || watchGridSheetId == null) {
      console.warn(`[retake-watch] markStatus skip — rowIndex:${rowIndex} sheetId:${!!watchSheetId} gridId:${watchGridSheetId}`);
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

  return { registerWatch, loadWatching, markStatus, _loadRows, COL };
};
