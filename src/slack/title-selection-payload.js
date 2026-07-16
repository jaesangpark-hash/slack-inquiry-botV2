"use strict";

/**
 * 작품 선택 버튼 payload에서 한국어 프로젝트명을 읽는다.
 * `projectName`은 배포 전 생성된 Slack 버튼을 위한 단일 하위 호환 경계다.
 */
function readKoreanProjectNameFromSelectionPayload(selection = {}) {
  return selection.koreanProjectName || selection.projectName || "";
}

module.exports = { readKoreanProjectNameFromSelectionPayload };
