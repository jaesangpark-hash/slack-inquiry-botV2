"use strict";
/**
 * 단일 책임: reaction_added 트리거 판정 + 언어쌍 해석 — app.js · 테스트 공유 SSOT
 *
 * app.js는 Bolt App init 시 부팅 side-effect(guard throw + Bolt init)가 발생해
 * 테스트가 직접 import할 수 없다. 따라서 핵심 판정 로직을 이 순수 함수로 추출하여
 * app.js와 테스트가 동일 구현을 공유한다.
 *
 * 왜 언어쌍까지 여기서 보나 — 중일/한일은 마스터 시트도 납품 탭도 다르다. 어느 쪽 문의인지
 * 채널로는 못 가른다(실측 2026-10-21: 문의 110건 중 94건 86%가 공용 채널 `재팬_요청`).
 * APM이 찍는 이모지가 유일하게 확실한 신호라 이모지를 언어별로 나눈다.
 *
 * 기존 `TRIGGER_EMOJI`는 그대로 **중일**이다 — 지금 들어오는 문의가 사실상 전부 중일이라
 * 이미 그 뜻으로 쓰이고 있고, 중일 APM 은 바꿀 게 없다. 새로 만드는 건 한일 이모지 하나뿐.
 * 이 언어는 제목 매칭의 **조회 범위를 자른다**(아래 matchTriggerReaction 주석 참고).
 */

/**
 * 이모지 → 언어쌍 표를 만든다. 새 언어가 늘면 이 맵에 한 줄 추가한다(모듈화 가이드 R7).
 *
 * 지금까지 쓰던 TRIGGER_EMOJI 를 그대로 **중일**로 못박는다 — 오늘 들어오는 문의가 사실상
 * 전부 중일이라(이력 110건 중 한일 0건) 기존 이모지의 실제 의미가 이미 중일이고,
 * 중일 APM 은 바꿀 게 없다. 새로 만드는 건 한일 이모지 하나뿐이다.
 *
 * @param {{ zhJa?: string, koJa?: string }} emojis
 * @returns {Map<string, string>}
 */
function createTriggerEmojiMap({ zhJa, koJa } = {}) {
  // ★둘이 같은 값이면 Map 이 덮여 **모든 소환이 ko-ja** 가 된다. 이모지는 env 로 주는 값이라
  //   복붙 한 번이면 생기는 사고인데, 증상은 "중일 작품을 못 찾는다"로만 보여 원인을 짚기
  //   어렵다. 조용히 틀리느니 부팅에서 멈춘다.
  if (zhJa && koJa && zhJa === koJa) {
    throw new Error(`[trigger] 중일·한일 소환 이모지가 같다(:${zhJa}:). 서로 다른 값을 줘야 언어를 가를 수 있다.`);
  }
  const map = new Map();
  if (zhJa) map.set(zhJa, "zh-ja");
  if (koJa) map.set(koJa, "ko-ja");
  return map;
}

/**
 * reaction 이 트리거인지 보고, 맞으면 어느 언어쌍인지 돌려준다.
 *
 * ★langPair 는 **하드 필터**다. 제목 매칭은 그 언어의 마스터만 본다. 처음엔 양쪽을 다 보고
 * 동점만 가리는 우선순위였는데, 그러면 이모지를 잘못 찍었을 때 조용히 반대 언어 작품을
 * 집는다 — 못 찾고 되묻는 쪽이 낫다(2026-10-28 재상 님 지정).
 * 거르지 않는 자리 둘: PIVO ID 조회(ID 가 작품을 특정한다)와 DM 링크 소환(langPair=null).
 * 못 찾으면 매처가 반대 언어를 한 번 더 보고 wrongLang 으로 알려 준다.
 *
 * @param {string} reaction - event.reaction 값 (Slack이 전달하는 이모지 이름)
 * @param {Map<string, string>|string} trigger - 이모지 맵, 또는 이모지 한 개(구 호출부 호환)
 * @returns {{ langPair: string|null }|false} 트리거가 아니면 false
 */
function matchTriggerReaction(reaction, trigger) {
  if (!reaction) return false;
  // 문자열 한 개로 부르던 종전 호출부 호환 — 그 경우 언어는 미지정이다.
  if (typeof trigger === "string") return reaction === trigger ? { langPair: null } : false;
  if (!trigger || typeof trigger.has !== "function") return false;
  if (!trigger.has(reaction)) return false;
  return { langPair: trigger.get(reaction) ?? null };
}

/**
 * reaction_added 이벤트의 이모지가 트리거 이모지인지 판정.
 *
 * @param {string} reaction
 * @param {Map<string, string|null>|string} trigger
 * @returns {boolean}
 */
function isTriggerReaction(reaction, trigger) {
  return matchTriggerReaction(reaction, trigger) !== false;
}

/**
 * 언어쌍 → 이모지 이름 역조회. 「그 작품은 한일이야, :…: 로 다시 찍어줘」 안내에 쓴다.
 *
 * 안내문에 이모지 이름을 직접 적으면 env 를 바꾼 순간 틀린 안내가 나간다 — 그런데 안내문은
 * 아무도 테스트하지 않아서 틀린 채로 오래 남는다. 실제로 쓰는 맵에서 되찾아 쓴다.
 *
 * @param {Map<string, string>} trigger
 * @param {string} langPair
 * @returns {string|null} 이모지 이름(콜론 없음). 맵에 없으면 null
 */
function emojiForLangPair(trigger, langPair) {
  if (!trigger || typeof trigger.entries !== "function" || !langPair) return null;
  for (const [emoji, lang] of trigger.entries()) if (lang === langPair) return emoji;
  return null;
}

module.exports = { createTriggerEmojiMap, matchTriggerReaction, isTriggerReaction, emojiForLangPair };
