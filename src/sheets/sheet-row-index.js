"use strict";

function requirePositiveSheetRowIndex(rowIndex, recordLabel, failureAction = "요청을 게시") {
  if (!Number.isInteger(rowIndex) || rowIndex <= 0) {
    throw new Error(`${recordLabel} 시트 행 번호를 확인할 수 없어 ${failureAction}할 수 없어.`);
  }
  return rowIndex;
}

function requireSheetCompletionTarget({ rowIndex, spreadsheetId, gridSheetId, recordLabel }) {
  const validRowIndex = requirePositiveSheetRowIndex(rowIndex, recordLabel, "완료 처리");
  if (typeof spreadsheetId !== "string" || !spreadsheetId.trim()) {
    throw new Error(`${recordLabel} 완료 처리용 spreadsheet ID가 설정되지 않았어.`);
  }
  if (!Number.isInteger(gridSheetId) || gridSheetId < 0) {
    throw new Error(`${recordLabel} 완료 처리용 grid sheet ID가 설정되지 않았어.`);
  }
  return {
    gridSheetId,
    rowIndex: validRowIndex,
    spreadsheetId,
  };
}

module.exports = {
  requirePositiveSheetRowIndex,
  requireSheetCompletionTarget,
};
