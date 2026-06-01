"use strict";
/**
 * TRIGGER_EMOJI guard + reaction 분기 단위 테스트
 *
 * node:test + node:assert 빌트인 사용 (신규 dep 추가 금지).
 * process.env 오염 없이 DI env 객체 주입으로 검증.
 *
 * 검증 항목:
 *   - assertTriggerEmoji: TRIGGER_EMOJI 누락 → throw
 *   - assertTriggerEmoji: TRIGGER_EMOJI 빈 문자열 → throw
 *   - assertTriggerEmoji: TRIGGER_EMOJI 설정 → throw 없음
 *   - reaction 분기: prod 이모지 값 일치 → 통과 (truthy)
 *   - reaction 분기: dev 이모지 값 일치 → 통과 (truthy)
 *   - reaction 분기: prod 이모지에 dev 값 → 미통과 (falsy)
 *   - reaction 분기: dev 이모지에 prod 값 → 미통과 (falsy)
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { assertTriggerEmoji } = require("../env");
const { isTriggerReaction } = require("../trigger");

// ── 공통 fixtures ─────────────────────────────────────────────────────────────

const PROD_EMOJI = "문의봇소환";
const DEV_EMOJI  = "문의봇테스트";

// ── 테스트 그룹 1: assertTriggerEmoji guard ───────────────────────────────────

describe("assertTriggerEmoji guard", () => {
  test("TRIGGER_EMOJI 누락 → throw, 메시지에 변수명 포함", () => {
    const env = {};
    assert.throws(
      () => assertTriggerEmoji(env),
      (err) => {
        assert.ok(
          err.message.includes("TRIGGER_EMOJI"),
          `메시지에 TRIGGER_EMOJI 미포함: ${err.message}`
        );
        return true;
      }
    );
  });

  test("TRIGGER_EMOJI 빈 문자열 → throw (isUnset 판정)", () => {
    const env = { TRIGGER_EMOJI: "" };
    assert.throws(() => assertTriggerEmoji(env));
  });

  test("TRIGGER_EMOJI 설정 → throw 없음", () => {
    const env = { TRIGGER_EMOJI: PROD_EMOJI };
    assert.doesNotThrow(() => assertTriggerEmoji(env));
  });

  test("TRIGGER_EMOJI = dev 이모지 설정 → throw 없음", () => {
    const env = { TRIGGER_EMOJI: DEV_EMOJI };
    assert.doesNotThrow(() => assertTriggerEmoji(env));
  });
});

// ── 테스트 그룹 2: reaction 분기 대칭 검증 (prod 동작 무변경 포함) ────────────

describe("reaction 분기 대칭 (TRIGGER_EMOJI 환경변수 값 기반)", () => {
  /**
   * app.js의 핵심 분기 로직을 실 isTriggerReaction 함수로 검증:
   *   if (!isTriggerReaction(emoji, triggerEmoji)) return;  ← 미통과
   *   if (isTriggerReaction(emoji, triggerEmoji)) {         ← 통과
   */

  test("prod 이모지 값 일치 → 핸들러 진입 (truthy)", () => {
    const triggerEmoji = PROD_EMOJI;
    assert.ok(isTriggerReaction(PROD_EMOJI, triggerEmoji));
  });

  test("dev 이모지 값 일치 → 핸들러 진입 (truthy)", () => {
    const triggerEmoji = DEV_EMOJI;
    assert.ok(isTriggerReaction(DEV_EMOJI, triggerEmoji));
  });

  test("prod 이모지 설정 시 dev 이모지 반응 → 핸들러 미진입 (falsy)", () => {
    const triggerEmoji = PROD_EMOJI;
    assert.ok(!isTriggerReaction(DEV_EMOJI, triggerEmoji));
  });

  test("dev 이모지 설정 시 prod 이모지 반응 → 핸들러 미진입 (falsy)", () => {
    const triggerEmoji = DEV_EMOJI;
    assert.ok(!isTriggerReaction(PROD_EMOJI, triggerEmoji));
  });
});
