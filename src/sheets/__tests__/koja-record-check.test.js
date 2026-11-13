"use strict";

// 부팅 때 한일 기록 탭 설정 확인 — 틀리면 그 분리만 끄고 오류 로그(봇은 뜬다).
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { kojaRecordConfig, tabTitleOf, checkKojaRecordTarget, enforceKojaRecordTargets } = require("../koja-record-check");

const BASE_GID = 268190314;
const TABS = [
  { sheetId: BASE_GID, title: "문의봇" },
  { sheetId: 1179736144, title: "문의봇_한일" },
  { sheetId: 486785012, title: "재수급봇_한일" },
];
const client = (tabs = TABS) => ({ getSheetTabs: async () => tabs });

describe("kojaRecordConfig — env 읽기", () => {
  const env = (o) => ({ KOJA_INQUIRY_HISTORY_SHEET_RANGE: "문의봇_한일!A:I", KOJA_INQUIRY_HISTORY_GRID_SHEET_ID: "1179736144", ...o });
  it("둘 다 있으면 켜고, SHEET_ID 없으면 공통 파일", () => {
    assert.deepEqual(kojaRecordConfig(env({}), "INQUIRY_HISTORY", "BASEFILE", () => {}),
      { sheetId: "BASEFILE", range: "문의봇_한일!A:I", gridId: 1179736144 });
  });
  it("둘 다 없으면 null(종전 동작)", () => {
    assert.equal(kojaRecordConfig({}, "INQUIRY_HISTORY", "BASEFILE", () => {}), null);
  });
  it("[P3] 숫자 아닌 gid 는 경고 후 무시 — parseInt 처럼 앞자리만 받지 않는다", () => {
    const warns = [];
    assert.equal(kojaRecordConfig(env({ KOJA_INQUIRY_HISTORY_GRID_SHEET_ID: "1179736144abc" }), "INQUIRY_HISTORY", "F", m => warns.push(m)), null);
    assert.equal(kojaRecordConfig(env({ KOJA_INQUIRY_HISTORY_GRID_SHEET_ID: "-5" }), "INQUIRY_HISTORY", "F", m => warns.push(m)), null);
    assert.equal(warns.length, 2);
  });
  it("반쪽 설정은 경고 후 무시", () => {
    const warns = [];
    assert.equal(kojaRecordConfig({ KOJA_RESUPPLY_SHEET_RANGE: "재수급봇_한일!A:H" }, "RESUPPLY", "F", m => warns.push(m)), null);
    assert.equal(warns.length, 1);
  });
});

describe("checkKojaRecordTarget — 탭 이름과 gid 대조", () => {
  const cfg = { sheetId: "F", range: "문의봇_한일!A:I", gridId: 1179736144 };
  it("탭 이름의 gid 가 설정과 같으면 통과", async () => {
    assert.deepEqual(await checkKojaRecordTarget({ sheetsClient: client(), kind: "INQUIRY_HISTORY", cfg, baseGid: BASE_GID }), { ok: true });
  });
  it("작은따옴표로 감싼 탭 이름도 읽는다", () => {
    assert.equal(tabTitleOf("'문의봇_한일'!A:I"), "문의봇_한일");
    assert.equal(tabTitleOf("'O''Brien'!A:B"), "O'Brien");
  });
  it("[R1] gid 가 다른 탭(공통 탭 gid 를 잘못 복사)이면 실패", async () => {
    const res = await checkKojaRecordTarget({ sheetsClient: client(), kind: "INQUIRY_HISTORY",
      cfg: { ...cfg, gridId: 486785012 }, baseGid: BASE_GID });
    assert.equal(res.ok, false);
    assert.match(res.reason, /gid\(1179736144\)가 설정 GRID_SHEET_ID\(486785012\)와 다름/);
  });
  it("[R2] 탭이 없으면 실패", async () => {
    const res = await checkKojaRecordTarget({ sheetsClient: client(TABS.slice(0, 1)), kind: "INQUIRY_HISTORY", cfg, baseGid: BASE_GID });
    assert.equal(res.ok, false);
    assert.match(res.reason, /탭 「문의봇_한일」이 시트에 없음/);
  });
  it("한일 gid 가 공통 탭 gid 와 같으면 구분할 수 없어 실패(조회 전)", async () => {
    let fetched = 0;
    const res = await checkKojaRecordTarget({ sheetsClient: { getSheetTabs: async () => { fetched++; return TABS; } },
      kind: "INQUIRY_HISTORY", cfg: { ...cfg, gridId: BASE_GID }, baseGid: BASE_GID });
    assert.equal(res.ok, false);
    assert.equal(fetched, 0);
  });
  it("탭 목록을 못 읽으면(권한·네트워크) 실패", async () => {
    const res = await checkKojaRecordTarget({ sheetsClient: { getSheetTabs: async () => { throw new Error("403"); } },
      kind: "INQUIRY_HISTORY", cfg, baseGid: BASE_GID });
    assert.equal(res.ok, false);
    assert.match(res.reason, /탭 목록을 읽지 못함\(403\)/);
  });
});

describe("enforceKojaRecordTargets — 틀린 분리만 끈다", () => {
  it("맞는 설정은 두고, 틀린 설정은 disableKoja + 오류 로그", async () => {
    const logs = [], errors = [];
    const disabled = [];
    const router = (name) => ({ disableKoja: () => disabled.push(name) });
    await enforceKojaRecordTargets({
      sheetsClient: client(),
      log: { log: m => logs.push(m), error: m => errors.push(m) },
      checks: [
        { kind: "INQUIRY_HISTORY", cfg: { sheetId: "F", range: "문의봇_한일!A:I", gridId: 1179736144 }, baseGid: BASE_GID, router: router("history") },
        { kind: "RESUPPLY", cfg: { sheetId: "F", range: "재수급봇_한일!A:H", gridId: 999 }, baseGid: 511152201, router: router("resupply") },
        { kind: "NONE", cfg: null, baseGid: 1, router: router("none") },
      ],
    });
    assert.deepEqual(disabled, ["resupply"]);
    assert.equal(logs.length, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /KOJA_RESUPPLY .*한일 분리를 끄고 공통 탭에 기록한다/);
  });
});
