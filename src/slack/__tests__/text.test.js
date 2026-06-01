"use strict";
/**
 * slack/text.js 단위 테스트
 *
 * node:test + node:assert 빌트인 사용.
 * 순수 함수 — fake dep 불필요.
 *
 * 검증 항목:
 *   extractSlackPermalink:
 *     - 정상 Slack 퍼머링크 → { channelId, ts, url } 반환
 *     - 채널 ID + ts 포맷 정확성 (ts: XXXX.XXXXXX)
 *     - 비Slack URL → null
 *     - 빈 문자열 → null
 *   cleanSlackText:
 *     - <url|label> 형태 → label만 남김
 *     - <url> 형태 → url 텍스트만 남김
 *     - HTML 엔티티(&lt;/&gt;/&amp;) 디코드
 *     - 앞뒤 공백 trim
 *     - 마크업 없는 일반 텍스트 → 그대로
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const createText = require("../text");

const { extractSlackPermalink, cleanSlackText } = createText();

// ── extractSlackPermalink ─────────────────────────────────────────────────────

describe("extractSlackPermalink", () => {
  test("정상 Slack 퍼머링크에서 channelId, ts, url 추출", () => {
    const text = "링크: https://voithru.slack.com/archives/C0123ABCDE/p1712345678901234";
    const result = extractSlackPermalink(text);
    assert.ok(result, "결과가 null이어서는 안 됨");
    assert.strictEqual(result.channelId, "C0123ABCDE");
    assert.strictEqual(result.ts, "1712345678.901234");
    assert.ok(result.url.includes("slack.com/archives"), `url 형식 오류: ${result.url}`);
  });

  test("ts가 12자리 digits인 경우도 처리 (10자리 정수부 + 6자리 소수부)", () => {
    const text = "https://example.slack.com/archives/CABC123/p1700000000123456";
    const result = extractSlackPermalink(text);
    assert.ok(result, "결과가 null이어서는 안 됨");
    assert.strictEqual(result.ts, "1700000000.123456");
  });

  test("Slack URL이 없으면 null 반환", () => {
    const result = extractSlackPermalink("일반 텍스트입니다 링크 없음");
    assert.strictEqual(result, null);
  });

  test("빈 문자열 → null", () => {
    assert.strictEqual(extractSlackPermalink(""), null);
  });

  test("비Slack URL → null", () => {
    const result = extractSlackPermalink("https://example.com/page");
    assert.strictEqual(result, null);
  });
});

// ── cleanSlackText ────────────────────────────────────────────────────────────

describe("cleanSlackText", () => {
  test("<url|label> 형태 → label만 남김", () => {
    const result = cleanSlackText("<https://example.com|표시 텍스트>");
    assert.strictEqual(result, "표시 텍스트");
  });

  test("<url> 형태 → url 텍스트만 남김", () => {
    const result = cleanSlackText("<https://example.com>");
    assert.strictEqual(result, "https://example.com");
  });

  test("&lt; &gt; &amp; 엔티티 디코드", () => {
    const result = cleanSlackText("A &lt; B &amp; C &gt; D");
    assert.strictEqual(result, "A < B & C > D");
  });

  test("앞뒤 공백 trim", () => {
    const result = cleanSlackText("  hello world  ");
    assert.strictEqual(result, "hello world");
  });

  test("마크업 없는 일반 텍스트 → 그대로 (trim만 적용)", () => {
    const result = cleanSlackText("작품명 확인 부탁드립니다");
    assert.strictEqual(result, "작품명 확인 부탁드립니다");
  });

  test("빈 문자열 → 빈 문자열", () => {
    assert.strictEqual(cleanSlackText(""), "");
  });

  test("복합 마크업 — 멘션 + 링크 혼합", () => {
    const result = cleanSlackText("<@U12345> <https://slack.com/archives/C1/p123|스레드 링크> 확인해줘");
    assert.ok(result.includes("@U12345"), `멘션 누락: ${result}`);
    assert.ok(result.includes("스레드 링크"), `링크 라벨 누락: ${result}`);
    assert.ok(result.includes("확인해줘"), `본문 누락: ${result}`);
  });
});
