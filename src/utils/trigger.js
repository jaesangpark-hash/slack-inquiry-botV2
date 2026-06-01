"use strict";
/**
 * reaction_added 이벤트 트리거 판정 — app.js · 테스트 공유 SSOT
 *
 * app.js는 Bolt App init 시 부팅 side-effect(guard throw + Bolt init)가 발생해
 * 테스트가 직접 import할 수 없다. 따라서 핵심 판정 로직을 이 순수 함수로 추출하여
 * app.js와 테스트가 동일 구현을 공유한다.
 */

/**
 * reaction_added 이벤트의 이모지가 트리거 이모지인지 판정.
 *
 * @param {string} reaction - event.reaction 값 (Slack이 전달하는 이모지 이름)
 * @param {string} triggerEmoji - TRIGGER_EMOJI 환경변수에서 읽은 값
 * @returns {boolean}
 */
function isTriggerReaction(reaction, triggerEmoji) {
  return reaction === triggerEmoji;
}

module.exports = { isTriggerReaction };
