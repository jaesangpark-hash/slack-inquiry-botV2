"use strict";
/**
 * 단일 책임: Slack 모달 제출의 3초 ack 제한을 넘기지 않게 조회에 시간 예산을 둔다.
 *
 * 왜 필요한가 — 모달 제출(view_submission)은 3초 안에 ack 해야 한다. 그런데 입력값이
 * 틀렸다고 **창 안에** 오류를 띄우려면(`response_action: "errors"`) 틀렸는지를 ack 전에
 * 알아야 하고, 그러려면 시트를 먼저 조회해야 한다. 캐시가 식었거나 Sheets 가 느린 날엔
 * 이 조회가 3초를 넘겨 사용자에게 Slack 기본 오류창이 뜬다 — 입력한 내용도 날아간다.
 *
 * 그래서 조회에 예산을 준다. 예산 안에 끝나면 평소대로 창 안에서 막을 수 있고,
 * 넘기면 일단 창을 닫아 두고(ack) 조회는 뒤에서 마저 기다린다. 느린 날에 잃는 건
 * "창 안 오류 표시" 하나뿐이고, 그건 DM 으로 대신 알리면 된다.
 *
 * @see https://api.slack.com/surfaces/modals#handling_submissions
 */

/** 3초 제한에서 네트워크 왕복분을 뺀 여유. 실측이 아니라 안전 마진이다. */
const ACK_BUDGET_MS = 2200;

const TIMED_OUT = Symbol("ack-budget-timeout");

/**
 * promise 를 예산 안에서 기다린다. 넘기면 timedOut 으로 돌려주고, promise 자체는
 * 버리지 않는다 — 호출부가 ack 뒤에 다시 await 해서 결과를 쓸 수 있다.
 *
 * 조회가 실패(reject)하면 값 없음(null)으로 본다. 못 찾은 것과 같게 다뤄야
 * 호출부가 분기를 두 벌 쓰지 않는다.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} [ms]
 * @returns {Promise<{ timedOut: boolean, value: T|null }>}
 */
async function withinAckBudget(promise, ms = ACK_BUDGET_MS) {
  let timer;
  // 실패는 "못 찾음"과 같게 null 로 본다 — 호출부가 분기를 두 벌 쓰지 않게. 다만 삼키지는
  // 않는다(R6): 조회가 왜 죽었는지는 로그로 남겨야 원인을 쫓을 수 있다.
  const settled = Promise.resolve(promise).catch((e) => {
    console.error("[ack-budget] 조회 실패 — 못 찾음으로 처리:", e?.message ?? e);
    return null;
  });
  const budget = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  const winner = await Promise.race([settled, budget]);
  clearTimeout(timer);
  return winner === TIMED_OUT ? { timedOut: true, value: null } : { timedOut: false, value: winner };
}

module.exports = { withinAckBudget, ACK_BUDGET_MS };
