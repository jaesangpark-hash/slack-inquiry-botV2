"use strict";

const { afterEach, describe, test } = require("node:test");
const assert = require("node:assert/strict");

const registerResupplyActions = require("../resupply-actions");
const {
  createCompletionFollowupMarker,
} = require("../../slack/completion-coordinator");

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

function downloadResponse() {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
  };
}

function makeHarness(files) {
  const actions = new Map();
  const app = {
    action(id, handler) { actions.set(String(id), handler); },
    view() {},
  };
  const draftStore = new Map();
  const updates = [];
  const posts = [];
  const client = {
    conversations: {
      replies: async ({ channel }) => ({
        messages: channel === "C_PM" ? [{ files }] : [],
      }),
      history: async () => ({ messages: [] }),
    },
    chat: {
      update: async payload => { updates.push(payload); return {}; },
      postMessage: async payload => { posts.push(payload); return { ts: `post-${posts.length}` }; },
    },
    views: { open: async () => ({}) },
  };
  registerResupplyActions(app, {
    draftStore,
    buildFileInquiryBlocks: () => [],
    buildFileInquiryMessage: () => ({}),
    appendResupplyRecord: async () => 1,
    checkResupplyDone: async () => {},
    PM_REQUEST_CHANNEL_ID: "C_PM",
  });
  const body = {
    user: { id: "U_OWNER" },
    channel: { id: "C_PM" },
    message: { ts: "followup-ts", thread_ts: "main-ts", blocks: [{ type: "actions" }] },
    actions: [{ value: JSON.stringify({
      originalChannelId: "C_ORIGINAL",
      originalTs: "111.222",
      ownerUserId: "U_OWNER",
      workName: "테스트 작품",
      episode: "5",
    }) }],
  };
  return { actions, body, client, draftStore, posts, updates };
}

function uploadFileName(options) {
  return options.body?.get?.("file")?.name || "unknown";
}

function actionButton(updatePayload, actionId) {
  return updatePayload?.blocks
    ?.flatMap(block => block.elements || [])
    .find(element => element.action_id === actionId) || null;
}

function setConfirmedNotifyAction(body, metadataOverrides = {}) {
  const uploadMutationKey = `resupply_upload:${body.channel.id}:${body.message.ts}`;
  const currentMeta = JSON.parse(body.actions[0].value || "{}");
  body.actions = [{ value: JSON.stringify({
    ...currentMeta,
    uploadCompletionConfirmed: true,
    uploadMutationKey,
    ...metadataOverrides,
  }) }];
  return uploadMutationKey;
}

