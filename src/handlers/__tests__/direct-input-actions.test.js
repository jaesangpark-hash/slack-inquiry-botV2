"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const registerDirectInputActions = require("../direct-input-actions");
const createInquiryHistory = require("../../sheets/inquiry-history");
const {
  createCompletionFollowupMarker,
} = require("../../slack/completion-coordinator");

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
    handleWorkerRelay: async () => {},
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

  it("route_pick_relay action 등록", () => {
    assert.ok(typeof app._registered.actions["route_pick_relay"] === "function");
  });

  it("route_pick_inquiry action 등록", () => {
    assert.ok(typeof app._registered.actions["route_pick_inquiry"] === "function");
  });

  it("submit_inquiry_modal view 등록", () => {
    assert.ok(typeof app._registered.views["submit_inquiry_modal"] === "function");
  });

  it("등록 actions 12개 (string 11 + regex 1)", () => {
    // string: inquiry_done, open_inquiry_reply_modal, direct_resupply_btn, direct_schedule_btn,
    //         direct_inquiry_btn, direct_fileorder_btn, open_manual_title_modal,
    //         open_inquiry_modal, send_inquiry_now, route_pick_relay, route_pick_inquiry
    // regex: inquiry_cand_pick_\d+
    const actionCount = Object.keys(app._registered.actions).length;
    assert.equal(actionCount, 12);
  });

  it("등록 views 7개", () => {
    // submit_inquiry_reply_modal, direct_resupply_modal, direct_schedule_modal,
    // direct_inquiry_modal, direct_fileorder_modal, manual_title_modal, submit_inquiry_modal
    const viewCount = Object.keys(app._registered.views).length;
    assert.equal(viewCount, 7);
  });
});

