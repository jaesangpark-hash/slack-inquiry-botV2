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
const { isTriggerReaction, matchTriggerReaction, createTriggerEmojiMap } = require("../trigger");

// ── 공통 fixtures ─────────────────────────────────────────────────────────────

const PROD_EMOJI = "문의봇소환";
const DEV_EMOJI  = "문의봇테스트";
const KO_EMOJI   = "한일문의봇소환";

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

  test("한일 이모지가 빠지면 throw — 한일 소환을 못 가린 채 뜨면 안 된다", () => {
    assert.throws(() => assertTriggerEmoji({ TRIGGER_EMOJI: PROD_EMOJI }),
      (err) => err.message.includes("TRIGGER_EMOJI_KO_JA"));
  });

  test("둘 다 있으면 throw 없음", () => {
    assert.doesNotThrow(() => assertTriggerEmoji({ TRIGGER_EMOJI: PROD_EMOJI, TRIGGER_EMOJI_KO_JA: KO_EMOJI }));
  });

  test("dev 이모지 조합도 throw 없음", () => {
    assert.doesNotThrow(() => assertTriggerEmoji({ TRIGGER_EMOJI: DEV_EMOJI, TRIGGER_EMOJI_KO_JA: KO_EMOJI }));
  });
});

// ── 테스트 그룹 2: reaction 분기 + 언어쌍 해석 ────────────────────────────────

describe("reaction 분기 (이모지 맵 기반)", () => {
  /**
   * app.js 핵심 분기를 실 함수로 검증:
   *   const trigger = matchTriggerReaction(emoji, triggerEmojis);
   *   if (!trigger) return;              ← 미통과
   *   const langPair = trigger.langPair; ← 언어쌍
   */
    // 운영과 같은 구성 — 기존 이모지가 곧 중일, 한일만 새 이모지.
  const emojis = createTriggerEmojiMap({ zhJa: PROD_EMOJI, koJa: KO_EMOJI });

  test("기존 이모지 → zh-ja — 중일 APM 은 바꿀 게 없다", () => {
    assert.deepEqual(matchTriggerReaction(PROD_EMOJI, emojis), { langPair: "zh-ja" });
  });

  test("한일 이모지 → ko-ja", () => {
    assert.deepEqual(matchTriggerReaction(KO_EMOJI, emojis), { langPair: "ko-ja" });
  });

  test("등록 안 된 이모지 → 트리거 아님", () => {
    assert.equal(matchTriggerReaction(DEV_EMOJI, emojis), false);
    assert.ok(!isTriggerReaction(DEV_EMOJI, emojis));
  });

  test("dev 이모지만 등록하면 prod 이모지는 안 걸린다 — 환경 분리 유지", () => {
    const devOnly = createTriggerEmojiMap({ zhJa: DEV_EMOJI, koJa: KO_EMOJI });
    assert.ok(isTriggerReaction(DEV_EMOJI, devOnly));
    assert.ok(!isTriggerReaction(PROD_EMOJI, devOnly));
  });

  test("이모지 한 개 문자열로 불러도 동작한다 — 구 호출부 호환", () => {
    assert.deepEqual(matchTriggerReaction(PROD_EMOJI, PROD_EMOJI), { langPair: null });
    assert.equal(matchTriggerReaction(DEV_EMOJI, PROD_EMOJI), false);
  });

  test("설정 안 된 언어는 맵에 안 들어간다 — 빈 값이 '' 이모지로 둔갑하지 않게", () => {
    const partial = createTriggerEmojiMap({ zhJa: PROD_EMOJI, koJa: "" });
    assert.equal(partial.size, 1);
    assert.equal(matchTriggerReaction("", partial), false);
  });
});
