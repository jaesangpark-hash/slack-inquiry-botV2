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

  // 일시적 네트워크/토큰 오류 판별. oauth2/v4/token "Premature close",
  // 소켓 끊김(ECONNRESET·socket hang up), DNS(EAI_AGAIN), 게이트웨이 5xx 등은 재시도 가치가 있다.
  function _isTransient(e) {
    const msg = String((e && e.message) || "");
    const code = (e && e.code) || "";
    const status = (e && (e.code === undefined ? e.status : e.code)) || (e && e.response && e.response.status);
    return (
      /premature close|socket hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|network|read ECONN/i.test(msg) ||
      ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED"].includes(code) ||
      [429, 500, 502, 503, 504].includes(Number(status))
    );
  }

  // 일시적 오류일 때만 짧은 backoff 후 재시도. read 전용(getValues)에서만 사용 —
  // append/batchUpdate는 재시도 시 중복 쓰기 위험이 있어 1회만 시도한다.
  async function _withRetry(fn, { tries = 3, baseDelayMs = 400 } = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (attempt === tries || !_isTransient(e)) throw e;
        const delay = baseDelayMs * attempt;
        console.warn(`[sheets-client] 일시적 오류 재시도 ${attempt}/${tries - 1} (${delay}ms): ${e && e.message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }

  /**
   * 시트 범위 값 조회. API error 시 throw (알림·로깅 X — 에러 처리는 호출처 책임, F2).
   * @param {string} spreadsheetId
   * @param {string} range
   * @returns {Promise<string[][]>} res.data.values (없으면 호출처가 || [] 처리 — 현 동작 보존)
   */
  async function getValues(spreadsheetId, range) {
    const sheets = google.sheets({ version: "v4", auth: getGoogleAuth([READONLY_SCOPE]) });
    const res = await _withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId, range }));
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
