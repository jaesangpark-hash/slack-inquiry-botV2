"use strict";
/**
 * permission-gate.js 단위 테스트
 *
 * node:test + node:assert 빌트인 사용 (신규 dep 추가 금지).
 * 하드코딩 Set membership 검증 — 실 Slack/Totus API 미호출.
 *
 * 검증 항목:
 *   - 화이트리스트 ID → ALLOWED
 *   - 비-화이트리스트 ID → DENY_NOT_ALLOWED
 *   - 빈 문자열 → DENY
 *   - undefined → DENY (Set.has(undefined) = false)
 *   - 대소문자 구분 (Slack user ID는 case-sensitive — 소문자 변형 미허용)
 *   - DI 주입 화이트리스트 치환
 *   - ALLOWED_USER_IDS export 크기 = 10
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { checkPermission, ALLOWED_USER_IDS } = require("../permission-gate");

// ── 테스트 그룹 1: 화이트리스트 ID → ALLOWED ────────────────────────────────

describe("화이트리스트 ID 허용", () => {
  test("목록 첫 ID (UBRE3KL5A) → ALLOWED", () => {
    const result = checkPermission("UBRE3KL5A");
    assert.equal(result.allowed, true);
    assert.equal(result.reason, "ALLOWED");
  });

  test("정태영 ID (U05CE8HFA6B) → ALLOWED", () => {
    const result = checkPermission("U05CE8HFA6B");
    assert.equal(result.allowed, true);
    assert.equal(result.reason, "ALLOWED");
  });

  test("목록 마지막 ID (U06MUFY0JH3) → ALLOWED", () => {
    const result = checkPermission("U06MUFY0JH3");
    assert.equal(result.allowed, true);
    assert.equal(result.reason, "ALLOWED");
  });
});

// ── 테스트 그룹 2: 비-화이트리스트 ID → DENY_NOT_ALLOWED ───────────────────

describe("비-화이트리스트 ID 거부", () => {
  test("미등록 ID (UXXXXXXXX) → DENY_NOT_ALLOWED", () => {
    const result = checkPermission("UXXXXXXXX");
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "DENY_NOT_ALLOWED");
  });

  test("빈 문자열 → DENY_NOT_ALLOWED", () => {
    const result = checkPermission("");
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "DENY_NOT_ALLOWED");
  });

  test("undefined → DENY_NOT_ALLOWED (Set.has(undefined) = false)", () => {
    const result = checkPermission(undefined);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "DENY_NOT_ALLOWED");
  });
});

// ── 테스트 그룹 3: 대소문자 구분 ─────────────────────────────────────────────

describe("대소문자 구분 (Slack user ID는 case-sensitive)", () => {
  test("소문자 변형 (ubre3kl5a) → DENY (소문자 정규화 없음)", () => {
    const result = checkPermission("ubre3kl5a");
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "DENY_NOT_ALLOWED");
  });

  test("혼합 대소문자 (Ubre3Kl5A) → DENY", () => {
    const result = checkPermission("Ubre3Kl5A");
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "DENY_NOT_ALLOWED");
  });
});

// ── 테스트 그룹 4: DI 주입 화이트리스트 치환 ────────────────────────────────

describe("DI 주입 화이트리스트 치환", () => {
  test("deps.allowedUserIds 주입 시 해당 ID만 허용", () => {
    const customList = new Set(["UTEST123"]);
    const resultAllowed = checkPermission("UTEST123", { allowedUserIds: customList });
    assert.equal(resultAllowed.allowed, true);

    const resultDeny = checkPermission("UBRE3KL5A", { allowedUserIds: customList });
    assert.equal(resultDeny.allowed, false);
  });

  test("빈 Set 주입 시 모든 ID 거부", () => {
    const emptyList = new Set();
    const result = checkPermission("UBRE3KL5A", { allowedUserIds: emptyList });
    assert.equal(result.allowed, false);
  });
});

// ── 테스트 그룹 5: ALLOWED_USER_IDS export 크기 ─────────────────────────────

describe("ALLOWED_USER_IDS export", () => {
  test("ALLOWED_USER_IDS.size === 10", () => {
    assert.equal(ALLOWED_USER_IDS.size, 10);
  });

  test("ALLOWED_USER_IDS는 Set 인스턴스", () => {
    assert.ok(ALLOWED_USER_IDS instanceof Set);
  });
});
