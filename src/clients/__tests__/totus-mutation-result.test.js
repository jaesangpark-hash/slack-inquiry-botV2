"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  assertGloballyUniqueCreatedTaskUuids,
  assertCompleteMutationTargets,
  assertNoAmbiguousMutationTargets,
  decodeMutationResult,
  requireCreatedTaskUuids,
  toUnknownMutationOutcome,
} = require("../totus-mutation-result");

describe("Totus mutation result contract", () => {
  test("기대 대상이 모두 있으면 완전성 검사를 통과한다", () => {
    assert.doesNotThrow(() => assertCompleteMutationTargets(
      ["1화/OTC0012", "2화/OTC0012"],
      ["2화/OTC0012", "1화/OTC0012"],
      "일정"
    ));
  });

  test("하나라도 누락되면 누락 대상을 포함한 확정 오류를 낸다", () => {
    assert.throws(
      () => assertCompleteMutationTargets(
        ["1화/OTC0012", "2화/OTC0012"],
        ["1화/OTC0012"],
        "일정"
      ),
      error => error.code === "INCOMPLETE_MUTATION_TARGETS" &&
        error.message.includes("2화/OTC0012")
    );
  });

  test("success=false와 부분 실패는 안전 재시도 가능한 확정 실패다", () => {
    assert.throws(
      () => decodeMutationResult({ success: false, error: { message: "rejected" } }, "일정"),
      error => error.code === "CONFIRMED_MUTATION_FAILURE" && error.safeToRetry === true
    );
    assert.throws(
      () => decodeMutationResult({ success: true, data: { 실패: 1, 실패UUID목록: ["T1"] } }, "일정"),
      error => error.code === "CONFIRMED_MUTATION_FAILURE" && error.message.includes("T1")
    );
  });

  test("성공 응답에 생성 UUID가 없으면 결과 불확정으로 분류한다", () => {
    assert.throws(
      () => requireCreatedTaskUuids({ success: true, data: { createdTaskUuids: [] } }, "리테이크"),
      error => error.code === "UNKNOWN_MUTATION_OUTCOME" && error.reviewRequired === true
    );
  });

  test("비어 있거나 중복된 생성 UUID는 결과 불확정으로 분류한다", () => {
    for (const createdTaskUuids of [[""], [null], ["T1", "T1"]]) {
      assert.throws(
        () => requireCreatedTaskUuids({ success: true, data: { createdTaskUuids } }, "리테이크"),
        error => error.code === "UNKNOWN_MUTATION_OUTCOME" && error.reviewRequired === true
      );
    }
  });

  test("서로 다른 회차가 같은 생성 UUID를 가지면 결과 불확정으로 분류한다", () => {
    assert.throws(
      () => assertGloballyUniqueCreatedTaskUuids({
        1: ["T1"],
        2: ["T1"],
      }, "일괄 리테이크"),
      error => error.code === "UNKNOWN_MUTATION_OUTCOME"
        && error.reviewRequired === true
        && error.message.includes("1화와 2화")
    );
  });

  test("동일 의미 대상 후보가 여러 개면 외부 변경 전 확정 오류를 낸다", () => {
    assert.throws(
      () => assertNoAmbiguousMutationTargets(["1화/OTC0012"], "일정"),
      error => error.code === "AMBIGUOUS_MUTATION_TARGETS" &&
        error.message.includes("1화/OTC0012")
    );
  });

  test("POST transport 예외는 원인을 보존한 결과 불확정 오류로 감싼다", () => {
    const error = toUnknownMutationOutcome(new Error("socket closed"), "리테이크");
    assert.equal(error.code, "UNKNOWN_MUTATION_OUTCOME");
    assert.equal(error.cause.message, "socket closed");
  });
});
