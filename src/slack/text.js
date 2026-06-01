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

module.exports = function createText() {
  return { extractSlackPermalink, cleanSlackText };
};
