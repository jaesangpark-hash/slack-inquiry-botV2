"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { createLangRouting } = require("../../config/lang-routing");
// 실제 라우팅 모듈을 그대로 쓴다 — 가짜로 대체하면 "언어별로 갈린다"는 계약을 안 보게 된다.
const routing = (overrides = {}) => createLangRouting({
  base: { target: "C_TGT", pmRequest: "C_PM", schedule: "C_SCH", mentionUserIds: ["U_FWD"], pmSlackId: "U_PM" },
  overrides,
});


const registerScheduleActions = require("../schedule-actions");

function makeFakeApp() {
  const registered = { actions: {}, views: {} };
  return {
    action(id, handler) {
      // regex 또는 string id 모두 지원
      const key = id instanceof RegExp ? id.source : id;
      registered.actions[key] = handler;
    },
    view(id, handler) { registered.views[id] = handler; },
    _registered: registered,
  };
}

function makeFakeClient(overrides = {}) {
  return {
    views: { open: async () => ({}) },
    chat: { postMessage: async () => ({ ts: "123" }), update: async () => ({}) },
    ...overrides,
  };
}

describe("registerScheduleActions — 등록 검증", () => {
  let app, deps, draftStore;

  beforeEach(() => {
    draftStore = new Map();
    app = makeFakeApp();
    deps = {
      draftStore,
      loadTitleRowsFromSheet: async () => [],
      matchWorkTitleFromSheet: async () => null,
      fetchDeliveryDate: async () => null,
      handleScheduleExt: async () => {},
      generateDraftId: () => `draft_test_${Date.now()}`,
      langRouting: routing(),
    };
    registerScheduleActions(app, deps);
  });

  it("schedule_ask_pm action 등록", () => {
    assert.ok(typeof app._registered.actions["schedule_ask_pm"] === "function");
  });

  it("schedule_pm_request_modal view 등록", () => {
    assert.ok(typeof app._registered.views["schedule_pm_request_modal"] === "function");
  });

  it("schedule_pm_no action 등록", () => {
    assert.ok(typeof app._registered.actions["schedule_pm_no"] === "function");
  });

  it("open_schedule_title_modal action 등록", () => {
    assert.ok(typeof app._registered.actions["open_schedule_title_modal"] === "function");
  });

  it("schedule_title_modal view 등록", () => {
    assert.ok(typeof app._registered.views["schedule_title_modal"] === "function");
  });

  it("schedule_token_pick regex action 등록", () => {
    // regex action key는 source로 저장됨
    assert.ok(typeof app._registered.actions["^schedule_token_pick_\\d+$"] === "function");
  });

  it("등록 핸들러 총 6개 (actions string3+regex1 + views 2)", () => {
    assert.equal(Object.keys(app._registered.actions).length, 4);
    assert.equal(Object.keys(app._registered.views).length, 2);
  });
});

describe("schedule_pm_no — 핸들러 동작", () => {
  it("DM에 확인 메시지 postMessage 호출", async () => {
    const draftStore = new Map();
    const app = makeFakeApp();
    const postedChannels = [];
    const client = makeFakeClient({
      chat: { postMessage: async ({ channel }) => { postedChannels.push(channel); return {}; } },
    });

    registerScheduleActions(app, {
      draftStore,
      loadTitleRowsFromSheet: async () => [],
      matchWorkTitleFromSheet: async () => null,
      fetchDeliveryDate: async () => null,
      handleScheduleExt: async () => {},
      generateDraftId: () => "d1",
      langRouting: routing(),
    });

    await app._registered.actions["schedule_pm_no"]({
      ack: async () => {},
      body: { user: { id: "U1" } },
      client,
    });

    assert.ok(postedChannels.includes("U1"));
  });
});

