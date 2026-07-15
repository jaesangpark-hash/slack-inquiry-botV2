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
   * G열(index 6, 원문 링크)을 문의봇이 실제로 보낸 메시지의 퍼머링크로 갱신한다.
   * append 시점엔 봇 메시지 ts를 아직 모르므로(rowIndex를 먼저 얻어 완료 버튼에 박아넣어야 함) 후속 호출로 덮어쓴다.
   * @param {number|null} rowIndex
   * @param {string} link
   */
  async function updateInquiryHistorySourceLink(rowIndex, link) {
    if (!rowIndex || !link || !historySheetId || !historyGridSheetId) return;
    try {
      await sheetsClient.batchUpdate(historySheetId, [{
        updateCells: {
          range: {
            sheetId: historyGridSheetId,
            startRowIndex: rowIndex - 1,
            endRowIndex: rowIndex,
            startColumnIndex: 6,
            endColumnIndex: 7,
          },
          rows: [{ values: [{ userEnteredValue: { stringValue: link } }] }],
          fields: "userEnteredValue.stringValue",
        },
      }]);
      console.log("[inquiry-history] 링크 갱신 — row:", rowIndex);
    } catch (e) {
      console.error("[inquiry-history] 링크 갱신 실패:", e.message);
    }
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

  return { appendInquiryHistory, updateInquiryHistorySourceLink, checkInquiryDone };
};
