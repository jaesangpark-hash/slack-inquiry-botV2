// 단일 책임: 시트 grid gid(스프레드시트 내 개별 시트 식별자) 명명 상수를 제공한다
"use strict";

// 문의 이력 시트의 grid sheetId (완료 체크박스 batchUpdate 대상)
const INQUIRY_HISTORY_GRID_SHEET_ID = 268190314;

// 재수급 시트의 grid sheetId (완료 체크박스 batchUpdate 대상)
const RESUPPLY_GRID_SHEET_ID = 511152201;

// 리테이크 감시 시트 기본 범위 (탭 이름만 — 스프레드시트가 아님. env RETAKE_WATCH_SHEET_RANGE 미설정 시 폴백)
// ⚠️ 스프레드시트 ID는 코드 기본값을 두지 않는다 — 반드시 RETAKE_WATCH_SHEET_ID env로만 지정한다.
//    (운영 시트에 오기록되면 큰 혼선. 감시는 지정된 별도 파일 한 곳에만 쓴다.)
const RETAKE_WATCH_SHEET_RANGE_DEFAULT = "리테이크 감시!A:P";

module.exports = {
  INQUIRY_HISTORY_GRID_SHEET_ID,
  RESUPPLY_GRID_SHEET_ID,
  RETAKE_WATCH_SHEET_RANGE_DEFAULT,
};
