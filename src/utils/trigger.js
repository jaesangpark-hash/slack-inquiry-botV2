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
 * 다만 언어는 **조회 범위를 자르는 데 쓰지 않는다**(아래 matchTriggerReaction 주석 참고).
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
  const map = new Map();
  if (zhJa) map.set(zhJa, "zh-ja");
  if (koJa) map.set(koJa, "ko-ja");
  return map;
}

/**
 * reaction 이 트리거인지 보고, 맞으면 어느 언어쌍인지 돌려준다.
 *
 * ★langPair 는 **하드 필터가 아니라 우선순위**다. 조회는 늘 양쪽 마스터를 다 보고,
 * 이 값은 제목이 양쪽에 걸릴 때 어느 쪽을 먼저 둘지에만 쓴다. 실측상 양쪽 동시 조회는
 * 공짜라(마스터 둘 동시 로드 636ms vs 중일만 680ms, 매칭 0.13→0.28ms) 굳이 한쪽을
 * 잘라낼 이유가 없고, 그래야 이모지를 잘못 찍어도 작품을 못 찾는 일이 안 생긴다.
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

module.exports = { createTriggerEmojiMap, matchTriggerReaction, isTriggerReaction };
