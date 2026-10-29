"use strict";
/**
 * utils/ack-budget.js — 모달 ack 3초 예산 단위 테스트
 *
 * node:test + node:assert 빌트인 (신규 dep 추가 금지).
 *
 * 검증 항목:
 *   - 예산 안에 끝나면 값을 그대로 준다 (평소 경로 — 창 안 오류 표시가 살아 있어야 한다)
 *   - 예산을 넘기면 timedOut 으로 알리고, 원래 promise 는 버리지 않는다
 *     (호출부가 ack 뒤에 다시 await 해서 결과를 쓴다 — 이게 깨지면 느린 날 작품이 통째로 빠진다)
 *   - 조회가 실패하면 "못 찾음"과 같게 null 로 준다 (호출부 분기를 두 벌 만들지 않으려고)
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { withinAckBudget, ACK_BUDGET_MS } = require("../ack-budget");

const after = (ms, value) => new Promise((r) => setTimeout(() => r(value), ms));

describe("withinAckBudget", () => {
  test("예산 안에 끝나면 값을 그대로 준다", async () => {
    const r = await withinAckBudget(after(5, { koreanProjectName: "작품A" }), 200);
    assert.equal(r.timedOut, false);
    assert.deepEqual(r.value, { koreanProjectName: "작품A" });
  });

  test("예산을 넘기면 timedOut — 창부터 닫을 수 있게", async () => {
    const r = await withinAckBudget(after(120, "늦게 온 값"), 20);
    assert.equal(r.timedOut, true);
    assert.equal(r.value, null);
  });

  test("timedOut 이어도 원래 promise 는 살아 있다 — ack 뒤에 마저 기다려 쓴다", async () => {
    const slow = after(60, "늦게 온 값");
    const r = await withinAckBudget(slow, 10);
    assert.equal(r.timedOut, true);
    assert.equal(await slow, "늦게 온 값", "버려지면 느린 날 작품이 통째로 빠진다");
  });

  test("조회가 실패하면 못 찾음과 같게 null", async () => {
    const r = await withinAckBudget(Promise.reject(new Error("Sheets 500")), 200);
    assert.equal(r.timedOut, false);
    assert.equal(r.value, null);
  });

  test("기본 예산은 Slack 3초 제한보다 짧다", () => {
    assert.ok(ACK_BUDGET_MS < 3000, `3초를 넘기면 예산을 두는 의미가 없다 (현재 ${ACK_BUDGET_MS}ms)`);
  });
});
