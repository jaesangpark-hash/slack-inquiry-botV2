"use strict";

/**
 * 봇 토큰을 실어 내려받을 주소가 Slack 비공개 파일 주소인지 확인한다.
 * 모달 입력값이 그대로 내려받기 주소가 될 수 있어, 토큰이 외부로 나가거나
 * slack.com/api 같은 Slack API를 봇 권한으로 호출하지 못하게 막는다.
 * 실패는 throw한다. 호출부의 이미지별 catch가 원본 링크 안내로 처리한다.
 */
const SLACK_FILE_HOST = "files.slack.com";
const SLACK_FILE_PATH_PREFIX = "/files-pri/";

function assertSlackFileUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Slack 파일 주소가 아님: URL 형식 오류");
  }
  const { protocol, hostname, pathname } = parsed;
  if (
    protocol !== "https:" ||
    hostname !== SLACK_FILE_HOST ||
    !pathname.startsWith(SLACK_FILE_PATH_PREFIX)
  ) {
    throw new Error(`Slack 파일 주소가 아님: ${protocol}//${hostname}`);
  }
}

module.exports = { assertSlackFileUrl };
