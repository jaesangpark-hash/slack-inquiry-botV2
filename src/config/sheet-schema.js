// 단일 책임: 시트 grid gid(스프레드시트 내 개별 시트 식별자) 명명 상수를 제공한다
"use strict";

// 문의 이력 시트의 grid sheetId (완료 체크박스 batchUpdate 대상)
const INQUIRY_HISTORY_GRID_SHEET_ID = 268190314;

// 재수급 시트의 grid sheetId (완료 체크박스 batchUpdate 대상)
const RESUPPLY_GRID_SHEET_ID = 511152201;

// 리테이크 감시 시트 기본 스프레드시트 ID (env RETAKE_WATCH_SHEET_ID 미설정 시 폴백)
// 기존 리테이크 자동화 시트에 「리테이크 감시」 탭을 추가해 사용한다.
const RETAKE_WATCH_SHEET_ID_DEFAULT = "1PzuVxMCbsTXIVNrodEFgrh2E_zGPnPTGnkWLziDhSCg";

// 리테이크 감시 시트 기본 범위 (env RETAKE_WATCH_SHEET_RANGE 미설정 시 폴백)
const RETAKE_WATCH_SHEET_RANGE_DEFAULT = "리테이크 감시!A:P";

module.exports = {
  INQUIRY_HISTORY_GRID_SHEET_ID,
  RESUPPLY_GRID_SHEET_ID,
  RETAKE_WATCH_SHEET_ID_DEFAULT,
  RETAKE_WATCH_SHEET_RANGE_DEFAULT,
};
