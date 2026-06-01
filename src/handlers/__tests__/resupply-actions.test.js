"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const registerResupplyActions = require("../resupply-actions");

// ── 가짜 app (action/view 등록 spy) ──────────────────────
function makeFakeApp() {
  const registered = { actions: {}, views: {} };
  return {
    action(id, handler) { registered.actions[id] = handler; },
    view(id, handler) { registered.views[id] = handler; },
    _registered: registered,
  };
}

// ── 가짜 client ───────────────────────────────────────────
function makeFakeClient(overrides = {}) {
  return {
    views: { open: async () => ({}) },
    chat: { postMessage: async () => ({ ts: "123" }), update: async () => ({}) },
    conversations: { history: async () => ({ messages: [] }) },
    ...overrides,
  };
}

describe("registerResupplyActions — 등록 검증", () => {
  let app, deps, draftStore;

  beforeEach(() => {
    draftStore = new Map();
    app = makeFakeApp();
    deps = {
      draftStore,
      buildFileInquiryBlocks: () => [],
      buildFileInquiryMessage: () => ({ text: "재수급 요청" }),
      appendResupplyRecord: async () => 5,
      strikethroughResupplyRow: async () => {},
      PM_REQUEST_CHANNEL_ID: "C_PM",
    };
    registerResupplyActions(app, deps);
  });

  it("open_file_inquiry_modal action 등록", () => {
    assert.ok(typeof app._registered.actions["open_file_inquiry_modal"] === "function");
  });

  it("submit_file_inquiry_modal view 등록", () => {
    assert.ok(typeof app._registered.views["submit_file_inquiry_modal"] === "function");
  });

  it("send_file_inquiry_now action 등록", () => {
    assert.ok(typeof app._registered.actions["send_file_inquiry_now"] === "function");
  });

  it("file_resupply_done action 등록", () => {
    assert.ok(typeof app._registered.actions["file_resupply_done"] === "function");
  });

  it("resupply_notify_worker action 등록", () => {
    assert.ok(typeof app._registered.actions["resupply_notify_worker"] === "function");
  });

  it("등록 핸들러 총 5개 (actions 4 + views 1)", () => {
    assert.equal(Object.keys(app._registered.actions).length, 4);
    assert.equal(Object.keys(app._registered.views).length, 1);
  });
});

describe("open_file_inquiry_modal — 핸들러 동작", () => {
  it("draftStore에 draft 없으면 views.open 미호출", async () => {
    const draftStore = new Map();
    const app = makeFakeApp();
    let openCalled = false;
    const client = makeFakeClient({ views: { open: async () => { openCalled = true; return {}; } } });

    registerResupplyActions(app, {
      draftStore,
      buildFileInquiryBlocks: () => [],
      buildFileInquiryMessage: () => ({}),
      appendResupplyRecord: async () => 0,
      strikethroughResupplyRow: async () => {},
      PM_REQUEST_CHANNEL_ID: "C_PM",
    });

    const handler = app._registered.actions["open_file_inquiry_modal"];
    await handler({ ack: async () => {}, body: { actions: [{ value: "nonexistent" }], trigger_id: "t1" }, client });

    assert.equal(openCalled, false);
  });

  it("draftStore에 draft 있으면 views.open 호출", async () => {
    const draftStore = new Map();
    draftStore.set("draft1", { workName: "テスト", episode: "10", fileNumbers: [], reason: "" });
    const app = makeFakeApp();
    let openCalled = false;
    const client = makeFakeClient({ views: { open: async () => { openCalled = true; return {}; } } });

    registerResupplyActions(app, {
      draftStore,
      buildFileInquiryBlocks: () => [],
      buildFileInquiryMessage: () => ({}),
      appendResupplyRecord: async () => 0,
      strikethroughResupplyRow: async () => {},
      PM_REQUEST_CHANNEL_ID: "C_PM",
    });

    const handler = app._registered.actions["open_file_inquiry_modal"];
    await handler({ ack: async () => {}, body: { actions: [{ value: "draft1" }], trigger_id: "t1" }, client });

    assert.equal(openCalled, true);
  });
});

describe("cross-handler draft 공유 — 동일 Map 인스턴스", () => {
  it("open_file_inquiry_modal → submit_file_inquiry_modal이 동일 draftStore 사용", async () => {
    const draftStore = new Map();
    const app = makeFakeApp();
    const postedChannels = [];
    const client = makeFakeClient({
      views: { open: async () => ({}) },
      chat: {
        postMessage: async ({ channel }) => { postedChannels.push(channel); return { ts: "ts1" }; },
        update: async () => ({}),
      },
    });

    registerResupplyActions(app, {
      draftStore,
      buildFileInquiryBlocks: () => [],
      buildFileInquiryMessage: () => ({ text: "msg" }),
      appendResupplyRecord: async () => 7,
      strikethroughResupplyRow: async () => {},
      PM_REQUEST_CHANNEL_ID: "C_PM",
    });

    // step1: open_file_inquiry_modal로 초안 존재 확인
    draftStore.set("d1", { workName: "作品", episode: "5", fileNumbers: ["1"], reason: "손상", sourceLink: "", dmChannelId: "U_DM" });

    // step2: submit_file_inquiry_modal 핸들러 실행 (동일 draftStore에서 get)
    const submitHandler = app._registered.views["submit_file_inquiry_modal"];
    await submitHandler({
      ack: async () => {},
      body: { user: { id: "U1" } },
      view: {
        private_metadata: JSON.stringify({ draftId: "d1" }),
        state: { values: {
          fi_work_block: { value: { value: "新作品" } },
          fi_episode_block: { value: { value: "10" } },
          fi_files_block: { value: { value: "3,4" } },
          fi_reason_block: { value: { value: "오류" } },
        }},
      },
      client,
    });

    // draftStore에 변경 반영됐는지 확인
    const updated = draftStore.get("d1");
    assert.equal(updated.workName, "新作品");
    assert.deepEqual(updated.fileNumbers, ["3", "4"]);
    assert.ok(updated.resupplyRowIndex === 7);
    // PM 채널에 postMessage 호출됐는지
    assert.ok(postedChannels.includes("C_PM"));
  });
});