describe("resupply_upload_file mutation checkpoint", () => {
  test("일부 명시 실패 뒤 재클릭은 실패 파일만 재시도하고 성공 파일을 다시 올리지 않는다", async () => {
    const { actions, body, client, draftStore, updates } = makeHarness([
      { id: "F1", name: "one.psd", mimetype: "image/vnd.adobe.photoshop", url_private_download: "https://slack/F1" },
      { id: "F2", name: "two.psd", mimetype: "image/vnd.adobe.photoshop", url_private_download: "https://slack/F2" },
    ]);
    const uploadCalls = { "one.psd": 0, "two.psd": 0 };
    global.fetch = async (url, options = {}) => {
      if (url.includes("/projects?")) return jsonResponse({ success: true, data: [{ uuid: "P1" }] });
      if (url.startsWith("https://slack/")) return downloadResponse();
      if (url.includes("/files")) {
        const name = uploadFileName(options);
        uploadCalls[name]++;
        if (name === "two.psd" && uploadCalls[name] === 1) {
          return jsonResponse({ success: false, error: { message: "명시 실패" } });
        }
        return jsonResponse({ success: true, data: { uuid: `UP-${name}` } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const handler = actions.get("resupply_upload_file");
    const args = { ack: async () => {}, body, client };

    await handler(args);
    const retryButton = updates.at(-1).blocks
      .flatMap(block => block.elements || [])
      .find(element => element.action_id === "resupply_upload_file");
    assert.ok(retryButton, "명시 실패 파일용 재시도 버튼을 유지해야 함");
    assert.equal(
      actionButton(updates.at(-1), "resupply_notify_worker"),
      null,
      "일부 파일 실패 상태에서는 작업자 안내 버튼을 만들면 안 됨"
    );
    await handler(args);

    assert.deepEqual(uploadCalls, { "one.psd": 1, "two.psd": 2 });
    assert.equal(draftStore.get("resupply_upload:C_PM:followup-ts").status, "completed");
  });

  test("업로드 POST 응답 유실은 해당 파일 review_required로 잠그고 재클릭하지 않는다", async () => {
    const { actions, body, client, draftStore, updates } = makeHarness([
      { id: "F1", name: "unknown.psd", mimetype: "image/vnd.adobe.photoshop", url_private_download: "https://slack/F1" },
    ]);
    let uploadCalls = 0;
    global.fetch = async (url) => {
      if (url.includes("/projects?")) return jsonResponse({ success: true, data: [{ uuid: "P1" }] });
      if (url.startsWith("https://slack/")) return downloadResponse();
      if (url.includes("/files")) {
        uploadCalls++;
        throw new Error("response lost after commit");
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const handler = actions.get("resupply_upload_file");
    const args = { ack: async () => {}, body, client };

    await handler(args);
    await handler(args);

    assert.equal(uploadCalls, 1);
    const state = draftStore.get("resupply_upload:C_PM:followup-ts");
    assert.equal(state.status, "review_required");
    assert.equal(state.files.F1.status, "review_required");
    assert.equal(
      actionButton(updates.at(-1), "resupply_notify_worker"),
      null,
      "결과 확인 필요 상태에서는 작업자 안내 버튼을 만들면 안 됨"
    );
  });

  test("모든 파일 업로드가 확인된 경우에만 완료 증거가 든 작업자 안내 버튼을 만든다", async () => {
    const { actions, body, client, draftStore, updates } = makeHarness([
      { id: "F1", name: "done.psd", mimetype: "image/vnd.adobe.photoshop", url_private_download: "https://slack/F1" },
    ]);
    global.fetch = async (url) => {
      if (url.includes("/projects?")) return jsonResponse({ success: true, data: [{ uuid: "P1" }] });
      if (url.startsWith("https://slack/")) return downloadResponse();
      if (url.includes("/files")) return jsonResponse({ success: true, data: { uuid: "UP1" } });
      throw new Error(`unexpected fetch: ${url}`);
    };

    await actions.get("resupply_upload_file")({ ack: async () => {}, body, client });

    assert.equal(draftStore.get("resupply_upload:C_PM:followup-ts").status, "completed");
    const notifyButton = actionButton(updates.at(-1), "resupply_notify_worker");
    assert.ok(notifyButton, "모든 파일 업로드 확인 뒤에는 작업자 안내 버튼이 필요함");
    const notifyMeta = JSON.parse(notifyButton.value);
    assert.equal(notifyMeta.uploadCompletionConfirmed, true);
    assert.equal(notifyMeta.uploadMutationKey, "resupply_upload:C_PM:followup-ts");
  });

  test("동시 클릭은 첫 await 전에 선점해 파일 POST를 최대 한 번만 보낸다", async () => {
    const { actions, body, client } = makeHarness([
      { id: "F1", name: "once.psd", mimetype: "image/vnd.adobe.photoshop", url_private_download: "https://slack/F1" },
    ]);
    let uploadCalls = 0;
    let releaseUpload;
    const uploadGate = new Promise(resolve => { releaseUpload = resolve; });
    global.fetch = async (url) => {
      if (url.includes("/projects?")) return jsonResponse({ success: true, data: [{ uuid: "P1" }] });
      if (url.startsWith("https://slack/")) return downloadResponse();
      if (url.includes("/files")) {
        uploadCalls++;
        await uploadGate;
        return jsonResponse({ success: true, data: { uuid: "UP1" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const handler = actions.get("resupply_upload_file");
    const args = { ack: async () => {}, body, client };

    const first = handler(args);
    await new Promise(resolve => setImmediate(resolve));
    const second = handler(args);
    await new Promise(resolve => setImmediate(resolve));
    const callsBeforeRelease = uploadCalls;
    releaseUpload();
    await Promise.allSettled([first, second]);

    assert.equal(callsBeforeRelease, 1);
    assert.equal(uploadCalls, 1);
  });
});

describe("resupply_notify_worker mutation checkpoint", () => {
  test("업로드 완료 증거가 없으면 원본 스레드에 게시하지 않고 운영자에게 경고한다", async () => {
    const { actions, body, client, posts } = makeHarness([]);
    const warnings = [];
    client.chat.postMessage = async payload => {
      posts.push(payload);
      if (payload.channel === body.user.id) warnings.push(payload.text);
      return { ts: `post-${posts.length}` };
    };

    await actions.get("resupply_notify_worker")({ ack: async () => {}, body, client });

    assert.equal(
      posts.filter(payload => payload.channel === "C_ORIGINAL" && payload.thread_ts === "111.222").length,
      0
    );
    assert.ok(warnings.some(text => text.includes("업로드 완료 증거")));
  });

  test("업로드가 만든 완료 증거로 원본 알림을 marker와 함께 한 번 게시하고 버튼 UI를 갱신한다", async () => {
    const { actions, body, client, posts, updates } = makeHarness([
      { id: "F1", name: "done.psd", mimetype: "image/vnd.adobe.photoshop", url_private_download: "https://slack/F1" },
    ]);
    global.fetch = async (url) => {
      if (url.includes("/projects?")) return jsonResponse({ success: true, data: [{ uuid: "P1" }] });
      if (url.startsWith("https://slack/")) return downloadResponse();
      if (url.includes("/files")) return jsonResponse({ success: true, data: { uuid: "UP1" } });
      throw new Error(`unexpected fetch: ${url}`);
    };
    await actions.get("resupply_upload_file")({ ack: async () => {}, body, client });
    const completedUpdate = updates.at(-1);
    const notifyButton = actionButton(completedUpdate, "resupply_notify_worker");
    body.actions = [{ value: notifyButton.value }];
    body.message = { ...body.message, text: completedUpdate.text, blocks: completedUpdate.blocks };
    const updatesBeforeNotify = updates.length;

    await actions.get("resupply_notify_worker")({ ack: async () => {}, body, client });

    const originalNotifications = posts.filter(payload =>
      payload.channel === "C_ORIGINAL" && payload.thread_ts === "111.222"
    );
    assert.equal(originalNotifications.length, 1);
    assert.ok(originalNotifications[0].blocks.some(block =>
      block.block_id === createCompletionFollowupMarker("resupply_notify:C_PM:followup-ts")
    ));
    assert.equal(updates.length, updatesBeforeNotify + 1);
  });

  test("동시 작업자 안내 클릭은 원본 알림을 최대 한 번만 게시한다", async () => {
    const { actions, body, client, posts } = makeHarness([]);
    setConfirmedNotifyAction(body);
    let originalPosts = 0;
    let releasePost;
    const postGate = new Promise(resolve => { releasePost = resolve; });
    client.chat.postMessage = async payload => {
      posts.push(payload);
      if (payload.channel === "C_ORIGINAL") {
        originalPosts++;
        await postGate;
        return { ts: "original-notice" };
      }
      return { ts: `post-${posts.length}` };
    };
    const args = { ack: async () => {}, body, client };

    const first = actions.get("resupply_notify_worker")(args);
    await new Promise(resolve => setImmediate(resolve));
    const second = actions.get("resupply_notify_worker")(args);
    await new Promise(resolve => setImmediate(resolve));
    const callsBeforeRelease = originalPosts;
    releasePost();
    await Promise.allSettled([first, second]);

    assert.equal(callsBeforeRelease, 1);
    assert.equal(originalPosts, 1);
  });

  for (const responseMode of ["throw", "missing_ts"]) {
    test(`원본 알림 ${responseMode} 결과는 review_required로 잠그고 재클릭에서 재게시하지 않는다`, async () => {
      const { actions, body, client, draftStore, posts } = makeHarness([]);
      setConfirmedNotifyAction(body);
      let originalPosts = 0;
      client.chat.postMessage = async payload => {
        posts.push(payload);
        if (payload.channel === "C_ORIGINAL") {
          originalPosts++;
          if (responseMode === "throw") throw new Error("response lost after commit");
          return {};
        }
        return { ts: `post-${posts.length}` };
      };
      const handler = actions.get("resupply_notify_worker");
      const args = { ack: async () => {}, body, client };

      await handler(args);
      await handler(args);

      assert.equal(originalPosts, 1);
      assert.equal(draftStore.get("resupply_notify:C_PM:followup-ts").status, "review_required");
    });
  }

  test("원본 알림 확인 뒤 UI 갱신만 실패하면 재클릭은 UI만 복구한다", async () => {
    const { actions, body, client, draftStore, posts } = makeHarness([]);
    setConfirmedNotifyAction(body);
    let originalPosts = 0;
    let updateAttempts = 0;
    client.chat.postMessage = async payload => {
      posts.push(payload);
      if (payload.channel === "C_ORIGINAL") {
        originalPosts++;
        return { ts: "original-notice" };
      }
      return { ts: `post-${posts.length}` };
    };
    client.chat.update = async () => {
      updateAttempts++;
      if (updateAttempts === 1) throw new Error("button update failed");
      return {};
    };
    const handler = actions.get("resupply_notify_worker");
    const args = { ack: async () => {}, body, client };

    await handler(args);
    assert.equal(draftStore.get("resupply_notify:C_PM:followup-ts").uiPending, true);
    await handler(args);

    assert.equal(originalPosts, 1);
    assert.equal(updateAttempts, 2);
    assert.equal(draftStore.get("resupply_notify:C_PM:followup-ts").uiPending, false);
  });

  test("상태 초기화 뒤 기존 marker를 찾으면 원본 재게시 없이 UI만 갱신한다", async () => {
    const { actions, body, client, draftStore } = makeHarness([]);
    setConfirmedNotifyAction(body);
    const notifyStateKey = "resupply_notify:C_PM:followup-ts";
    let originalPosts = 0;
    let updates = 0;
    client.conversations.replies = async ({ channel }) => ({
      messages: channel === "C_ORIGINAL" ? [{
        ts: "existing-notice",
        blocks: [{ block_id: createCompletionFollowupMarker(notifyStateKey) }],
      }] : [],
    });
    client.chat.postMessage = async payload => {
      if (payload.channel === "C_ORIGINAL") originalPosts++;
      return { ts: "unexpected" };
    };
    client.chat.update = async () => { updates++; return {}; };

    await actions.get("resupply_notify_worker")({ ack: async () => {}, body, client });

    assert.equal(originalPosts, 0);
    assert.equal(updates, 1);
    assert.equal(draftStore.get(notifyStateKey).status, "sent");
    assert.equal(draftStore.get(notifyStateKey).notificationMessageTs, "existing-notice");
  });

  test("marker 조회 실패를 알림 성공으로 처리하지 않는다", async () => {
    const { actions, body, client, draftStore, posts } = makeHarness([]);
    setConfirmedNotifyAction(body);
    client.conversations.replies = async () => { throw new Error("reconcile unavailable"); };

    await actions.get("resupply_notify_worker")({ ack: async () => {}, body, client });

    assert.equal(posts.filter(payload => payload.channel === "C_ORIGINAL").length, 0);
    assert.notEqual(draftStore.get("resupply_notify:C_PM:followup-ts")?.status, "sent");
  });
});
