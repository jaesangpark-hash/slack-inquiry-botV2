"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const registerDirectInputActions = require("../direct-input-actions");

function makeFakeApp() {
  const registered = { actions: {}, views: {} };
  return {
    action(id, handler) {
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
    chat: {
      postMessage: async () => ({ ts: "123" }),
      update: async () => ({}),
    },
    conversations: { history: async () => ({ messages: [] }) },
    ...overrides,
  };
}

function makeDeps(draftStore, overrides = {}) {
  return {
    draftStore,
    buildDraftPreviewBlocks: () => [],
    buildDraftPreviewText: () => "preview",
    buildFileInquiryBlocks: () => [],
    matchWorkTitleFromSheet: async () => null,
    fetchDeliveryDate: async () => null,
    handleFileOrderInquiry: async () => {},
    handleScheduleExt: async () => {},
    generateDraftId: () => `draft_${Date.now()}`,
    resolveApmUserId: () => null,
    postInquiryToTargetChannel: async () => ({ ts: "ts_tgt" }),
    TARGET_CHANNEL_ID: "C_TGT",
    ...overrides,
  };
}

describe("registerDirectInputActions — 등록 검증", () => {
  let app, draftStore;

  beforeEach(() => {
    draftStore = new Map();
    app = makeFakeApp();
    registerDirectInputActions(app, makeDeps(draftStore));
  });

  it("inquiry_done action 등록", () => {
    assert.ok(typeof app._registered.actions["inquiry_done"] === "function");
  });

  it("open_inquiry_reply_modal action 등록", () => {
    assert.ok(typeof app._registered.actions["open_inquiry_reply_modal"] === "function");
  });

  it("submit_inquiry_reply_modal view 등록", () => {
    assert.ok(typeof app._registered.views["submit_inquiry_reply_modal"] === "function");
  });

  it("direct_resupply_btn action 등록", () => {
    assert.ok(typeof app._registered.actions["direct_resupply_btn"] === "function");
  });

  it("direct_resupply_modal view 등록", () => {
    assert.ok(typeof app._registered.views["direct_resupply_modal"] === "function");
  });

  it("direct_schedule_btn action 등록", () => {
    assert.ok(typeof app._registered.actions["direct_schedule_btn"] === "function");
  });

  it("direct_schedule_modal view 등록", () => {
    assert.ok(typeof app._registered.views["direct_schedule_modal"] === "function");
  });

  it("direct_inquiry_btn action 등록", () => {
    assert.ok(typeof app._registered.actions["direct_inquiry_btn"] === "function");
  });

  it("direct_inquiry_modal view 등록", () => {
    assert.ok(typeof app._registered.views["direct_inquiry_modal"] === "function");
  });

  it("direct_fileorder_btn action 등록", () => {
    assert.ok(typeof app._registered.actions["direct_fileorder_btn"] === "function");
  });

  it("direct_fileorder_modal view 등록", () => {
    assert.ok(typeof app._registered.views["direct_fileorder_modal"] === "function");
  });

  it("open_manual_title_modal action 등록", () => {
    assert.ok(typeof app._registered.actions["open_manual_title_modal"] === "function");
  });

  it("manual_title_modal view 등록", () => {
    assert.ok(typeof app._registered.views["manual_title_modal"] === "function");
  });

  it("inquiry_cand_pick regex action 등록", () => {
    assert.ok(typeof app._registered.actions["^inquiry_cand_pick_\\d+$"] === "function");
  });

  it("open_inquiry_modal action 등록", () => {
    assert.ok(typeof app._registered.actions["open_inquiry_modal"] === "function");
  });

  it("send_inquiry_now action 등록", () => {
    assert.ok(typeof app._registered.actions["send_inquiry_now"] === "function");
  });

  it("submit_inquiry_modal view 등록", () => {
    assert.ok(typeof app._registered.views["submit_inquiry_modal"] === "function");
  });

  it("등록 actions 10개 (string 9 + regex 1)", () => {
    // string: inquiry_done, open_inquiry_reply_modal, direct_resupply_btn, direct_schedule_btn,
    //         direct_inquiry_btn, direct_fileorder_btn, open_manual_title_modal,
    //         open_inquiry_modal, send_inquiry_now
    // regex: inquiry_cand_pick_\d+
    const actionCount = Object.keys(app._registered.actions).length;
    assert.equal(actionCount, 10);
  });

  it("등록 views 7개", () => {
    // submit_inquiry_reply_modal, direct_resupply_modal, direct_schedule_modal,
    // direct_inquiry_modal, direct_fileorder_modal, manual_title_modal, submit_inquiry_modal
    const viewCount = Object.keys(app._registered.views).length;
    assert.equal(viewCount, 7);
  });
});

describe("inquiry_done — 핸들러 동작", () => {
  it("PM 채널 메시지 update 호출", async () => {
    const draftStore = new Map();
    draftStore.set("d1", { originalChannelId: "C_ORIG", originalTs: "111" });
    const app = makeFakeApp();
    let updateCalled = false;
    const client = makeFakeClient({
      chat: {
        postMessage: async () => ({ ts: "ts2" }),
        update: async () => { updateCalled = true; return {}; },
      },
    });

    registerDirectInputActions(app, makeDeps(draftStore));

    const meta = JSON.stringify({ submitterId: "U_SUBMIT", draftId: "d1" });
    await app._registered.actions["inquiry_done"]({
      ack: async () => {},
      body: {
        user: { id: "U_HANDLER" },
        channel: { id: "C_PM" },
        message: { ts: "m_ts", text: "원본", blocks: [{ type: "section" }, { type: "actions" }] },
        actions: [{ value: meta }],
      },
      client,
    });

    assert.equal(updateCalled, true);
  });
});

describe("send_inquiry_now — postInquiryToTargetChannel 호출", () => {
  it("draft 있으면 postInquiryToTargetChannel 호출", async () => {
    const draftStore = new Map();
    draftStore.set("d_send", {
      draftId: "d_send", workName: "작품명", workNameKo: "한국", episode: "5",
      inquiryType: "기타", inquiryContent: "내용", actionRequired: "확인", summary: "", sourceLink: "",
    });
    const app = makeFakeApp();
    let postTargetCalled = false;
    const client = makeFakeClient({
      chat: { postMessage: async () => ({ ts: "ts3" }) },
    });

    registerDirectInputActions(app, makeDeps(draftStore, {
      postInquiryToTargetChannel: async () => { postTargetCalled = true; return { ts: "ts_tgt" }; },
    }));

    await app._registered.actions["send_inquiry_now"]({
      ack: async () => {},
      body: {
        user: { id: "U1" },
        actions: [{ value: "d_send" }],
      },
      client,
    });

    assert.equal(postTargetCalled, true);
  });

  it("draft 없으면 postInquiryToTargetChannel 미호출", async () => {
    const draftStore = new Map();
    const app = makeFakeApp();
    let postTargetCalled = false;
    const client = makeFakeClient({
      chat: { postMessage: async () => ({ ts: "ts4" }) },
    });

    registerDirectInputActions(app, makeDeps(draftStore, {
      postInquiryToTargetChannel: async () => { postTargetCalled = true; return {}; },
    }));

    await app._registered.actions["send_inquiry_now"]({
      ack: async () => {},
      body: {
        user: { id: "U1" },
        actions: [{ value: "nonexistent" }],
      },
      client,
    });

    assert.equal(postTargetCalled, false);
  });
});

describe("inquiry_cand_pick — draftStore 공유 + draft 생성", () => {
  it("pendingId로 draft 생성 후 draftStore.set 호출, pending 삭제", async () => {
    const draftStore = new Map();
    draftStore.set("pending1", {
      userId: "U1", dmChannelId: "DM1", progressTs: "pt1",
      sourceLink: "https://example.com", originalText: "원문",
      inquiryType: "기타", inquiryContent: "내용", summary: "요약",
      actionRequired: "확인", sourceLang: "ja",
    });

    const app = makeFakeApp();
    let draftId = null;
    const client = makeFakeClient({
      chat: { postMessage: async () => ({ ts: "ts5" }) },
    });

    registerDirectInputActions(app, makeDeps(draftStore, {
      generateDraftId: () => { draftId = "d_cand"; return "d_cand"; },
      buildDraftPreviewText: () => "preview text",
      buildDraftPreviewBlocks: () => [],
    }));

    await app._registered.actions["^inquiry_cand_pick_\\d+$"]({
      ack: async () => {},
      body: {
        user: { id: "U1" },
        actions: [{ value: JSON.stringify({ pendingId: "pending1", pivoId: "pivo1", projectName: "작품A" }) }],
      },
      client,
    });

    // pending 삭제 확인
    assert.equal(draftStore.has("pending1"), false);
    // 새 draft 생성 확인
    assert.equal(draftStore.has("d_cand"), true);
    const newDraft = draftStore.get("d_cand");
    assert.equal(newDraft.workName, "작품A");
    assert.equal(newDraft.pivoId, "pivo1");
  });
});
