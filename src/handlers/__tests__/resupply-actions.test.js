"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const registerResupplyActions = require("../resupply-actions");
const createResupplyRecord = require("../../sheets/resupply-record");
const createInquiryBlocks = require("../../slack/inquiry-blocks");
const {
  createCompletionFollowupMarker,
} = require("../../slack/completion-coordinator");

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
      checkResupplyDone: async () => {},
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

  it("등록 핸들러 총 6개 (actions 5 + views 1)", () => {
    assert.equal(Object.keys(app._registered.actions).length, 5);
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
      checkResupplyDone: async () => {},
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
      checkResupplyDone: async () => {},
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
      checkResupplyDone: async () => {},
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

describe("재수급 요청 게시 — 시트 행 선확정", () => {
  it("실제 메시지 builder가 확정 row 41을 완료 버튼에 영속하고 완료 handler가 그 행을 처리한다", async () => {
    const draftStore = new Map([["d-row-wiring", {
      draftId: "d-row-wiring",
      ownerUserId: "U_OWNER",
      apmUserId: "U_APM",
      dmChannelId: "D_OWNER",
      originalChannelId: "C_ORIGINAL",
      originalTs: "111.222",
      workName: "작품 41",
      episode: "9",
      deliveryDate: "2026-07-20",
      fileNumbers: ["3", "4"],
      reason: "파일 손상",
      sourceLink: "",
    }]]);
    const app = makeFakeApp();
    const postedPayloads = [];
    const updatedPayloads = [];
    const checkedRows = [];
    const client = makeFakeClient({
      chat: {
        postMessage: async payload => {
          postedPayloads.push(payload);
          return { ts: payload.channel === "C_PM" && !payload.thread_ts ? "main-41" : "reply-41" };
        },
        update: async payload => { updatedPayloads.push(payload); return {}; },
      },
    });
    const {
      buildFileInquiryBlocks,
      buildFileInquiryMessage,
    } = createInquiryBlocks({ pmSlackId: "U_PM", fixedMentionUserIds: [] });

    registerResupplyActions(app, {
      draftStore,
      buildFileInquiryBlocks,
      buildFileInquiryMessage,
      appendResupplyRecord: async () => 41,
      checkResupplyDone: async rowIndex => { checkedRows.push(rowIndex); },
      PM_REQUEST_CHANNEL_ID: "C_PM",
    });

    await app._registered.actions["send_file_inquiry_now"]({
      ack: async () => {},
      body: { user: { id: "U_SUBMITTER" }, actions: [{ value: "d-row-wiring" }] },
      client,
    });

    const mainPayload = postedPayloads.find(payload =>
      payload.channel === "C_PM" && !payload.thread_ts
    );
    const doneButton = mainPayload.blocks
      .flatMap(block => block.elements || [])
      .find(element => element.action_id === "file_resupply_done");
    assert.ok(doneButton, "실제 main payload에 재수급 완료 버튼이 있어야 함");

    const completionMeta = JSON.parse(doneButton.value);
    assert.equal(completionMeta.resupplyRowIndex, 41, "최초 게시 시 row가 null이면 안 됨");
    assert.equal(completionMeta.ownerUserId, "U_OWNER");
    assert.equal(completionMeta.apmUserId, "U_APM");
    assert.equal(completionMeta.originalChannelId, "C_ORIGINAL");
    assert.equal(completionMeta.originalTs, "111.222");
    assert.equal(completionMeta.workName, "작품 41");
    assert.equal(completionMeta.episode, "9");
    assert.equal(draftStore.get("d-row-wiring").resupplyRowIndex, 41);

    await app._registered.actions["file_resupply_done"]({
      ack: async () => {},
      body: {
        user: { id: "U_HANDLER" },
        channel: { id: "C_PM" },
        message: { ts: "main-41", text: mainPayload.text, blocks: mainPayload.blocks },
        actions: [{ value: doneButton.value }],
      },
      client,
    });

    assert.deepEqual(checkedRows, [41]);
    assert.equal(updatedPayloads.length, 1);
    assert.equal(
      postedPayloads.some(payload => payload.text?.includes("완료 처리를 확정하지 못했어")),
      false
    );
  });

  it("send action의 시트 append 실패 시 PM 요청을 게시하지 않는다", async () => {
    const draftStore = new Map([["d1", {
      draftId: "d1", workName: "작품", episode: "5", fileNumbers: [], dmChannelId: "D1",
    }]]);
    const app = makeFakeApp();
    const postedChannels = [];
    const client = makeFakeClient({
      chat: {
        postMessage: async payload => { postedChannels.push(payload.channel); return { ts: "1" }; },
        update: async () => ({}),
      },
    });
    registerResupplyActions(app, {
      draftStore,
      buildFileInquiryBlocks: () => [],
      buildFileInquiryMessage: () => ({ text: "PM request" }),
      appendResupplyRecord: async () => { throw new Error("sheet unavailable"); },
      checkResupplyDone: async () => {},
      PM_REQUEST_CHANNEL_ID: "C_PM",
    });

    await app._registered.actions["send_file_inquiry_now"]({
      ack: async () => {},
      body: { user: { id: "U1" }, actions: [{ value: "d1" }] },
      client,
    });

    assert.equal(postedChannels.includes("C_PM"), false);
  });

  it("modal submit의 시트 행 번호 누락 시 PM 요청을 게시하지 않는다", async () => {
    const draftStore = new Map([["d1", {
      draftId: "d1", workName: "작품", episode: "5", fileNumbers: [], dmChannelId: "D1",
    }]]);
    const app = makeFakeApp();
    const postedChannels = [];
    const client = makeFakeClient({
      chat: {
        postMessage: async payload => { postedChannels.push(payload.channel); return { ts: "1" }; },
        update: async () => ({}),
      },
    });
    registerResupplyActions(app, {
      draftStore,
      buildFileInquiryBlocks: () => [],
      buildFileInquiryMessage: () => ({ text: "PM request" }),
      appendResupplyRecord: async () => null,
      checkResupplyDone: async () => {},
      PM_REQUEST_CHANNEL_ID: "C_PM",
    });

    await app._registered.views["submit_file_inquiry_modal"]({
      ack: async () => {},
      body: { user: { id: "U1" } },
      view: {
        private_metadata: JSON.stringify({ draftId: "d1" }),
        state: { values: {
          fi_work_block: { value: { value: "작품" } },
          fi_episode_block: { value: { value: "5" } },
          fi_files_block: { value: { value: "" } },
          fi_reason_block: { value: { value: "사유" } },
        } },
      },
      client,
    });

    assert.equal(postedChannels.includes("C_PM"), false);
  });

  it("main 게시 결과가 불명확하면 review_required로 고정하고 row/main을 다시 만들지 않는다", async () => {
    let appendCalls = 0;
    let mainCalls = 0;
    const draftStore = new Map([["d-main", {
      draftId: "d-main", workName: "작품", episode: "5", fileNumbers: [], dmChannelId: "D1",
    }]]);
    const app = makeFakeApp();
    const client = makeFakeClient({
      chat: {
        postMessage: async payload => {
          if (payload.channel === "C_PM") {
            mainCalls++;
            throw new Error("main response lost");
          }
          return { ts: "notice" };
        },
        update: async () => ({}),
      },
    });
    registerResupplyActions(app, {
      draftStore,
      buildFileInquiryBlocks: () => [],
      buildFileInquiryMessage: () => ({ text: "PM request" }),
      appendResupplyRecord: async () => { appendCalls++; return 31; },
      checkResupplyDone: async () => {},
      PM_REQUEST_CHANNEL_ID: "C_PM",
    });
    const args = {
      ack: async () => {},
      body: { user: { id: "U1" }, actions: [{ value: "d-main" }] },
      client,
    };

    await app._registered.actions["send_file_inquiry_now"](args);
    await app._registered.actions["send_file_inquiry_now"](args);

    assert.equal(appendCalls, 1);
    assert.equal(mainCalls, 1);
    assert.equal(draftStore.get("resupply_publication:d-main").status, "review_required");
  });

  it("thread 응답 유실은 review_required로 고정하고 재게시하지 않는다", async () => {
    let appendCalls = 0;
    let mainCalls = 0;
    let threadCalls = 0;
    const draftStore = new Map([["d-thread", {
      draftId: "d-thread", workName: "작품", episode: "5", fileNumbers: [],
      dmChannelId: "D1", sourceLink: "https://example.com/source",
    }]]);
    const app = makeFakeApp();
    const client = makeFakeClient({
      chat: {
        postMessage: async payload => {
          if (payload.channel === "C_PM" && !payload.thread_ts) {
            mainCalls++;
            return { ts: "main-thread" };
          }
          if (payload.channel === "C_PM" && payload.thread_ts) {
            threadCalls++;
            throw new Error("thread response lost");
          }
          return { ts: "notice" };
        },
        update: async () => ({}),
      },
    });
    registerResupplyActions(app, {
      draftStore,
      buildFileInquiryBlocks: () => [],
      buildFileInquiryMessage: () => ({ text: "PM request" }),
      appendResupplyRecord: async () => { appendCalls++; return 32; },
      checkResupplyDone: async () => {},
      PM_REQUEST_CHANNEL_ID: "C_PM",
    });
    const args = {
      ack: async () => {},
      body: { user: { id: "U1" }, actions: [{ value: "d-thread" }] },
      client,
    };

    await app._registered.actions["send_file_inquiry_now"](args);
    await app._registered.actions["send_file_inquiry_now"](args);

    const state = draftStore.get("resupply_publication:d-thread");
    assert.equal(state.status, "review_required");
    assert.equal(state.sheetRowIndex, 32);
    assert.equal(state.mainMessageTs, "main-thread");
    assert.equal(appendCalls, 1);
    assert.equal(mainCalls, 1);
    assert.equal(threadCalls, 1);
  });

  it("완료 DM 응답 유실도 review_required로 고정하고 재게시하지 않는다", async () => {
    let appendCalls = 0;
    let mainCalls = 0;
    let completionNoticeAttempts = 0;
    const draftStore = new Map([["d-notice", {
      draftId: "d-notice", workName: "작품", episode: "5", fileNumbers: [], dmChannelId: "D1",
    }]]);
    const app = makeFakeApp();
    const client = makeFakeClient({
      chat: {
        postMessage: async payload => {
          if (payload.channel === "C_PM") {
            mainCalls++;
            return { ts: "main-notice" };
          }
          if (payload.text?.startsWith("✅")) {
            completionNoticeAttempts++;
            throw new Error("DM response lost");
          }
          return { ts: "notice" };
        },
        update: async () => ({}),
      },
    });
    registerResupplyActions(app, {
      draftStore,
      buildFileInquiryBlocks: () => [],
      buildFileInquiryMessage: () => ({ text: "PM request" }),
      appendResupplyRecord: async () => { appendCalls++; return 33; },
      checkResupplyDone: async () => {},
      PM_REQUEST_CHANNEL_ID: "C_PM",
    });
    const args = {
      ack: async () => {},
      body: { user: { id: "U1" }, actions: [{ value: "d-notice" }] },
      client,
    };

    await app._registered.actions["send_file_inquiry_now"](args);
    await app._registered.actions["send_file_inquiry_now"](args);

    assert.equal(draftStore.get("resupply_publication:d-notice").status, "review_required");
    assert.equal(appendCalls, 1);
    assert.equal(mainCalls, 1);
    assert.equal(completionNoticeAttempts, 1);
  });

  it("동시 전송은 append와 main 게시를 각각 한 번만 실행한다", async () => {
    let resolveAppend;
    const appendResult = new Promise(resolve => { resolveAppend = resolve; });
    let appendCalls = 0;
    let mainCalls = 0;
    const draftStore = new Map([["d-concurrent", {
      draftId: "d-concurrent", workName: "작품", episode: "5", fileNumbers: [], dmChannelId: "D1",
    }]]);
    const app = makeFakeApp();
    const client = makeFakeClient({
      chat: {
        postMessage: async payload => {
          if (payload.channel === "C_PM") mainCalls++;
          return { ts: "main-concurrent" };
        },
        update: async () => ({}),
      },
    });
    registerResupplyActions(app, {
      draftStore,
      buildFileInquiryBlocks: () => [],
      buildFileInquiryMessage: () => ({ text: "PM request" }),
      appendResupplyRecord: async () => { appendCalls++; return appendResult; },
      checkResupplyDone: async () => {},
      PM_REQUEST_CHANNEL_ID: "C_PM",
    });
    const args = {
      ack: async () => {},
      body: { user: { id: "U1" }, actions: [{ value: "d-concurrent" }] },
      client,
    };

    const first = app._registered.actions["send_file_inquiry_now"](args);
    await app._registered.actions["send_file_inquiry_now"](args);
    resolveAppend(34);
    await first;

    assert.equal(appendCalls, 1);
    assert.equal(mainCalls, 1);
  });

  it("전송 완료 재클릭은 preview action을 제거한 terminal UI로 바꾼다", async () => {
    const draftStore = new Map([["d-terminal", {
      draftId: "d-terminal", workName: "작품", episode: "5", fileNumbers: [], dmChannelId: "D1",
    }]]);
    const app = makeFakeApp();
    let updatedBlocks = null;
    const client = makeFakeClient({
      chat: {
        postMessage: async payload => ({ ts: payload.thread_ts ? "thread" : "main" }),
        update: async payload => { updatedBlocks = payload.blocks; return {}; },
      },
    });
    registerResupplyActions(app, {
      draftStore,
      buildFileInquiryBlocks: () => [],
      buildFileInquiryMessage: () => ({ text: "PM request" }),
      appendResupplyRecord: async () => 35,
      checkResupplyDone: async () => {},
      PM_REQUEST_CHANNEL_ID: "C_PM",
    });
    const args = {
      ack: async () => {},
      body: {
        user: { id: "U1" },
        channel: { id: "D1" },
        message: { ts: "preview", text: "preview", blocks: [{ type: "section" }, { type: "actions" }] },
        actions: [{ value: "d-terminal" }],
      },
      client,
    };

    await app._registered.actions.send_file_inquiry_now(args);
    await app._registered.actions.send_file_inquiry_now(args);

    assert.ok(updatedBlocks);
    assert.equal(updatedBlocks.some(block => block.type === "actions"), false);
  });

  it("이미 전송된 재수급 draft의 오래된 modal은 draft 변경과 외부 게시 없이 새 요청을 안내한다", async () => {
    const originalDraft = {
      draftId: "d-stale-resupply",
      draftVersion: 1,
      workName: "전송된 작품",
      episode: "5",
      fileNumbers: ["1"],
      reason: "전송된 사유",
      dmChannelId: "D1",
    };
    const draftStore = new Map([
      ["d-stale-resupply", { ...originalDraft }],
      ["resupply_publication:d-stale-resupply", { status: "sent", intentVersion: 1 }],
    ]);
    const app = makeFakeApp();
    let appendCalls = 0;
    const notices = [];
    const client = makeFakeClient({
      chat: {
        postMessage: async payload => { notices.push(payload.text); return { ts: "notice" }; },
        update: async () => ({}),
      },
    });
    registerResupplyActions(app, {
      draftStore,
      buildFileInquiryBlocks: () => [],
      buildFileInquiryMessage: () => ({ text: "PM request" }),
      appendResupplyRecord: async () => { appendCalls++; return 99; },
      checkResupplyDone: async () => {},
      PM_REQUEST_CHANNEL_ID: "C_PM",
    });

    await app._registered.views.submit_file_inquiry_modal({
      ack: async () => {},
      body: { user: { id: "U1" } },
      view: {
        private_metadata: JSON.stringify({ draftId: "d-stale-resupply", draftVersion: 1 }),
        state: { values: {
          fi_work_block: { value: { value: "바뀐 작품" } },
          fi_episode_block: { value: { value: "9" } },
          fi_files_block: { value: { value: "8,9" } },
          fi_reason_block: { value: { value: "바뀐 사유" } },
        } },
      },
      client,
    });

    assert.equal(appendCalls, 0);
    assert.deepEqual(draftStore.get("d-stale-resupply"), originalDraft);
    assert.ok(notices.some(text => text.includes("이미 전송") && text.includes("새 재수급")));
  });
});

describe("file_resupply_done — 완료 진실성과 owner 안내", () => {
  function completionBody(metadataOverrides = {}) {
    return {
      user: { id: "U_HANDLER" },
      channel: { id: "C_PM" },
      message: {
        ts: "m_ts",
        text: "재수급 요청",
        blocks: [{ type: "section" }, { type: "actions" }],
      },
      actions: [{ value: JSON.stringify({
        originalChannelId: "C_ORIG",
        originalTs: "111",
        apmUserId: "U_APM",
        ownerUserId: "U_OWNER",
        workName: "작품",
        episode: "5",
        resupplyRowIndex: 8,
        ...metadataOverrides,
      }) }],
    };
  }

  function registerCompletion({
    checkResupplyDone,
    client,
    draftStore = new Map(),
    body = completionBody(),
  }) {
    const app = makeFakeApp();
    registerResupplyActions(app, {
      draftStore,
      buildFileInquiryBlocks: () => [],
      buildFileInquiryMessage: () => ({}),
      appendResupplyRecord: async () => 0,
      checkResupplyDone,
      PM_REQUEST_CHANNEL_ID: "C_PM",
    });
    return app._registered.actions["file_resupply_done"]({
      ack: async () => {},
      body,
      client,
    });
  }

  it("재시작 뒤 기존 재수급 followup marker를 찾으면 시트/후속 게시 없이 UI만 갱신한다", async () => {
    const draftStore = new Map();
    let sheetChecks = 0;
    let followupPosts = 0;
    let updates = 0;
    const completionStateKey = "file_resupply_done:C_PM:m_ts";
    const client = makeFakeClient({
      conversations: {
        replies: async () => ({ messages: [{
          ts: "existing-resupply-followup",
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

    await registerCompletion({
      checkResupplyDone: async () => { sheetChecks++; },
      client,
      draftStore,
    });

    assert.equal(sheetChecks, 0);
    assert.equal(followupPosts, 0);
    assert.equal(updates, 1);
    assert.equal(draftStore.get(completionStateKey).followupMessageTs, "existing-resupply-followup");
  });

  it("시트 체크와 후속 버튼 게시 뒤 완료 UI를 갱신하고 실제 owner를 안내한다", async () => {
    const order = [];
    let followupPayload;
    const client = makeFakeClient({
      chat: {
        postMessage: async payload => {
          order.push("followup");
          followupPayload = payload;
          return { ts: "thread-reply" };
        },
        update: async () => { order.push("update"); return {}; },
      },
    });

    await registerCompletion({
      checkResupplyDone: async () => { order.push("sheet"); },
      client,
    });

    assert.deepEqual(order, ["sheet", "followup", "update"]);
    assert.match(followupPayload.text, /<@U_OWNER>/);
    assert.doesNotMatch(followupPayload.text, /<@U_APM>/);
    assert.match(followupPayload.blocks[0].text.text, /<@U_OWNER>/);
    const followupButtons = followupPayload.blocks[1].elements;
    assert.deepEqual(
      followupButtons.map(button => button.action_id),
      ["resupply_upload_file"],
      "최초 완료 followup에는 업로드 버튼만 있어야 함"
    );
    for (const button of followupButtons) {
      assert.equal(JSON.parse(button.value).ownerUserId, "U_OWNER");
    }
  });

  it("시트 체크 실패 시 후속 버튼과 완료 UI를 확정하지 않는다", async () => {
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

    await registerCompletion({
      checkResupplyDone: async () => { throw new Error("sheet unavailable"); },
      client,
    });

    assert.equal(followupPosts, 0);
    assert.equal(updates, 0);
  });

  it("완료 메타데이터에 시트 행 번호가 없으면 완료 UI를 확정하지 않는다", async () => {
    let updates = 0;
    const client = makeFakeClient({
      chat: {
        postMessage: async () => ({ ts: "notice" }),
        update: async () => { updates++; return {}; },
      },
    });

    await registerCompletion({
      checkResupplyDone: async () => {},
      client,
      body: completionBody({ resupplyRowIndex: null }),
    });

    assert.equal(updates, 0);
  });

  it("후속 버튼 게시 결과가 불명확하면 review_required로 고정하고 다시 게시하지 않는다", async () => {
    const draftStore = new Map();
    let sheetChecks = 0;
    let followupPosts = 0;
    let updates = 0;
    const client = makeFakeClient({
      chat: {
        postMessage: async payload => {
          if (payload.blocks?.some(block => block.type === "actions")) {
            followupPosts++;
            throw new Error("followup post failed");
          }
          return { ts: "notice" };
        },
        update: async () => { updates++; return {}; },
      },
    });

    await registerCompletion({
      checkResupplyDone: async () => { sheetChecks++; },
      client,
      draftStore,
    });
    assert.ok([...draftStore.values()].some(value => value?.status === "review_required"));
    await registerCompletion({
      checkResupplyDone: async () => { sheetChecks++; },
      client,
      draftStore,
    });

    assert.equal(sheetChecks, 1);
    assert.equal(followupPosts, 1);
    assert.equal(updates, 0);
  });

  it("마지막 완료 UI 갱신 실패 후 재클릭해도 후속 버튼을 중복 게시하지 않는다", async () => {
    const draftStore = new Map();
    let sheetChecks = 0;
    let followupPosts = 0;
    let updateAttempts = 0;
    const client = makeFakeClient({
      chat: {
        postMessage: async payload => {
          if (payload.blocks?.some(block => block.type === "actions")) followupPosts++;
          return { ts: "followup-ts" };
        },
        update: async () => {
          updateAttempts++;
          if (updateAttempts === 1) throw new Error("update failed");
          return {};
        },
      },
    });

    await registerCompletion({
      checkResupplyDone: async () => { sheetChecks++; },
      client,
      draftStore,
    });
    assert.ok(
      [...draftStore.values()].some(value => value?.followupMessageTs === "followup-ts"),
      "후속 메시지 ts를 저장해 재클릭 중복을 막아야 함"
    );
    await registerCompletion({
      checkResupplyDone: async () => { sheetChecks++; },
      client,
      draftStore,
    });

    assert.equal(sheetChecks, 1);
    assert.equal(followupPosts, 1);
    assert.equal(updateAttempts, 2);
  });

  it("실제 완료용 Sheets 설정이 누락되면 후속 버튼과 완료 UI를 실행하지 않는다", async () => {
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
    const { checkResupplyDone } = createResupplyRecord({
      sheetsClient: { batchUpdate: async () => { throw new Error("must not call"); } },
      resupplySheetId: undefined,
      resupplySheetRange: "Resupply!A:H",
      resupplyGridSheetId: 511152201,
    });

    await registerCompletion({ checkResupplyDone, client });

    assert.equal(followupPosts, 0);
    assert.equal(updates, 0);
  });
});
