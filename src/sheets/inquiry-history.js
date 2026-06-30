// 단일 책임: 문의 이력을 시트에 append·완료 처리한다
"use strict";

/**
 * @param {{
 *   sheetsClient: { append: function, batchUpdate: function },
 *   historySheetId: string|undefined,
 *   historySheetRange: string|undefined,
 *   historyGridSheetId: number,
 * }} deps
 */
module.exports = function createInquiryHistory({ sheetsClient, historySheetId, historySheetRange, historyGridSheetId }) {
  /**
   * 문의 이력을 시트에 append한다.
   * @returns {Promise<number|null>} rowIndex (완료 처리용)
   */
  async function appendInquiryHistory(draft, submitterId) {
    if (!historySheetId || !historySheetRange) return null;
    const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    const appendRes = await sheetsClient.append(historySheetId, historySheetRange, [
      [now, draft.workName||"", draft.workNameKo||"", draft.inquiryType||"", draft.summary||"", draft.actionRequired||"", draft.sourceLink||"", submitterId||"", false],
    ], { valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS" });

    const updatedRange = appendRes.data.updates?.updatedRange || "";
    const rowMatch = updatedRange.match(/(\d+)$/);
    const rowIndex = rowMatch ? parseInt(rowMatch[1]) : null;
    console.log("[inquiry-history] 기록 완료 — row:", rowIndex);
    return rowIndex;
  }

  /**
   * 문의 완료 처리 — I열(index 8) 체크박스를 true로 변경한다.
   * @param {number|null} rowIndex
   */
  async function checkInquiryDone(rowIndex) {
    if (!rowIndex || !historySheetId || !historyGridSheetId) return;
    try {
      await sheetsClient.batchUpdate(historySheetId, [{
        updateCells: {
          range: {
            sheetId: historyGridSheetId,
            startRowIndex: rowIndex - 1,
            endRowIndex: rowIndex,
            startColumnIndex: 8,
            endColumnIndex: 9,
          },
          rows: [{ values: [{ userEnteredValue: { boolValue: true } }] }],
          fields: "userEnteredValue.boolValue",
        },
      }]);
      console.log("[inquiry-history] 완료 처리 — row:", rowIndex);
    } catch (e) {
      console.error("[inquiry-history] 완료 처리 실패:", e.message);
    }
  }

  return { appendInquiryHistory, checkInquiryDone };
};
