"use strict";
/**
 * sheets/title-matcher.js 단위 테스트
 *
 * node:test + node:assert 빌트인 사용 (신규 dep 추가 금지).
 * factory DI — fake alertOnError + fake google.sheets 주입으로 실 Google API 없이 검증.
 *
 * 검증 항목:
 *   matchWorkTitleFromSheet:
 *     - 1순위: 한국어 프로젝트명 완전 일치
 *     - 2순위: 한국어 프로젝트명 부분 일치
 *     - 3순위: 일본어 표시명 완전 일치 (仮 제거 후 normalizeTitle)
 *     - 4순위: 일본어 표시명 부분 일치
 *     - 매칭 실패 → null
 *   matchWorkTitleByTokens:
 *     - 한국어 토큰 단건 → { single }
 *     - 한국어 토큰 복수 → { multiple }
 *     - 토큰 2자 미만 필터
 *     - 일본어 토큰 매칭 단건 → { single }
 *     - 모두 null → null
 *   matchWorkTitleWithCandidates:
 *     - 1순위 완전일치 → { single }
 *     - 2순위 부분일치 단건 → { single }
 *     - 2순위 부분일치 복수(≤5) → { multiple }
 *     - 2순위 부분일치 복수(>5) → { tooMany }
 *     - 3순위 일본어 완전일치 → { single }
 *     - 4순위 일본어 부분일치 → { single }
 *     - 실패 → null
 *
 * fixture self-fulfilling 금지:
 *   input이 expected의 byte 거울이 아닌 매칭 로직 의도(부분일치·토큰·정규화 효과)를 검증하는 입력으로 구성.
 */

const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const createTitleMatcher = require("../title-matcher");

// ── fake 빌더 ─────────────────────────────────────────────────────────────────
// 마스터 시트 행 구조 (탭 '출판사 드라이브 링크', A:H):
//   row[0]=A(APM), row[1]=B(중국어 원제), row[2]=C(한국어 프로젝트명), row[3]=D(일본어 표시명),
//   row[4]=E(일본어 FIX 타이틀), row[5]=F(미정), row[6]=G(출판사), row[7]=H(드라이브 링크), row[8]=I(PIVO ID)
function makeRow({
  pivoId = "p1",
  japaneseFixedTitle = "",
  japaneseDisplayTitle = "",
  chineseOriginalTitle = "",
  koreanProjectName = "",
}) {
  return [
    "",
    chineseOriginalTitle,
    koreanProjectName,
    japaneseDisplayTitle,
    japaneseFixedTitle,
    "", "", "",
    pivoId,
  ];
}

// fake sheetsClient: getValues → 헤더 포함 rows 반환 (slice(1)로 헤더 제거됨)
function makeFakeSheetsClient(rows) {
  const values = [["header"], ...rows];
  return {
    getValues: async (_spreadsheetId, _range) => values,
  };
}

// alertOnError: 콜백을 그냥 실행하는 pass-through fake
const fakeAlertOnError = async (_label, fn) => fn();

// ── 테스트용 시트 데이터 ──────────────────────────────────────────────────────
// 실 데이터 형태를 반영한 fixture (byte-거울 금지: needle과 다른 문자열로 구성)
const FIXTURE_ROWS = [
  makeRow({ pivoId: "p1", japaneseDisplayTitle: "タイトルA（仮）", chineseOriginalTitle: "중국어제목A", koreanProjectName: "작품A" }),
  makeRow({ pivoId: "p2", japaneseDisplayTitle: "タイトルB", chineseOriginalTitle: "중국어제목B", koreanProjectName: "작품B 시즌1" }),
  makeRow({ pivoId: "p3", japaneseDisplayTitle: "別のタイトル", chineseOriginalTitle: "다른제목", koreanProjectName: "별도작품" }),
  makeRow({ pivoId: "p4", japaneseDisplayTitle: "부분 포함 작품", koreanProjectName: "포함된작품이름" }),
  makeRow({ pivoId: "p5", japaneseDisplayTitle: "テスト作品X", chineseOriginalTitle: "테스트X", koreanProjectName: "테스트작품X" }),
  makeRow({ pivoId: "p6", japaneseDisplayTitle: "あいう", chineseOriginalTitle: "나타1", koreanProjectName: "나타1작품" }),
  makeRow({ pivoId: "p7", chineseOriginalTitle: "나타2", koreanProjectName: "나타2작품" }),
];

