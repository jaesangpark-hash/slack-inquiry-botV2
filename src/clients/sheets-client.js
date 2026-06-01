// 단일 책임: Google Sheets read/write transport (values.get·append·batchUpdate 호출만 — 도메인·캐시·알림 모름)
"use strict";

/**
 * @param {{ google: object, getGoogleAuth: function }} deps
 *   - google: googleapis 모듈 (google.sheets factory 보유)
 *   - getGoogleAuth: (scopes:string[]) => GoogleAuth 인스턴스
 */
module.exports = function createSheetsClient({ google, getGoogleAuth }) {
  // readonly scope (read-only 조회 전용 — getValues에서 사용)
  const READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
  // read-write scope (append·batchUpdate 전용 — write 메서드에서 사용. R8 scope 분리)
  const READWRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

  /**
   * 시트 범위 값 조회. API error 시 throw (알림·로깅 X — 에러 처리는 호출처 책임, F2).
   * @param {string} spreadsheetId
   * @param {string} range
   * @returns {Promise<string[][]>} res.data.values (없으면 호출처가 || [] 처리 — 현 동작 보존)
   */
  async function getValues(spreadsheetId, range) {
    const sheets = google.sheets({ version: "v4", auth: getGoogleAuth([READONLY_SCOPE]) });
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    return res.data.values;
  }

  /**
   * 시트 범위에 행을 append한다. API error 시 throw (F2 — 알림·로깅은 호출처 책임).
   * @param {string} spreadsheetId
   * @param {string} range
   * @param {Array<Array<string>>} rows  2D 배열 (requestBody.values)
   * @param {object} [opts]  추가 쿼리 파라미터 (valueInputOption·insertDataOption 등)
   * @returns {Promise<object>} Google Sheets API 응답 (res.data.updates.updatedRange 포함)
   */
  async function append(spreadsheetId, range, rows, opts = {}) {
    const sheets = google.sheets({ version: "v4", auth: getGoogleAuth([READWRITE_SCOPE]) });
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      ...opts,
      requestBody: { values: rows },
    });
    return res;
  }

  /**
   * 시트에 batchUpdate 요청을 전송한다 (취소선·서식 변경 등). API error 시 throw (F2).
   * @param {string} spreadsheetId
   * @param {Array<object>} requests  Google Sheets batchUpdate requests 배열
   * @returns {Promise<object>} Google Sheets API 응답
   */
  async function batchUpdate(spreadsheetId, requests) {
    const sheets = google.sheets({ version: "v4", auth: getGoogleAuth([READWRITE_SCOPE]) });
    const res = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });
    return res;
  }

  return { getValues, append, batchUpdate };
};
