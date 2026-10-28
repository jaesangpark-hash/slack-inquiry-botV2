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
 * 기존 `TRIGGER_EMOJI`는 없애지 않고 **"언어 미지정"**으로 남긴다. 과도기에 APM이 예전 이모지를
 * 그대로 찍어도 봇이 멈추지 않아야 하고, 그때는 종전처럼 양쪽을 다 뒤지면 된다.
 */

/**
 * 이모지 → 언어쌍 표를 만든다. 새 언어가 늘면 이 맵에 한 줄 추가한다(모듈화 가이드 R7).
 * 값이 null 이면 "트리거는 맞지만 언어는 안 밝혔다"는 뜻이다.
 *
 * @param {{ unspecified?: string, zhJa?: string, koJa?: string }} emojis
 * @returns {Map<string, string|null>}
 */
function createTriggerEmojiMap({ unspecified, zhJa, koJa } = {}) {
  const map = new Map();
  if (unspecified) map.set(unspecified, null);
  if (zhJa) map.set(zhJa, "zh-ja");
  if (koJa) map.set(koJa, "ko-ja");
  return map;
}

/**
 * reaction 이 트리거인지 보고, 맞으면 어느 언어쌍인지 돌려준다.
 *
 * @param {string} reaction - event.reaction 값 (Slack이 전달하는 이모지 이름)
 * @param {Map<string, string|null>|string} trigger - 이모지 맵, 또는 이모지 한 개(구 호출부 호환)
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
