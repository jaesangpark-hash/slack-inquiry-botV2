// 단일 책임: Slack 텍스트 파싱 순수 헬퍼 (permalink 추출, 마크업 정제)
"use strict";

/**
 * Slack 메시지 링크에서 channelId / ts / url 추출.
 * @param {string} text
 * @returns {{ channelId: string, ts: string, url: string } | null}
 */
function extractSlackPermalink(text = "") {
  const match = text.match(/https:\/\/(?:[^|\s>]+\.)?slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10,})/i);
  if (!match) return null;
  return { channelId: match[1], ts: match[2].slice(0, -6) + "." + match[2].slice(-6), url: match[0] };
}

/**
 * Slack 마크업(<link|label> / 엔티티) 제거 후 공백 trim.
 * @param {string} text
 * @returns {string}
 */
function cleanSlackText(text = "") {
  return text
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2").replace(/<([^>]+)>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
}

/**
 * chat.getPermalink 응답(?thread_ts=...&cid=... 쿼리 포함)은 브라우저를 거쳐
 * 슬랙 앱으로 리다이렉트된다. 쿼리를 제거한 순수 경로(archives/CH/pXXXX)는
 * 클릭 시 바로 슬랙 앱으로 열리므로, 시트에 저장하는 링크는 이 형태로 정규화한다.
 * @param {string} url
 * @returns {string}
 */
function stripPermalinkQuery(url = "") {
  return String(url).split("?")[0];
}

/**
 * 원문 링크에서 「답글을 달 자리」를 뽑는다 — 채널과, 스레드 부모 ts.
 * 링크에 thread_ts 쿼리가 있으면 원문이 스레드 댓글이라는 뜻이라 부모 ts 로 단다
 * (댓글 ts 에 답글을 달면 Slack 이 새 스레드로 취급할 수 있다). 없으면 메시지 ts 그대로.
 *
 * 왜 필요한가: 「기타」 → 「문의봇」 버튼, 직접 소환처럼 원문 좌표 없이 링크만 들고 오는 초안이 있다.
 * 그 초안의 「답변 작성」이 원문 스레드를 못 찾고 멈췄다(재상 님 실측 2026-11-04).
 * @param {string} text
 * @returns {{ channelId: string, ts: string } | null}
 */
function replyTargetFromLink(text = "") {
  const hit = extractSlackPermalink(String(text || ""));
  if (!hit) return null;
  const tail = String(text).slice(String(text).indexOf(hit.url) + hit.url.length);
  const q = tail.match(/^\?[^\s|>]*?thread_ts=(\d{10}\.\d{6})/);
  return { channelId: hit.channelId, ts: q ? q[1] : hit.ts };
}

module.exports = function createText() {
  return { extractSlackPermalink, cleanSlackText, stripPermalinkQuery, replyTargetFromLink };
};
