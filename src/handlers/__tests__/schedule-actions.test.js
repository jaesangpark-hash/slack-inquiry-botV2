"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

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
      PM_SLACK_ID: "U_PM",
      SCHEDULE_CHANNEL_ID: "C_SCH",
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
      PM_SLACK_ID: "U_PM",
      SCHEDULE_CHANNEL_ID: "C_SCH",
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
      parsed: { episode: "5", work_title_ko: "테스트", work_title_ja: "" },
      sourceLink: "https://example.com",
    });

    const app = makeFakeApp();
    let schedExtCalled = false;
    const client = makeFakeClient({
      chat: { postMessage: async () => ({ ts: "ts1" }) },
    });

    registerScheduleActions(app, {
      draftStore,
      loadTitleRowsFromSheet: async () => [{ pivoId: "P1", projectName: "Test Work" }],
      matchWorkTitleFromSheet: async () => null,
      fetchDeliveryDate: async () => ({ allSame: true, deliveryDate: "2026-06-01", episodeLabel: "5화" }),
      handleScheduleExt: async () => { schedExtCalled = true; },
      generateDraftId: () => "d_new",
      PM_SLACK_ID: "U_PM",
      SCHEDULE_CHANNEL_ID: "C_SCH",
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
    // draftStore에서 pendingId 삭제됐는지 확인
    assert.equal(draftStore.has(pendingId), false);
  });
});
