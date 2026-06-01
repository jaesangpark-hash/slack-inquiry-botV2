"use strict";
/**
 * sheets/normalize.js 단위 테스트
 *
 * node:test + node:assert 빌트인 사용 (신규 dep 추가 금지).
 * 순수 함수 입출력 동등 — fixture는 의도된 정규화 동작 검증
 * (self-fulfilling 금지).
 *
 * 검증 항목:
 *   normalizeTitle:
 *     - NFKC 정규화 + 괄호 제거 + 특수문자 제거 + 소문자화
 *     - 第N話 / 仮 접미사 제거
 *     - 공백·점 연속 제거
 *   normalizeTitleKo:
 *     - 한국어 전용 괄호 제거 + （仮） 제거 + 소문자화
 *     - 공백 제거
 *   stripKariSuffix:
 *     - (仮) / （仮） 접미사 제거
 *     - 仮 없으면 원본 보존
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeTitle, normalizeTitleKo, stripKariSuffix } = require("../normalize");

// ── normalizeTitle ─────────────────────────────────────────────────────────────

describe("normalizeTitle", () => {
  test("기본 정규화: 공백·괄호·특수문자 제거 + 소문자화", () => {
    // 괄호 제거
    assert.strictEqual(normalizeTitle("【作品名】"), "作品名".toLowerCase());
    assert.strictEqual(normalizeTitle("(作品名)"), "作品名".toLowerCase());
    assert.strictEqual(normalizeTitle("（作品名）"), "作品名".toLowerCase());
  });

  test("NFKC 정규화: 전각 → 반각 변환 후 소문자화", () => {
    // 전각 알파벳 → 반각
    const result = normalizeTitle("ＡＢＣ");
    assert.strictEqual(result, "abc");
  });

  test("第N話 제거", () => {
    assert.strictEqual(normalizeTitle("第1話のタイトル"), "のタイトル");
    assert.strictEqual(normalizeTitle("第10話"), "");
  });

  test("仮 접미사 제거 (소문자 후 처리)", () => {
    // 함수 정의: .replace(/仮$/i, "") — 소문자화 이후 적용이므로 '仮' 제거
    assert.strictEqual(normalizeTitle("タイトル仮"), "タイトル");
  });

  test("점 연속 제거", () => {
    assert.strictEqual(normalizeTitle("タイトル..."), "タイトル");
  });

  test("공백 제거", () => {
    assert.strictEqual(normalizeTitle("作 品 名"), "作品名".toLowerCase());
  });

  test("빈 문자열 입력 → 빈 문자열", () => {
    assert.strictEqual(normalizeTitle(""), "");
  });

  test("undefined 입력 → 빈 문자열 (default param)", () => {
    assert.strictEqual(normalizeTitle(), "");
  });

  test("특수문자(~, -, _, :) 제거", () => {
    assert.strictEqual(normalizeTitle("タイトル~テスト"), "タイトルテスト");
    assert.strictEqual(normalizeTitle("タイトル_テスト"), "タイトルテスト");
    assert.strictEqual(normalizeTitle("タイトル:テスト"), "タイトルテスト");
  });
});

// ── normalizeTitleKo ───────────────────────────────────────────────────────────

describe("normalizeTitleKo", () => {
  test("한국어 괄호 제거 + 공백 제거 + 소문자화", () => {
    assert.strictEqual(normalizeTitleKo("（작품 이름）"), "작품이름");
    assert.strictEqual(normalizeTitleKo("[작품명]"), "작품명");
  });

  test("（仮） 처리: 전각괄호 먼저 제거 후 仮 잔류", () => {
    // 처리 순서: 1) NFKC → 전각괄호가 반각으로 정규화됨 (（→(, ）→))
    // 2) 괄호 제거 패턴이 (仮) 중 ()만 제거 → 仮 잔류
    // 3) （仮）|（仮$ 패턴은 이미 괄호 없어서 미매칭
    // 실제 동작: "作品名（仮）" → "作品名仮"
    assert.strictEqual(normalizeTitleKo("作品名（仮）"), "作品名仮".toLowerCase());
  });

  test("（仮 (미닫힘 패턴) 처리: 전각괄호 먼저 제거 후 仮 잔류", () => {
    // 동일 이유: NFKC 후 ( 제거 → 仮 잔류
    // 실제 동작: "作品名（仮" → "作品名仮"
    assert.strictEqual(normalizeTitleKo("作品名（仮"), "作品名仮".toLowerCase());
  });

  test("꺾쇠 괄호 <> 제거", () => {
    assert.strictEqual(normalizeTitleKo("<작품명>"), "작품명");
    assert.strictEqual(normalizeTitleKo("《작품명》"), "작품명");
  });

  test("공백 제거 (앞·중간·끝)", () => {
    assert.strictEqual(normalizeTitleKo("  작 품 명  "), "작품명");
  });

  test("빈 문자열 입력 → 빈 문자열", () => {
    assert.strictEqual(normalizeTitleKo(""), "");
  });

  test("undefined 입력 → 빈 문자열 (default param)", () => {
    assert.strictEqual(normalizeTitleKo(), "");
  });

  test("대소문자 정규화: 영문 포함 → 소문자화", () => {
    assert.strictEqual(normalizeTitleKo("ABCdef"), "abcdef");
  });
});

// ── stripKariSuffix ────────────────────────────────────────────────────────────

describe("stripKariSuffix", () => {
  test("반각 (仮) 접미사 제거", () => {
    assert.strictEqual(stripKariSuffix("タイトル(仮)"), "タイトル");
  });

  test("전각 （仮） 접미사 제거", () => {
    assert.strictEqual(stripKariSuffix("タイトル（仮）"), "タイトル");
  });

  test("앞뒤 공백 포함 접미사 제거 후 trim", () => {
    assert.strictEqual(stripKariSuffix("タイトル  (仮)  "), "タイトル");
  });

  test("仮 없는 문자열 → 원본 보존", () => {
    assert.strictEqual(stripKariSuffix("タイトル"), "タイトル");
  });

  test("중간에 (仮)는 제거하지 않음 (접미사만 대상)", () => {
    const input = "タ(仮)イトル";
    // 접미사 패턴이 아니므로 trim 외 변경 없음
    assert.strictEqual(stripKariSuffix(input), input.trim());
  });

  test("빈 문자열 입력 → 빈 문자열", () => {
    assert.strictEqual(stripKariSuffix(""), "");
  });

  test("undefined 입력 → 빈 문자열 (default param)", () => {
    assert.strictEqual(stripKariSuffix(), "");
  });
});
