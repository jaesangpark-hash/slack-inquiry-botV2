"use strict";
/**
 * sheets/title-matcher.js — 한일 마스터 동시 적재 단위 테스트
 *
 * node:test + node:assert 빌트인 사용 (신규 dep 추가 금지).
 * factory DI — fake sheetsClient 가 시트 ID 별로 다른 행을 돌려줘 두 마스터를 흉내낸다.
 *
 * 검증 항목:
 *   적재:
 *     - 두 마스터를 같이 읽고 행마다 lang 이 붙는다
 *     - 한일 마스터 ID 가 없으면 중일만 읽는다 (설정 안 한 환경에서도 동작)
 *     - 숫자가 아닌 pivo_id(取り下げ)는 ID 로 쓰지 않는다
 *     - 한쪽 로드가 실패하면 반쪽을 캐시하지 않고 기존 캐시를 유지한다
 *   언어 우선순위:
 *     - 같은 제목이 양쪽에 있으면 소환 이모지가 가리킨 쪽을 고른다
 *     - 이모지를 반대로 찍어도 작품을 못 찾지는 않는다 (반대쪽을 고를 뿐)
 *     - langPair 가 없으면 양쪽이 동점이라 되묻는다
 *   컬럼 매핑:
 *     - 한일은 F 원제가 한국어 이름 자리, E 가제가 일본어 표시명, D JP_title 이 FIX
 *
 * fixture self-fulfilling 금지:
 *   컬럼 인덱스를 코드에서 베껴 오지 않고 실제 시트 배치(2026-10-28 실측)를 그대로 깐다.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const createTitleMatcher = require("../title-matcher");

const ZH_ID = "zh-sheet";
const KO_ID = "ko-sheet";

// 중일 '출판사 드라이브 링크' A:I — B 중국어원제 C 한국어 D 일본어표시 E FIX I PIVO
const zhRow = ({ zh = "", ko = "", jaDisplay = "", jaFixed = "", pivo = "" }) =>
  ["", zh, ko, jaDisplay, jaFixed, "", "", "", pivo];

// 한일 '한일_master' A:P — B pivo_id D JP_title E 가제 F 원제 G 프로젝트명
const koRow = ({ pivo = "", jpTitle = "", kaje = "", wonje = "", project = "" }) =>
  ["1", pivo, "2021/11/11", jpTitle, kaje, wonje, project, "", "", "", "", "", "", "", "", ""];

function makeMatcher({ zh = [], ko = [], koSheetId = KO_ID, failing = null } = {}) {
  const calls = [];
  const sheetsClient = {
    getValues: async (spreadsheetId, range) => {
      calls.push({ spreadsheetId, range });
      if (failing === spreadsheetId) throw new Error("시트 조회 실패");
      if (spreadsheetId === ZH_ID) return [["header"], ...zh];
      if (spreadsheetId === KO_ID) return [["header"], ...ko];
      return [["header"]];
    },
  };
  const matcher = createTitleMatcher({
    google: {}, getGoogleAuth: () => {},
    masterSheetId: ZH_ID,
    masterSheetKoJaId: koSheetId,
    alertOnError: async (_label, fn) => fn(),
    sheetsClient,
  });
  return { matcher, calls };
}

describe("한일 마스터 동시 적재", () => {
  test("두 마스터를 같이 읽고 행마다 lang 이 붙는다", async () => {
    const { matcher, calls } = makeMatcher({
      zh: [zhRow({ zh: "尸山血海", ko: "파일 오브 더 데드", pivo: "201" })],
      ko: [koRow({ pivo: "82357", jpTitle: "神と共にレベルアップ", kaje: "神と一緒にレベルアップ", wonje: "신과 함께 레벨업", project: "[카카오픽코마] 신과 함께 레벨업" })],
    });
    const rows = await matcher.loadTitleRowsFromSheet();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(r => r.lang).sort(), ["ko-ja", "zh-ja"]);
    assert.equal(calls.length, 2, "두 시트를 다 읽어야 한다");
  });

  test("한일 마스터 ID 가 없으면 중일만 읽는다", async () => {
    const { matcher, calls } = makeMatcher({
      zh: [zhRow({ ko: "작품A", pivo: "201" })],
      koSheetId: null,   // env 미설정 — 구조분해 기본값이 먹지 않게 undefined 대신 null
    });
    const rows = await matcher.loadTitleRowsFromSheet();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].lang, "zh-ja");
    assert.equal(calls.length, 1);
  });

  test("한일 컬럼 매핑 — F 원제가 한국어 이름, E 가제가 표시명, D JP_title 이 FIX", async () => {
    const { matcher } = makeMatcher({
      ko: [koRow({ pivo: "82357", jpTitle: "神と共にレベルアップ", kaje: "神と一緒にレベルアップ（仮）", wonje: "신과 함께 레벨업", project: "[카카오픽코마] 신과 함께 레벨업" })],
    });
    const [row] = (await matcher.loadTitleRowsFromSheet()).filter(r => r.lang === "ko-ja");
    assert.equal(row.koreanProjectName, "신과 함께 레벨업", "접두 붙은 G 가 아니라 F 원제를 쓴다");
    assert.equal(row.japaneseDisplayTitle, "神と一緒にレベルアップ", "（仮）는 떨어진다");
    assert.equal(row.japaneseFixedTitle, "神と共にレベルアップ");
    assert.equal(row.pivoId, "82357");
  });

  test("숫자가 아닌 pivo_id 는 ID 로 쓰지 않는다 — 取り下げ 6행이 한 키를 공유하면 안 된다", async () => {
    const { matcher } = makeMatcher({
      ko: [
        koRow({ pivo: "取り下げ", wonje: "취하작품1" }),
        koRow({ pivo: "取り下げ", wonje: "취하작품2" }),
      ],
    });
    const rows = (await matcher.loadTitleRowsFromSheet()).filter(r => r.lang === "ko-ja");
    assert.equal(rows.length, 2, "행 자체는 남는다 — 제목으로는 찾을 수 있어야 한다");
    assert.deepEqual(rows.map(r => r.pivoId), ["", ""]);
    assert.equal(await matcher.matchWorkTitleFromSheet({ pivoId: "取り下げ" }), null);
  });

  test("한쪽 로드가 실패하면 반쪽을 캐시하지 않는다", async () => {
    const { matcher } = makeMatcher({
      zh: [zhRow({ ko: "작품A", pivo: "201" })],
      failing: KO_ID,
    });
    const rows = await matcher.loadTitleRowsFromSheet();
    assert.deepEqual(rows, [], "중일만 담아 5분간 물고 있으면 한일 문의가 조용히 '작품 없음'이 된다");
  });
});

describe("소환 이모지에 따른 언어 우선순위", () => {
  // 같은 한국어 제목이 양쪽 마스터에 있는 상황 (실측 교차 충돌과 같은 모양)
  const both = {
    zh: [zhRow({ ko: "아포칼립스", pivo: "201" })],
    ko: [koRow({ pivo: "301", wonje: "아포칼립스" })],
  };

  test("이모지가 가리킨 쪽을 고른다", async () => {
    const { matcher } = makeMatcher(both);
    const zh = await matcher.matchWorkTitleFromSheet({ titleKo: "아포칼립스", langPair: "zh-ja" });
    const ko = await matcher.matchWorkTitleFromSheet({ titleKo: "아포칼립스", langPair: "ko-ja" });
    assert.equal(zh.pivoId, "201");
    assert.equal(ko.pivoId, "301");
  });

  test("이모지를 반대로 찍어도 못 찾지는 않는다 — 조회 범위를 자르지 않는다", async () => {
    const { matcher } = makeMatcher({ zh: [], ko: [koRow({ pivo: "301", wonje: "한일전용작품" })] });
    const found = await matcher.matchWorkTitleFromSheet({ titleKo: "한일전용작품", langPair: "zh-ja" });
    assert.ok(found, "중일 이모지로 찍은 한일 작품도 찾아야 한다");
    assert.equal(found.lang, "ko-ja");
  });

  test("langPair 가 없으면 양쪽이 동점이라 되묻는다", async () => {
    const { matcher } = makeMatcher(both);
    const out = await matcher.matchWorkTitleWithCandidates(null, "아포칼립스");
    assert.ok(out.multiple, "어느 쪽인지 모르면 고르게 해야 한다");
    assert.equal(out.multiple.length, 2);
  });

  test("langPair 를 주면 되묻지 않고 그쪽으로 확정한다", async () => {
    const { matcher } = makeMatcher(both);
    const out = await matcher.matchWorkTitleWithCandidates(null, "아포칼립스", null, "ko-ja");
    assert.ok(out.single);
    assert.equal(out.single.pivoId, "301");
  });
});
