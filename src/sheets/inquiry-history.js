// 단일 책임: 문의 이력을 시트에 append한다 (KPI reservation)
"use strict";

/**
 * @param {{
 *   sheetsClient: { append: function },
 *   historySheetId: string|undefined,
 *   historySheetRange: string|undefined,
 * }} deps
 *   - sheetsClient: sheets-client.js transport (append 메서드 보유)
 *   - historySheetId: INQUIRY_HISTORY_SHEET_ID env 값 (미설정 시 undefined → early return)
 *   - historySheetRange: INQUIRY_HISTORY_SHEET_RANGE env 값 (미설정 시 undefined → early return)
 */
module.exports = function createInquiryHistory({ sheetsClient, historySheetId, historySheetRange }) {
  /**
   * 문의 이력을 시트에 append한다.
   * INQUIRY_HISTORY_SHEET_ID / INQUIRY_HISTORY_SHEET_RANGE 미설정 시 early return (KPI reservation).
   * @param {object} draft
   * @param {string} submitterId  Slack user ID
   */
  async function appendInquiryHistory(draft, submitterId) {
    // 문의 이력 시트 미지정 — INQUIRY_HISTORY_SHEET_ID / INQUIRY_HISTORY_SHEET_RANGE 환경변수 추가 후 활성화
    if (!historySheetId || !historySheetRange) return;
    try {
      const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
      await sheetsClient.append(historySheetId, historySheetRange, [
        [now, draft.workName||"", draft.workNameKo||"", draft.inquiryType||"", draft.summary||"", draft.actionRequired||"", draft.sourceLink||"", submitterId||""],
      ], { valueInputOption: "USER_ENTERED" });
    } catch (e) { console.error("이력 기록 실패:", e.message); }
  }

  return { appendInquiryHistory };
};