// CANDIDATE_MAX(5) 초과를 위한 추가 행 (부분 일치 tooMany 검증)
const FIXTURE_ROWS_MANY = [
  ...Array.from({ length: 6 }, (_, i) =>
    makeRow({ pivoId: `pm${i}`, japaneseDisplayTitle: `マンガ${i}`, koreanProjectName: `공통이름작품${i}` })
  ),
];

// ── 테스트 ────────────────────────────────────────────────────────────────────

describe("matchWorkTitleFromSheet", () => {
  let matcher;
  beforeEach(() => {
    matcher = createTitleMatcher({
      masterSheetId: "fake-sheet-id",
      alertOnError: fakeAlertOnError,
      sheetsClient: makeFakeSheetsClient(FIXTURE_ROWS),
    });
  });

  test("1순위: 한국어 프로젝트명 완전 일치 → 해당 행 반환", async () => {
    // needle: "작품A" → projectName 정확히 일치
    const result = await matcher.matchWorkTitleFromSheet(null, "작품A");
    assert.ok(result, "매칭 결과가 있어야 함");
    assert.strictEqual(result.pivoId, "p1");
    assert.strictEqual(result.koreanProjectName, "작품A");
  });

  test("2순위: 한국어 프로젝트명 부분 일치 (needle이 projectName의 부분 문자열)", async () => {
    // "시즌1"은 "작품B 시즌1"의 부분 — 완전일치 실패 후 부분일치 진입
    const result = await matcher.matchWorkTitleFromSheet(null, "시즌1");
    assert.ok(result, "부분 일치 결과가 있어야 함");
    assert.strictEqual(result.pivoId, "p2");
  });

  test("3순위: 일본어 표시명 완전 일치 (仮 제거 + normalizeTitle 적용)", async () => {
    // "タイトルA（仮）"의 仮가 제거된 후 normalizeTitle 일치
    const result = await matcher.matchWorkTitleFromSheet("タイトルA（仮）", null);
    assert.ok(result, "일본어 완전일치 결과가 있어야 함");
    assert.strictEqual(result.pivoId, "p1");
  });

  test("4순위: 일본어 표시명 부분 일치 (needle이 jaNorm의 부분 문자열)", async () => {
    // "別の"는 "別のタイトル" normalizeTitle 결과의 부분 — 부분 일치
    const result = await matcher.matchWorkTitleFromSheet("別の", null);
    assert.ok(result, "일본어 부분일치 결과가 있어야 함");
    assert.strictEqual(result.pivoId, "p3");
  });

  test("매칭 실패 → null", async () => {
    const result = await matcher.matchWorkTitleFromSheet("존재하지않는작품", "없는제목");
    assert.strictEqual(result, null);
  });

  test("titleJa·titleKo 모두 null → null (조기 반환)", async () => {
    const result = await matcher.matchWorkTitleFromSheet(null, null);
    assert.strictEqual(result, null);
  });

  test("객체 계약: PIVO ID만으로 정확한 행을 찾는다", async () => {
    const result = await matcher.matchWorkTitleFromSheet({ pivoId: "p4" });
    assert.ok(result);
    assert.strictEqual(result.koreanProjectName, "포함된작품이름");
  });

  test("PIVO ID와 제목이 충돌하면 PIVO ID 정확 일치를 우선한다", async () => {
    const result = await matcher.matchWorkTitleFromSheet({
      pivoId: "p2",
      titleKo: "작품A",
    });
    assert.ok(result);
    assert.strictEqual(result.pivoId, "p2");
  });

  test("PIVO ID가 없으면 함께 전달한 제목으로 계속 찾는다", async () => {
    const result = await matcher.matchWorkTitleFromSheet({
      pivoId: "unknown",
      titleJa: "別のタイトル",
    });
    assert.ok(result);
    assert.strictEqual(result.pivoId, "p3");
  });

  test("레거시 세 번째 인자의 PIVO ID 계약도 호환한다", async () => {
    const result = await matcher.matchWorkTitleFromSheet(null, null, "p5");
    assert.ok(result);
    assert.strictEqual(result.pivoId, "p5");
  });

  test("PIVO ID와 한국어 프로젝트명만 있는 sparse 행도 보존한다", async () => {
    const sparseMatcher = createTitleMatcher({
      masterSheetId: "fake-sheet-id",
      alertOnError: fakeAlertOnError,
      sheetsClient: makeFakeSheetsClient([
        makeRow({ pivoId: "sparse-1", koreanProjectName: "희소 작품" }),
      ]),
    });
    const result = await sparseMatcher.matchWorkTitleFromSheet({ pivoId: "sparse-1" });
    assert.ok(result);
    assert.strictEqual(result.koreanProjectName, "희소 작품");
  });

  test("반환 행은 실제 언어 의미가 드러나는 필드만 제공한다", async () => {
    const result = await matcher.matchWorkTitleFromSheet({ pivoId: "p1" });
    assert.deepEqual(
      {
        chineseOriginalTitle: result.chineseOriginalTitle,
        koreanProjectName: result.koreanProjectName,
        japaneseDisplayTitle: result.japaneseDisplayTitle,
        japaneseFixedTitle: result.japaneseFixedTitle,
      },
      {
        chineseOriginalTitle: "중국어제목A",
        koreanProjectName: "작품A",
        japaneseDisplayTitle: "タイトルA",
        japaneseFixedTitle: "",
      }
    );
    assert.equal(Object.hasOwn(result, "ko"), false);
    assert.equal(Object.hasOwn(result, "koNorm"), false);
  });
});

