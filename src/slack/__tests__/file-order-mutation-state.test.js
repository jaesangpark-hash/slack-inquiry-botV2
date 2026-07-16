"use strict";

const { afterEach, describe, test } = require("node:test");
const assert = require("node:assert/strict");

const registerFileOrderFlow = require("../../fileOrderFlow");

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function jsonResponse(payload) {
  return {
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function makeHarness() {
  const actions = new Map();
  const app = {
    action(id, handler) { actions.set(String(id), handler); },
    view() {},
  };
  const draftStore = new Map([["fo-1", {
    type: "file_order",
    ownerUserId: "U_OWNER",
    workName: "테스트 작품",
    workNameKo: "테스트 작품",
    episode: "5",
    currentFiles: ["two.psd", "one.psd"],
    suggestedFiles: ["one.psd", "two.psd"],
    sourceGroupId: "SG1",
    fileMap: { "one.psd": "S1", "two.psd": "S2" },
  }]]);
  const updates = [];
  const posts = [];
  const client = {
    chat: {
      update: async payload => { updates.push(payload); return {}; },
      postMessage: async payload => { posts.push(payload); return { ts: `post-${posts.length}` }; },
    },
    views: { open: async () => ({}) },
  };
  registerFileOrderFlow(app, {
    ai: { models: { generateContent: async () => ({ text: "{}" }) } },
    GEMINI_MODEL: "fake",
    matchWorkTitleFromSheet: async () => null,
    matchWorkTitleWithCandidates: async () => null,
    generateDraftId: () => "generated",
    draftStore,
  });
  const body = {
    user: { id: "U_OWNER" },
    channel: { id: "D_OWNER" },
    message: { ts: "preview-ts" },
    actions: [{ value: "fo-1" }],
  };
  return { actions, body, client, draftStore, posts, updates };
}

describe("file_order_apply_suggested mutation checkpoint", () => {
  test("reorder 성공 뒤 complete 명시 실패 재시도는 complete만 다시 실행한다", async () => {
    const { actions, body, client, draftStore } = makeHarness();
    let reorderCalls = 0;
    let completeCalls = 0;
    global.fetch = async url => {
      if (url.includes("/files/reorder")) {
        reorderCalls++;
        return jsonResponse({ success: true });
      }
      if (url.includes("/source-groups/complete")) {
        completeCalls++;
        return jsonResponse(completeCalls === 1
          ? { success: false, error: { message: "명시 실패" } }
          : { success: true });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const handler = actions.get("file_order_apply_suggested");
    const args = { ack: async () => {}, body, client };

    await handler(args);
    await handler(args);

    assert.equal(reorderCalls, 1);
    assert.equal(completeCalls, 2);
    assert.equal(draftStore.get("fo-1").fileOrderMutation.status, "completed");
  });

  test("complete 응답 유실은 review_required로 고정하고 reorder/complete를 재실행하지 않는다", async () => {
    const { actions, body, client, draftStore } = makeHarness();
    let reorderCalls = 0;
    let completeCalls = 0;
    global.fetch = async url => {
      if (url.includes("/files/reorder")) {
        reorderCalls++;
        return jsonResponse({ success: true });
      }
      if (url.includes("/source-groups/complete")) {
        completeCalls++;
        throw new Error("response lost after commit");
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const handler = actions.get("file_order_apply_suggested");
    const args = { ack: async () => {}, body, client };

    await handler(args);
    await handler(args);

    assert.equal(reorderCalls, 1);
    assert.equal(completeCalls, 1);
    assert.equal(draftStore.get("fo-1").fileOrderMutation.status, "review_required");
    assert.equal(draftStore.get("fo-1").fileOrderMutation.stage, "complete");
  });

  test("동시 클릭은 첫 await 전에 선점해 reorder POST를 최대 한 번만 실행한다", async () => {
    const { actions, body, client } = makeHarness();
    let reorderCalls = 0;
    let releaseReorder;
    const reorderGate = new Promise(resolve => { releaseReorder = resolve; });
    global.fetch = async url => {
      if (url.includes("/files/reorder")) {
        reorderCalls++;
        await reorderGate;
        return jsonResponse({ success: true });
      }
      if (url.includes("/source-groups/complete")) return jsonResponse({ success: true });
      throw new Error(`unexpected fetch: ${url}`);
    };
    const handler = actions.get("file_order_apply_suggested");
    const args = { ack: async () => {}, body, client };

    const first = handler(args);
    await new Promise(resolve => setImmediate(resolve));
    const second = handler(args);
    await new Promise(resolve => setImmediate(resolve));
    const callsBeforeRelease = reorderCalls;
    releaseReorder();
    await Promise.allSettled([first, second]);

    assert.equal(callsBeforeRelease, 1);
    assert.equal(reorderCalls, 1);
  });

  test("두 POST 성공 후 UI만 실패하면 재클릭은 UI만 복구한다", async () => {
    const { actions, body, client, draftStore } = makeHarness();
    let reorderCalls = 0;
    let completeCalls = 0;
    let updateCalls = 0;
    global.fetch = async url => {
      if (url.includes("/files/reorder")) { reorderCalls++; return jsonResponse({ success: true }); }
      if (url.includes("/source-groups/complete")) { completeCalls++; return jsonResponse({ success: true }); }
      throw new Error(`unexpected fetch: ${url}`);
    };
    client.chat.update = async () => {
      updateCalls++;
      if (updateCalls === 1) throw new Error("UI unavailable");
      return {};
    };
    const handler = actions.get("file_order_apply_suggested");
    const args = { ack: async () => {}, body, client };

    await handler(args);
    await handler(args);

    assert.equal(reorderCalls, 1);
    assert.equal(completeCalls, 1);
    assert.equal(updateCalls, 2);
    assert.equal(draftStore.get("fo-1").fileOrderMutation.uiPending, false);
  });
});
