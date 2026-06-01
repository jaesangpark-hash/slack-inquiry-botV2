"use strict";
/**
 * sheets/delivery-date.js 단위 테스트
 *
 * node:test + node:assert 빌트인 사용 (신규 dep 추가 금지).
 * factory DI — fake alertOnError + fake google.sheets 주입으로 실 Google API 없이 검증.
 *
 * 검증 항목:
 *   parseEpisodeNumbers:
 *     - 단일 숫자 ("49화" → [49])
 *     - 범위 ("130-132화" → [130, 131, 132])
 *     - 話 단위 ("130話" → [130])
 *     - 빈값/null → []
 *     - 숫자 아닌 문자열 → []
 *   fetchDeliveryDate:
 *     - 한국어 workNameKo 완전 일치 매칭 + 에피소드 일치 → 납품일 반환
 *     - projectName 대체 needle 매칭 (needleAlt 경로)
 *     - 에피소드 미일치 → 확인 불가
 *     - 매칭 행 0건 → null
 *     - 복수 에피소드 동일 납품일 → allSame=true
 *     - 복수 에피소드 다른 납품일 → allSame=false
 *
 * fixture self-fulfilling 금지:
 *   needle과 시트 B열 데이터를 의도적으로 다른 형태로 구성 (정규화·부분일치 효과 검증).
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const createDeliveryDateService = require("../delivery-date");

// ── fake 빌더 ─────────────────────────────────────────────────────────────────
// 납품 시트 행 구조 (A열부터):
//   [0]=A, [1]=B(작품명), [2]=C(PM), [3]=D(APM), [4]=E(화수), [5]=F, [6]=G(납품일)
function makeDeliveryRow({ workName, pm = "PM1", apm = "APM1", episode, deliveryDate }) {
  return ["A1", workName, pm, apm, String(episode), "F열", deliveryDate];
}

// fake sheetsClient: getValues → 헤더 포함 rows 반환
function makeFakeSheetsClient(rows) {
  const values = [["header"], ...rows];
  return {
    getValues: async (_spreadsheetId, _range) => values,
  };
}

const fakeAlertOnError = async (_label, fn) => fn();

// ── 공통 service 팩토리 ───────────────────────────────────────────────────────
function makeService(rows) {
  return createDeliveryDateService({
    deliverySheetId: "fake-sheet-id",
    deliverySheetZhJa: "시트명!A:G",
    deliverySheetKoJa: "한일시트!A:G",
    alertOnError: fakeAlertOnError,
    sheetsClient: makeFakeSheetsClient(rows),
  });
}

// ── parseEpisodeNumbers 테스트 ────────────────────────────────────────────────

describe("parseEpisodeNumbers", () => {
  const { parseEpisodeNumbers } = makeService([]);

  test("단일 숫자 문자열 → 단일 배열", () => {
    assert.deepStrictEqual(parseEpisodeNumbers("49"), [49]);
  });

  test("'화' 접미사 제거 후 파싱", () => {
    assert.deepStrictEqual(parseEpisodeNumbers("49화"), [49]);
  });

  test("'話' 단위(일본어) 제거 후 파싱", () => {
    assert.deepStrictEqual(parseEpisodeNumbers("130話"), [130]);
  });

  test("범위 표현 (하이픈) → 배열 확장", () => {
    assert.deepStrictEqual(parseEpisodeNumbers("130-132"), [130, 131, 132]);
  });

  test("범위 표현 (물결) → 배열 확장", () => {
    assert.deepStrictEqual(parseEpisodeNumbers("5~7"), [5, 6, 7]);
  });

  test("null → 빈 배열", () => {
    assert.deepStrictEqual(parseEpisodeNumbers(null), []);
  });

  test("undefined → 빈 배열", () => {
    assert.deepStrictEqual(parseEpisodeNumbers(undefined), []);
  });

  test("숫자 아닌 문자열 → 빈 배열", () => {
    assert.deepStrictEqual(parseEpisodeNumbers("없음"), []);
  });

  test("0 (falsy지만 유효한 숫자) → [0]", () => {
    // ep === 0 조건 확인 (함수 정의: if (!ep && ep !== 0) return [])
    assert.deepStrictEqual(parseEpisodeNumbers(0), [0]);
  });
});

// ── fetchDeliveryDate 테스트 ──────────────────────────────────────────────────

describe("fetchDeliveryDate", () => {
  test("workNameKo 부분 일치 + 에피소드 일치 → 납품일 반환", async () => {
    // 시트 B열 "검사나리 단행본 전권" — needle "검사나리"가 포함됨 (부분일치 경로 검증)
    const service = makeService([
      makeDeliveryRow({ workName: "검사나리 단행본 전권", episode: 49, deliveryDate: "2026-07-01" }),
    ]);
    const result = await service.fetchDeliveryDate("검사나리", "49");
    assert.ok(result, "결과가 있어야 함");
    assert.strictEqual(result.episodes[0].deliveryDate, "2026-07-01");
    assert.strictEqual(result.episodes[0].episode, 49);
  });

  test("projectName needleAlt 경로 — ko가 중국어 원제일 때 projectName으로 매칭", async () => {
    // B열 "살아남기프로젝트" — workNameKo "중국어원제"는 미일치, projectName "살아남기프로젝트"로 매칭
    const service = makeService([
      makeDeliveryRow({ workName: "살아남기프로젝트", episode: 10, deliveryDate: "2026-08-01" }),
    ]);
    const result = await service.fetchDeliveryDate("중국어원제", "10", "zh-ja", "살아남기프로젝트");
    assert.ok(result, "needleAlt 경로 결과가 있어야 함");
    assert.strictEqual(result.episodes[0].deliveryDate, "2026-08-01");
  });

  test("에피소드 미일치 → deliveryDate '확인 불가'", async () => {
    const service = makeService([
      makeDeliveryRow({ workName: "테스트작품", episode: 100, deliveryDate: "2026-06-01" }),
    ]);
    // 화수 99는 시트에 없음 → "확인 불가"
    const result = await service.fetchDeliveryDate("테스트작품", "99");
    assert.ok(result, "결과 객체는 반환돼야 함");
    assert.strictEqual(result.episodes[0].deliveryDate, "확인 불가");
  });

  test("에피소드 파싱 불가(null) → null 반환", async () => {
    const service = makeService([
      makeDeliveryRow({ workName: "작품A", episode: 10, deliveryDate: "2026-05-01" }),
    ]);
    // parseEpisodeNumbers(null) → [] → results 빈 배열 → null 반환
    const result = await service.fetchDeliveryDate("작품A", null);
    assert.strictEqual(result, null);
  });

  test("복수 에피소드 동일 납품일 → allSame=true, episodeLabel 범위 형식", async () => {
    const service = makeService([
      makeDeliveryRow({ workName: "범위작품", episode: 5, deliveryDate: "2026-09-01" }),
      makeDeliveryRow({ workName: "범위작품", episode: 6, deliveryDate: "2026-09-01" }),
      makeDeliveryRow({ workName: "범위작품", episode: 7, deliveryDate: "2026-09-01" }),
    ]);
    const result = await service.fetchDeliveryDate("범위작품", "5-7");
    assert.ok(result);
    assert.strictEqual(result.allSame, true);
    assert.strictEqual(result.deliveryDate, "2026-09-01");
    assert.strictEqual(result.episodeLabel, "5-7화");
  });

  test("복수 에피소드 다른 납품일 → allSame=false, deliveryDate=null", async () => {
    const service = makeService([
      makeDeliveryRow({ workName: "다른날작품", episode: 1, deliveryDate: "2026-10-01" }),
      makeDeliveryRow({ workName: "다른날작품", episode: 2, deliveryDate: "2026-10-15" }),
    ]);
    const result = await service.fetchDeliveryDate("다른날작품", "1-2");
    assert.ok(result);
    assert.strictEqual(result.allSame, false);
    assert.strictEqual(result.deliveryDate, null);
  });
});