describe("matchWorkTitleByTokens", () => {
  let matcher;
  beforeEach(() => {
    matcher = createTitleMatcher({
      masterSheetId: "fake-sheet-id",
      alertOnError: fakeAlertOnError,
      sheetsClient: makeFakeSheetsClient(FIXTURE_ROWS),
    });
  });

  test("한국어 토큰 단건 매칭 → { single }", async () => {
    // "나타1" 토큰 2자 이상 → "나타1작품" 1건만 일치
    const result = await matcher.matchWorkTitleByTokens("나타1");
    assert.ok(result, "결과가 있어야 함");
    assert.ok(result.single, "single 필드가 있어야 함");
    assert.strictEqual(result.single.pivoId, "p6");
  });

  test("한국어 토큰 복수 매칭 → { multiple }", async () => {
    // "나타" 2자 토큰 → "나타1작품"(p6), "나타2작품"(p7) 2건 일치
    const result = await matcher.matchWorkTitleByTokens("나타");
    assert.ok(result, "결과가 있어야 함");
    assert.ok(result.multiple, "multiple 필드가 있어야 함");
    assert.strictEqual(result.multiple.length, 2);
  });

  test("토큰 2자 미만 전부 필터 → null (다음 분기로 넘어가거나 null)", async () => {
    // "은" 1자 토큰은 필터되어 tokens.length === 0
    const result = await matcher.matchWorkTitleByTokens("은");
    // 일본어 fallback도 없으면 null
    assert.strictEqual(result, null);
  });

  test("일본어 토큰 단건 매칭 → { single }", async () => {
    // "テスト作品" normalizeTitle → "テスト作品" → "테스트작품x" pivoId=p5 1건
    const result = await matcher.matchWorkTitleByTokens(null, "テスト作品X");
    assert.ok(result, "결과가 있어야 함");
    assert.ok(result.single, "single 필드가 있어야 함");
    assert.strictEqual(result.single.pivoId, "p5");
  });

  test("titleKo·titleJa 모두 null → null (조기 반환)", async () => {
    const result = await matcher.matchWorkTitleByTokens(null, null);
    assert.strictEqual(result, null);
  });
});