describe("schedule_token_pick — draftStore 공유 + handleScheduleExt 호출", () => {
  it("pendingId로 draftStore get 후 handleScheduleExt 호출", async () => {
    const draftStore = new Map();
    const pendingId = "sched_pending_1";
    draftStore.set(pendingId, {
      type: "schedule_pending",
      ownerUserId: "U_OWNER",
      parsed: { episode: "5", work_title_ko: "테스트", work_title_ja: "" },
      sourceLink: "https://example.com",
    });

    const app = makeFakeApp();
    let schedExtCalled = false;
    let forwardedParsed = null;
    const client = makeFakeClient({
      chat: { postMessage: async () => ({ ts: "ts1" }) },
    });

    registerScheduleActions(app, {
      draftStore,
      loadTitleRowsFromSheet: async () => [{ pivoId: "P1", koreanProjectName: "Test Work" }],
      matchWorkTitleFromSheet: async () => null,
      fetchDeliveryDate: async () => ({ allSame: true, deliveryDate: "2026-06-01", episodeLabel: "5화" }),
      handleScheduleExt: async (_client, _channel, parsed) => {
        schedExtCalled = true;
        forwardedParsed = parsed;
      },
      generateDraftId: () => "d_new",
      langRouting: routing(),
    });

    const handler = app._registered.actions["^schedule_token_pick_\\d+$"];
    await handler({
      ack: async () => {},
      body: {
        user: { id: "U1" },
        actions: [{ value: JSON.stringify({ pendingId, pivoId: "P1", projectName: "Test Work" }) }],
      },
      client,
    });

    assert.equal(schedExtCalled, true);
    assert.equal(forwardedParsed.ownerUserId, "U_OWNER");
    // draftStore에서 pendingId 삭제됐는지 확인
    assert.equal(draftStore.has(pendingId), false);
  });

  // ★B3 회귀 — pivoId 가 빈 후보(마스터에 PIVO 가 없는 작품)를 누르면 "" === "" 로
  //   PIVO 칸이 빈 **첫 행**, 즉 전혀 다른 작품이 걸렸다.
  it("pivoId 가 빈 후보를 눌러도 PIVO 칸이 빈 다른 작품을 집지 않는다", async () => {
    const draftStore = new Map();
    const pendingId = "sched_pending_nopivo";
    draftStore.set(pendingId, {
      type: "schedule_pending",
      ownerUserId: "U_OWNER",
      parsed: { episode: "5", work_title_ko: "내가 고른 작품", work_title_ja: "" },
    });

    const app = makeFakeApp();
    let askedWorkName = null;
    registerScheduleActions(app, {
      draftStore,
      // 시트 첫 행이 PIVO 빈 "전혀 다른 작품" — 가드가 없으면 이게 걸린다
      loadTitleRowsFromSheet: async () => [
        { pivoId: "", koreanProjectName: "전혀 다른 작품" },
        { pivoId: "P9", koreanProjectName: "또 다른 작품" },
      ],
      matchWorkTitleFromSheet: async () => null,
      fetchDeliveryDate: async (workName) => { askedWorkName = workName; return null; },
      handleScheduleExt: async () => {},
      generateDraftId: () => "d_new",
      langRouting: routing(),
    });

    const handler = app._registered.actions["^schedule_token_pick_\\d+$"];
    await handler({
      ack: async () => {},
      body: {
        user: { id: "U1" },
        actions: [{ value: JSON.stringify({ pendingId, pivoId: "", koreanProjectName: "내가 고른 작품" }) }],
      },
      client: makeFakeClient({ chat: { postMessage: async () => ({ ts: "t" }) } }),
    });

    assert.equal(askedWorkName, "내가 고른 작품", "버튼이 실어 온 이름으로 조회해야 한다");
    assert.notEqual(askedWorkName, "전혀 다른 작품");
  });

  // ★B4 회귀 — 버튼 payload 의 lang 이 납품 탭 선택까지 전달돼야 한다.
  it("후보가 실어 온 lang 으로 납품 탭을 고른다 — 한일이 중일 탭으로 새지 않게", async () => {
    const draftStore = new Map();
    const pendingId = "sched_pending_koja";
    draftStore.set(pendingId, {
      type: "schedule_pending", ownerUserId: "U_OWNER",
      parsed: { episode: "5", work_title_ko: "한일작품", work_title_ja: "" },
    });

    const app = makeFakeApp();
    let askedLang = null;
    registerScheduleActions(app, {
      draftStore,
      loadTitleRowsFromSheet: async () => [],   // 시트에서 못 찾아도 payload 의 lang 은 살아야 한다
      matchWorkTitleFromSheet: async () => null,
      fetchDeliveryDate: async (_w, _ep, lang) => { askedLang = lang; return null; },
      handleScheduleExt: async () => {},
      generateDraftId: () => "d_new",
      langRouting: routing(),
    });

    const handler = app._registered.actions["^schedule_token_pick_\\d+$"];
    await handler({
      ack: async () => {},
      body: {
        user: { id: "U1" },
        actions: [{ value: JSON.stringify({ pendingId, pivoId: "301", koreanProjectName: "한일작품", lang: "ko-ja" }) }],
      },
      client: makeFakeClient({ chat: { postMessage: async () => ({ ts: "t" }) } }),
    });

    assert.equal(askedLang, "ko-ja", "zh-ja 로 떨어지면 한일 작품을 중일 납품 탭에서 찾는다");
  });
});
