// 단일 책임: 재수급 요청을 시트에 append·취소선 처리한다 (write 캡슐화, 부록 A P11)
"use strict";

/**
 * @param {{
 *   sheetsClient: { append: function, batchUpdate: function },
 *   resupplySheetId: string,
 *   resupplySheetRange: string,
 *   resupplyGridSheetId: number,
 * }} deps
 *   - sheetsClient: sheets-client.js transport (append/batchUpdate 메서드 보유)
 *   - resupplySheetId: RESUPPLY_SHEET_ID env 값
 *   - resupplySheetRange: RESUPPLY_SHEET_RANGE env 값
 *   - resupplyGridSheetId: 취소선 대상 grid sheetId 숫자 (511152201 고정값을 DI로 주입)
 */
module.exports = function createResupplyRecord({ sheetsClient, resupplySheetId, resupplySheetRange, resupplyGridSheetId }) {
  /**
   * 재수급 요청을 시트에 append한다.
   * 기록된 행 번호(rowIndex)를 반환한다 (취소선 처리용).
   * Slack users.info 조회는 client 호출 인자로 전달받는다.
   *
   * @param {object} draft
   * @param {string} submitterId  Slack user ID
   * @param {{ users: { info: function } }} client  Slack Bolt client (users.info 조회용)
   * @returns {Promise<number|null>} rowIndex (실패 시 null)
   */
  async function appendResupplyRecord(draft, submitterId, client) {
    let requesterName = submitterId;
    try {
      const userInfo = await client.users.info({ user: submitterId });
      requesterName = userInfo.user?.profile?.display_name || userInfo.user?.real_name || submitterId;
    } catch (_) {}

    const apmName = requesterName;
    const fileNums = draft.fileNumbers?.length ? draft.fileNumbers.join(", ") : "-";
    const episodeAndFiles = [
      draft.episode ? `${draft.episode}화` : null,
      fileNums !== "-" ? fileNums : null,
    ].filter(Boolean).join(" / ");

    const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    const sourceLink = draft.sourceLink || "-";

    const appendRes = await sheetsClient.append(resupplySheetId, resupplySheetRange, [
      [
        requesterName,
        apmName,
        draft.workName || "-",
        episodeAndFiles || "-",
        draft.reason || "-",
        now,
        sourceLink,
        draft.jpTitle || "-",
      ],
    ], {
      valueInputOption: "USER_ENTERED",
      includeValuesInResponse: false,
      responseValueRenderOption: "UNFORMATTED_VALUE",
      insertDataOption: "INSERT_ROWS",
    });

    // 기록된 행 번호 추출 (취소선 처리용)
    const updatedRange = appendRes.data.updates?.updatedRange || "";
    const rowMatch = updatedRange.match(/(\d+)$/);
    const rowIndex = rowMatch ? parseInt(rowMatch[1]) : null;
    console.log("[resupply-sheet] 완료 —", draft.workName, episodeAndFiles, "| row:", rowIndex);
    return rowIndex;
  }

  /**
   * 재수급 완료 처리 — L열(index 11) 체크박스를 true로 변경한다.
   * @param {number|null} rowIndex  appendResupplyRecord 반환값
   */
  async function checkResupplyDone(rowIndex) {
    if (!rowIndex) return;
    try {
      await sheetsClient.batchUpdate(resupplySheetId, [{
        updateCells: {
          range: {
            sheetId: resupplyGridSheetId,
            startRowIndex: rowIndex - 1,
            endRowIndex: rowIndex,
            startColumnIndex: 11,
            endColumnIndex: 12,
          },
          rows: [{ values: [{ userEnteredValue: { boolValue: true } }] }],
          fields: "userEnteredValue.boolValue",
        },
      }]);
      console.log("[resupply-sheet] 완료 처리 — row:", rowIndex);
    } catch (e) {
      console.error("[resupply-sheet] 완료 처리 실패:", e.message);
    }
  }

  return { appendResupplyRecord, checkResupplyDone };
};
