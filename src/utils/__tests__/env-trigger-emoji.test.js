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
const { isTriggerReaction, matchTriggerReaction, createTriggerEmojiMap, emojiForLangPair } = require("../trigger");

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

  // ★값이 같으면 이모지→언어쌍 표가 덮여 모든 소환이 한일이 된다. 부팅에서 잡는다.
  test("둘이 같은 값이면 throw — 조용히 전부 한일로 처리되느니 안 뜨는 게 낫다", () => {
    assert.throws(
      () => assertTriggerEmoji({ TRIGGER_EMOJI: PROD_EMOJI, TRIGGER_EMOJI_KO_JA: PROD_EMOJI }),
      /같다/,
    );
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

  // ★두 env 에 같은 값을 넣으면 Map 이 덮여 모든 소환이 ko-ja 가 된다. 증상은 "중일 작품을
  //   못 찾는다"로만 보여 원인을 짚기 어렵다 — 조용히 틀리느니 부팅에서 멈춘다.
  test("중일·한일 이모지가 같으면 부팅에서 멈춘다", () => {
    assert.throws(
      () => createTriggerEmojiMap({ zhJa: PROD_EMOJI, koJa: PROD_EMOJI }),
      /같다/,
      "덮어써진 채로 뜨면 중일 소환이 전부 한일로 처리된다",
    );
  });

  test("한쪽만 있으면 같은 값 검사에 걸리지 않는다", () => {
    assert.doesNotThrow(() => createTriggerEmojiMap({ zhJa: PROD_EMOJI }));
    assert.doesNotThrow(() => createTriggerEmojiMap({ koJa: KO_EMOJI }));
  });
});

describe("emojiForLangPair — 안내문의 이모지 이름 역조회", () => {
  const emojis = createTriggerEmojiMap({ zhJa: PROD_EMOJI, koJa: KO_EMOJI });

  test("언어쌍으로 이모지 이름을 되찾는다 — 안내문 하드코딩을 없애려고", () => {
    assert.equal(emojiForLangPair(emojis, "ko-ja"), KO_EMOJI);
    assert.equal(emojiForLangPair(emojis, "zh-ja"), PROD_EMOJI);
  });

  test("없는 언어·빈 맵이면 null — 안내문에서 그 문장만 빠지게", () => {
    assert.equal(emojiForLangPair(emojis, "en-ja"), null);
    assert.equal(emojiForLangPair(new Map(), "ko-ja"), null);
    assert.equal(emojiForLangPair(null, "ko-ja"), null);
  });
});