describe("matchWorkTitleWithCandidates", () => {
  let matcher;
  let matcherMany;
  beforeEach(() => {
    matcher = createTitleMatcher({
      masterSheetId: "fake-sheet-id",
      alertOnError: fakeAlertOnError,
      sheetsClient: makeFakeSheetsClient(FIXTURE_ROWS),
    });
    matcherMany = createTitleMatcher({
      masterSheetId: "fake-sheet-id",
      alertOnError: fakeAlertOnError,
      sheetsClient: makeFakeSheetsClient(FIXTURE_ROWS_MANY),
    });
  });

  test("1순위: 한국어 완전일치 → { single }", async () => {
    const result = await matcher.matchWorkTitleWithCandidates(null, "별도작품");
    assert.ok(result);
    assert.ok(result.single);
    assert.strictEqual(result.single.pivoId, "p3");
  });

  test("2순위: 한국어 부분일치 단건 → { single }", async () => {
    // "이름"이 "포함된작품이름"에 포함 — 1건만 일치
    const result = await matcher.matchWorkTitleWithCandidates(null, "이름");
    assert.ok(result);
    assert.ok(result.single);
    assert.strictEqual(result.single.pivoId, "p4");
  });

  test("2순위: 한국어 부분일치 복수(≤5) → { multiple }", async () => {
    // "나타"가 "나타1작품"(p6), "나타2작품"(p7) 2건 부분일치
    const result = await matcher.matchWorkTitleWithCandidates(null, "나타");
    assert.ok(result);
    assert.ok(result.multiple);
    assert.strictEqual(result.multiple.length, 2);
  });

  test("2순위: 한국어 부분일치 복수(>5) → { tooMany }", async () => {
    // "공통이름" → FIXTURE_ROWS_MANY 6건 모두 부분일치 (CANDIDATE_MAX=5 초과)
    const result = await matcherMany.matchWorkTitleWithCandidates(null, "공통이름");
    assert.ok(result);
    assert.ok(result.tooMany, "tooMany 필드가 있어야 함");
  });

  test("3순위: 일본어 완전일치 → { single }", async () => {
    // "タイトルB" normalizeTitle → 완전일치 p2
    const result = await matcher.matchWorkTitleWithCandidates("タイトルB", null);
    assert.ok(result);
    assert.ok(result.single);
    assert.strictEqual(result.single.pivoId, "p2");
  });

  test("4순위: 일본어 부분일치 → { single }", async () => {
    // "別の" → "別のタイトル" 부분일치 p3
    const result = await matcher.matchWorkTitleWithCandidates("別の", null);
    assert.ok(result);
    assert.ok(result.single);
    assert.strictEqual(result.single.pivoId, "p3");
  });

  test("매칭 실패 → null", async () => {
    const result = await matcher.matchWorkTitleWithCandidates("존재하지않음", "없는제목");
    assert.strictEqual(result, null);
  });

  test("titleJa·titleKo 모두 null → null (조기 반환)", async () => {
    const result = await matcher.matchWorkTitleWithCandidates(null, null);
    assert.strictEqual(result, null);
  });
});

describe("titleCache: factory 1회 호출로 단일 인스턴스", () => {
  test("같은 인스턴스에서 두 번 호출해도 시트 로드는 1회 (5분 TTL 내)", async () => {
    let loadCount = 0;
    const countingSheetsClient = {
      getValues: async (_spreadsheetId, _range) => {
        loadCount++;
        return [["header"], makeRow({ pivoId: "c1", japaneseDisplayTitle: "キャッシュテスト", chineseOriginalTitle: "캐시테스트", koreanProjectName: "캐시작품" })];
      },
    };
    const m = createTitleMatcher({
      masterSheetId: "fake",
      alertOnError: fakeAlertOnError,
      sheetsClient: countingSheetsClient,
    });
    await m.matchWorkTitleFromSheet("キャッシュテスト", null);
    await m.matchWorkTitleFromSheet("キャッシュテスト", null);
    // 5분 TTL 내 재호출이므로 2번째는 캐시 hit → 시트 로드 1회
    assert.strictEqual(loadCount, 1, "TTL 내 재호출 시 시트 로드는 1회여야 함");
  });
});