describe("inquiry_done — 핸들러 동작", () => {
  it("재시작 뒤 기존 followup marker를 찾으면 시트/후속 게시 없이 UI만 갱신하고 metadata 원문을 우선한다", async () => {
    const draftStore = new Map();
    const app = makeFakeApp();
    let sheetChecks = 0;
    let followupPosts = 0;
    let updates = 0;
    const completionStateKey = "inquiry_done:C_PM:m_ts";
    const client = makeFakeClient({
      conversations: {
        replies: async () => ({ messages: [{
          ts: "existing-followup",
          blocks: [{ block_id: createCompletionFollowupMarker(completionStateKey) }],
        }] }),
        history: async () => ({ messages: [] }),
      },
      chat: {
        postMessage: async payload => {
          if (payload.blocks?.some(block => block.type === "actions")) followupPosts++;
          return { ts: "duplicate-followup" };
        },
        update: async () => { updates++; return {}; },
      },
    });
    registerDirectInputActions(app, makeDeps(draftStore, {
      checkInquiryDone: async () => { sheetChecks++; },
    }));

    await app._registered.actions.inquiry_done({
      ack: async () => {},
      body: {
        user: { id: "U_HANDLER" },
        channel: { id: "C_PM" },
        message: { ts: "m_ts", text: "원본", blocks: [{ type: "section" }, { type: "actions" }] },
        actions: [{ value: JSON.stringify({
          submitterId: "U_SUBMIT",
          draftId: "gone-after-restart",
          historyRowIndex: 9,
          originalChannelId: "C_FROM_META",
          originalTs: "111.222",
          sourceLink: "https://slack.example/source",
        }) }],
      },
      client,
    });

    assert.equal(sheetChecks, 0);
    assert.equal(followupPosts, 0);
    assert.equal(updates, 1);
    assert.equal(draftStore.get(completionStateKey).followupMessageTs, "existing-followup");
  });

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

    registerDirectInputActions(app, makeDeps(draftStore, {
      checkInquiryDone: async () => {},
    }));

    const meta = JSON.stringify({ submitterId: "U_SUBMIT", draftId: "d1", historyRowIndex: 9 });
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

  it("시트 체크와 답변 버튼 게시가 확인된 뒤 완료 UI를 갱신한다", async () => {
    const draftStore = new Map([["d1", { originalChannelId: "C_ORIG", originalTs: "111" }]]);
    const app = makeFakeApp();
    const order = [];
    const client = makeFakeClient({
      chat: {
        postMessage: async () => { order.push("reply"); return { ts: "ts2" }; },
        update: async () => { order.push("update"); return {}; },
      },
    });
    registerDirectInputActions(app, makeDeps(draftStore, {
      checkInquiryDone: async () => { order.push("sheet"); },
    }));

    await app._registered.actions["inquiry_done"]({
      ack: async () => {},
      body: {
        user: { id: "U_HANDLER" },
        channel: { id: "C_PM" },
        message: { ts: "m_ts", text: "원본", blocks: [{ type: "section" }, { type: "actions" }] },
        actions: [{ value: JSON.stringify({ submitterId: "U_SUBMIT", draftId: "d1", historyRowIndex: 9 }) }],
      },
      client,
    });

    assert.deepEqual(order, ["sheet", "reply", "update"]);
  });

  it("시트 체크 실패 시 답변 버튼과 완료 UI를 확정하지 않는다", async () => {
    const draftStore = new Map([["d1", { originalChannelId: "C_ORIG", originalTs: "111" }]]);
    const app = makeFakeApp();
    let replyPosts = 0;
    let updates = 0;
    const client = makeFakeClient({
      chat: {
        postMessage: async payload => {
          if (payload.blocks?.some(block => block.type === "actions")) replyPosts++;
          return { ts: "ts2" };
        },
        update: async () => { updates++; return {}; },
      },
    });
    registerDirectInputActions(app, makeDeps(draftStore, {
      checkInquiryDone: async () => { throw new Error("sheet unavailable"); },
    }));

    await app._registered.actions["inquiry_done"]({
      ack: async () => {},
      body: {
        user: { id: "U_HANDLER" },
        channel: { id: "C_PM" },
        message: { ts: "m_ts", text: "원본", blocks: [{ type: "section" }, { type: "actions" }] },
        actions: [{ value: JSON.stringify({ submitterId: "U_SUBMIT", draftId: "d1", historyRowIndex: 9 }) }],
      },
      client,
    });

    assert.equal(replyPosts, 0);
    assert.equal(updates, 0);
  });

  it("완료 메타데이터에 시트 행 번호가 없으면 완료 UI를 확정하지 않는다", async () => {
    const draftStore = new Map([["d1", { originalChannelId: "C_ORIG", originalTs: "111" }]]);
    const app = makeFakeApp();
    let updates = 0;
    const client = makeFakeClient({
      chat: {
        postMessage: async () => ({ ts: "notice" }),
        update: async () => { updates++; return {}; },
      },
    });
    registerDirectInputActions(app, makeDeps(draftStore, {
      checkInquiryDone: async () => {},
    }));

    await app._registered.actions["inquiry_done"]({
      ack: async () => {},
      body: {
        user: { id: "U_HANDLER" },
        channel: { id: "C_PM" },
        message: { ts: "m_ts", text: "원본", blocks: [{ type: "section" }, { type: "actions" }] },
        actions: [{ value: JSON.stringify({ submitterId: "U_SUBMIT", draftId: "d1" }) }],
      },
      client,
    });

    assert.equal(updates, 0);
  });

  it("답변 버튼 게시 결과가 불명확하면 review_required로 고정하고 다시 게시하지 않는다", async () => {
    const draftStore = new Map([["d1", { originalChannelId: "C_ORIG", originalTs: "111" }]]);
    const app = makeFakeApp();
    let sheetChecks = 0;
    let replyPosts = 0;
    let updates = 0;
    const client = makeFakeClient({
      chat: {
        postMessage: async payload => {
          if (payload.blocks?.some(block => block.type === "actions")) {
            replyPosts++;
            throw new Error("reply post failed");
          }
          return { ts: "ts2" };
        },
        update: async () => { updates++; return {}; },
      },
    });
    registerDirectInputActions(app, makeDeps(draftStore, {
      checkInquiryDone: async () => { sheetChecks++; },
    }));
    const args = {
      ack: async () => {},
      body: {
        user: { id: "U_HANDLER" },
        channel: { id: "C_PM" },
        message: { ts: "m_ts", text: "원본", blocks: [{ type: "section" }, { type: "actions" }] },
        actions: [{ value: JSON.stringify({ submitterId: "U_SUBMIT", draftId: "d1", historyRowIndex: 9 }) }],
      },
      client,
    };

    await app._registered.actions["inquiry_done"](args);
    assert.ok([...draftStore.values()].some(value => value?.status === "review_required"));
    await app._registered.actions["inquiry_done"](args);

    assert.equal(sheetChecks, 1);
    assert.equal(replyPosts, 1);
    assert.equal(updates, 0);
  });

  it("마지막 완료 UI 갱신 실패 후 재클릭해도 답변 버튼을 중복 게시하지 않는다", async () => {
    const draftStore = new Map([["d1", { originalChannelId: "C_ORIG", originalTs: "111" }]]);
    const app = makeFakeApp();
    let sheetChecks = 0;
    let replyPosts = 0;
    let updateAttempts = 0;
    const client = makeFakeClient({
      chat: {
        postMessage: async payload => {
          if (payload.blocks?.some(block => block.type === "actions")) replyPosts++;
          return { ts: "reply-ts" };
        },
        update: async () => {
          updateAttempts++;
          if (updateAttempts === 1) throw new Error("update failed");
          return {};
        },
      },
    });
    registerDirectInputActions(app, makeDeps(draftStore, {
      checkInquiryDone: async () => { sheetChecks++; },
    }));
    const args = {
      ack: async () => {},
      body: {
        user: { id: "U_HANDLER" },
        channel: { id: "C_PM" },
        message: { ts: "m_ts", text: "원본", blocks: [{ type: "section" }, { type: "actions" }] },
        actions: [{ value: JSON.stringify({ submitterId: "U_SUBMIT", draftId: "d1", historyRowIndex: 9 }) }],
      },
      client,
    };

    await app._registered.actions["inquiry_done"](args);
    assert.ok(
      [...draftStore.values()].some(value => value?.followupMessageTs === "reply-ts"),
      "후속 메시지 ts를 저장해 재클릭 중복을 막아야 함"
    );
    await app._registered.actions["inquiry_done"](args);

    assert.equal(sheetChecks, 1, "UI 재시도에서는 확인된 시트 기록을 다시 쓰지 않아야 함");
    assert.equal(replyPosts, 1);
    assert.equal(updateAttempts, 2);
  });

  it("실제 완료용 Sheets 설정이 누락되면 후속 버튼과 완료 UI를 실행하지 않는다", async () => {
    const draftStore = new Map([["d1", { originalChannelId: "C_ORIG", originalTs: "111" }]]);
    const app = makeFakeApp();
    let followupPosts = 0;
    let updates = 0;
    const client = makeFakeClient({
      chat: {
        postMessage: async payload => {
          if (payload.blocks?.some(block => block.type === "actions")) followupPosts++;
          return { ts: "notice" };
        },
        update: async () => { updates++; return {}; },
      },
    });
    const { checkInquiryDone } = createInquiryHistory({
      sheetsClient: { batchUpdate: async () => { throw new Error("must not call"); } },
      historySheetId: undefined,
      historyGridSheetId: 321,
    });
    registerDirectInputActions(app, makeDeps(draftStore, { checkInquiryDone }));

    await app._registered.actions["inquiry_done"]({
      ack: async () => {},
      body: {
        user: { id: "U_HANDLER" },
        channel: { id: "C_PM" },
        message: { ts: "m_ts", text: "원본", blocks: [{ type: "section" }, { type: "actions" }] },
        actions: [{ value: JSON.stringify({ submitterId: "U_SUBMIT", draftId: "d1", historyRowIndex: 9 }) }],
      },
      client,
    });

    assert.equal(followupPosts, 0);
    assert.equal(updates, 0);
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

  it("같은 intent 재클릭은 외부 재전송 없이 기존 preview를 terminal UI로 바꾼다", async () => {
    const draftStore = new Map([["d1", { draftId: "d1", workName: "작품" }]]);
    const app = makeFakeApp();
    let updates = 0;
    let lastBlocks = null;
    registerDirectInputActions(app, makeDeps(draftStore, {
      postInquiryToTargetChannel: async () => ({
        publicationStatus: "sent",
        replay: true,
        intentConflict: false,
      }),
    }));
    const client = makeFakeClient({
      chat: {
        postMessage: async () => ({ ts: "notice" }),
        update: async payload => { updates++; lastBlocks = payload.blocks; return {}; },
      },
    });

    await app._registered.actions.send_inquiry_now({
      ack: async () => {},
      body: {
        user: { id: "U1" },
        channel: { id: "D1" },
        message: { ts: "preview-ts", text: "preview", blocks: [{ type: "section" }, { type: "actions" }] },
        actions: [{ value: "d1" }],
      },
      client,
    });

    assert.equal(updates, 1);
    assert.equal(lastBlocks.some(block => block.type === "actions"), false);
  });

  it("게시 결과가 review_required면 원래 preview action을 제거해 blind retry를 막는다", async () => {
    const draftStore = new Map([["d-review", { draftId: "d-review", workName: "작품" }]]);
    const app = makeFakeApp();
    let updatedBlocks = null;
    registerDirectInputActions(app, makeDeps(draftStore, {
      postInquiryToTargetChannel: async () => {
        const error = new Error("response lost");
        error.publicationRecovery = "review_required";
        throw error;
      },
    }));
    const client = makeFakeClient({
      chat: {
        postMessage: async () => ({ ts: "notice" }),
        update: async payload => { updatedBlocks = payload.blocks; return {}; },
      },
    });

    await app._registered.actions.send_inquiry_now({
      ack: async () => {},
      body: {
        user: { id: "U1" },
        channel: { id: "D1" },
        message: { ts: "preview-ts", text: "preview", blocks: [{ type: "section" }, { type: "actions" }] },
        actions: [{ value: "d-review" }],
      },
      client,
    });

    assert.ok(updatedBlocks);
    assert.equal(updatedBlocks.some(block => block.type === "actions"), false);
  });

  it("이미 전송된 draft의 오래된 수정 modal은 draft를 바꾸거나 외부 게시하지 않고 새 문의를 안내한다", async () => {
    const originalDraft = {
      draftId: "d-stale",
      draftVersion: 1,
      workName: "전송된 작품",
      inquiryContent: "전송된 내용",
      dmChannelId: "D1",
    };
    const draftStore = new Map([
      ["d-stale", { ...originalDraft }],
      ["inquiry_publication:d-stale", { status: "sent", intentVersion: 1 }],
    ]);
    const app = makeFakeApp();
    let publishCalls = 0;
    const notices = [];
    registerDirectInputActions(app, makeDeps(draftStore, {
      postInquiryToTargetChannel: async () => { publishCalls++; return { publicationStatus: "sent" }; },
    }));
    const client = makeFakeClient({
      chat: {
        postMessage: async payload => { notices.push(payload.text); return { ts: "notice" }; },
        update: async () => ({}),
      },
    });

    await app._registered.views.submit_inquiry_modal({
      ack: async () => {},
      body: { user: { id: "U1" } },
      view: {
        private_metadata: JSON.stringify({ draftId: "d-stale", draftVersion: 1 }),
        state: { values: {
          work_name_block: { work_name_input: { value: "바뀐 작품" } },
          work_name_ko_block: { work_name_ko_input: { value: "" } },
          episode_block: { episode_input: { value: "2" } },
          inquiry_type_block: { inquiry_type_input: { value: "기타" } },
          inquiry_content_block: { inquiry_content_input: { value: "바뀐 내용" } },
          summary_block: { summary_input: { value: "바뀐 요약" } },
          action_block: { action_input: { value: "바뀐 액션" } },
          link_block: { link_input: { value: "" } },
        } },
      },
      client,
    });

    assert.equal(publishCalls, 0);
    assert.deepEqual(draftStore.get("d-stale"), originalDraft);
    assert.ok(notices.some(text => text.includes("이미 전송") && text.includes("새 문의")));
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
