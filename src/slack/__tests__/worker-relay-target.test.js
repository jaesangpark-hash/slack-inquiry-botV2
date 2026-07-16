"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const registerWorkerRelayFlow = require("../../workerRelayFlow");

function makeApp() {
  const actions = new Map();
  const views = new Map();
  return {
    action(matcher, handler) { actions.set(String(matcher), handler); },
    view(matcher, handler) { views.set(String(matcher), handler); },
    actions,
    views,
  };
}

function makeClient() {
  const posts = [];
  return {
    posts,
    chat: {
      update: async () => ({}),
      postMessage: async payload => {
        posts.push(payload);
        return { ts: `ts-${posts.length}` };
      },
    },
    conversations: { join: async () => ({}) },
    views: { open: async () => ({}) },
  };
}

function createHarness({ workerSlackId, workerChannelId = "" }) {
  const app = makeApp();
  const draftStore = new Map([["draft-1", {
    draftId: "draft-1",
    ownerUserId: "U_OWNER",
    dmChannelId: "D_OWNER",
    relayType: "번역문 누락",
    workName: "테스트 작품",
    episode: "1",
    episodeLabel: "1화",
    targetWorkerEmail: "worker@example.com",
    targetWorkerName: "작업자",
    targetOpName: "번역",
    inquiryDetail: "번역문을 보내주세요.",
    actionRequired: "번역문을 보내주세요.",
    imageUrls: [],
  }]]);
  registerWorkerRelayFlow(app, {
    ai: { models: { generateContent: async () => ({ text: "" }) } },
    GEMINI_MODEL: "fake",
    matchWorkTitleFromSheet: async () => null,
    generateDraftId: () => "retry-1",
    draftStore,
    sheetsClient: {
      getValues: async () => [
        ["이름", "Slack email", "Slack ID", "channel", "Totus email"],
        ["작업자", "worker@example.com", workerSlackId || "", workerChannelId, "worker@totus.test"],
      ],
    },
  });
  return { app, draftStore, client: makeClient() };
}

async function enterManualChannel({ app, client }) {
  await app.views.get("wr_manual_channel_submit")({
    ack: async () => {},
    body: {
      user: { id: "U_OWNER" },
      view: {
        private_metadata: "retry-1",
        state: { values: { manual_channel_block: { value: { value: "C_MANUAL" } } } },
      },
    },
    view: {
      private_metadata: "retry-1",
      state: { values: { manual_channel_block: { value: { value: "C_MANUAL" } } } },
    },
    client,
  });
}

describe("worker relay manual channel target", () => {
  test("실제 대상 선택에서 첫 조회 Slack ID를 draft에 즉시 보존한다", async () => {
    const { app, draftStore, client } = createHarness({ workerSlackId: "U_FIRST" });
    draftStore.set("pending-1", {
      workers: [{
        workerEmail: "worker@example.com",
        workerName: "작업자",
        opName: "번역",
        opCode: "OTC0012",
      }],
      requesterWorker: { opName: "식자", workerEmail: "requester@example.com" },
      dmChannelId: "D_OWNER",
      data: {
        ownerUserId: "U_OWNER",
        relayType: "번역문 누락",
        inquiryDetail: "번역문을 보내주세요.",
        actionRequired: "번역문을 보내주세요.",
        workName: "테스트 작품",
        episode: "1",
        episodeLabel: "1화",
        sourceLang: "ko",
        imageUrls: [],
      },
    });
    const pickHandler = [...app.actions.entries()]
      .find(([key]) => key.includes("wr_pick_target"))[1];

    await pickHandler({
      ack: async () => {},
      body: {
        actions: [{ value: JSON.stringify({ pendingId: "pending-1", idx: 0 }) }],
      },
      client,
    });

    assert.equal(draftStore.get("retry-1").targetWorkerSlackIds, "U_FIRST");
  });

  test("조회한 작업자 Slack ID를 retry부터 최종 record까지 보존한다", async () => {
    const { app, draftStore, client } = createHarness({ workerSlackId: "U_WORKER" });
    await app.actions.get("wr_send")({
      ack: async () => {},
      body: {
        user: { id: "U_OWNER" },
        actions: [{ value: "draft-1" }],
        channel: { id: "D_OWNER" },
        message: { ts: "1.0" },
      },
      client,
    });

    assert.equal(draftStore.get("retry-1").targetWorkerSlackIds, "U_WORKER");
    await enterManualChannel({ app, client });
    assert.equal(draftStore.get("draft-1").targetWorkerSlackIds, "U_WORKER");
    const workerPost = client.posts.find(post => post.channel === "C_MANUAL");
    assert.ok(workerPost.blocks.some(block =>
      block.elements?.some(element => element.action_id === "wr_worker_reply")
    ));
  });

  test("작업자 Slack ID를 모르면 답변 버튼을 노출하지 않는다", async () => {
    const { app, draftStore, client } = createHarness({ workerSlackId: "" });
    await app.actions.get("wr_send")({
      ack: async () => {},
      body: {
        user: { id: "U_OWNER" },
        actions: [{ value: "draft-1" }],
        channel: { id: "D_OWNER" },
        message: { ts: "1.0" },
      },
      client,
    });
    await enterManualChannel({ app, client });

    assert.equal(draftStore.get("draft-1").targetWorkerSlackIds, "");
    const workerPost = client.posts.find(post => post.channel === "C_MANUAL");
    assert.equal(workerPost.blocks.some(block =>
      block.elements?.some(element => element.action_id === "wr_worker_reply")
    ), false);
  });

  test("wr_send 동시 클릭은 첫 await 전에 선점하고 worker message를 한 번만 게시한다", async () => {
    const { app, draftStore, client } = createHarness({
      workerSlackId: "U_WORKER",
      workerChannelId: "C_WORKER",
    });
    let releasePost;
    const postGate = new Promise(resolve => { releasePost = resolve; });
    let workerPosts = 0;
    let successUpdates = 0;
    client.chat.postMessage = async payload => {
      client.posts.push(payload);
      if (payload.channel === "C_WORKER" && !payload.thread_ts) {
        workerPosts++;
        await postGate;
        return { ts: "worker-ts" };
      }
      return { ts: "notice-ts" };
    };
    client.chat.update = async payload => {
      if (payload.text?.includes("전송 완료")) successUpdates++;
      return {};
    };
    const args = {
      ack: async () => {},
      body: {
        user: { id: "U_OWNER" },
        actions: [{ value: "draft-1" }],
        channel: { id: "D_OWNER" },
        message: { ts: "1.0" },
      },
      client,
    };

    const first = app.actions.get("wr_send")(args);
    await new Promise(resolve => setImmediate(resolve));
    const second = app.actions.get("wr_send")(args);
    await new Promise(resolve => setImmediate(resolve));
    const postsBeforeRelease = workerPosts;
    const updatesBeforeRelease = successUpdates;
    // adapter 계약(R-3): worker의 in-progress marker는 status === "sending"이다 (primitive의
    // inProgress boolean 아님). 둘째 클릭 drop이 이 status marker로 성립함을 in-flight 시점에 고정한다.
    assert.equal(draftStore.get("draft-1").workerRelaySendStatus, "sending");
    releasePost();
    await Promise.allSettled([first, second]);

    assert.equal(postsBeforeRelease, 1);
    assert.equal(updatesBeforeRelease, 0, "worker ts 확인 전 성공 UI를 표시하면 안 됨");
    assert.equal(workerPosts, 1);
    assert.equal(successUpdates, 1);
    assert.equal(draftStore.get("draft-1").workerRelaySendStatus, "sent");
  });

  test("worker 게시 응답 유실은 review_required로 잠그고 재클릭에서 blind repost하지 않는다", async () => {
    const { app, draftStore, client } = createHarness({
      workerSlackId: "U_WORKER",
      workerChannelId: "C_WORKER",
    });
    let workerPosts = 0;
    let successUpdates = 0;
    client.chat.postMessage = async payload => {
      client.posts.push(payload);
      if (payload.channel === "C_WORKER" && !payload.thread_ts) {
        workerPosts++;
        throw new Error("response lost after commit");
      }
      return { ts: "notice-ts" };
    };
    client.chat.update = async payload => {
      if (payload.text?.includes("전송 완료")) successUpdates++;
      return {};
    };
    const args = {
      ack: async () => {},
      body: {
        user: { id: "U_OWNER" },
        actions: [{ value: "draft-1" }],
        channel: { id: "D_OWNER" },
        message: { ts: "1.0" },
      },
      client,
    };

    await app.actions.get("wr_send")(args);
    await app.actions.get("wr_send")(args);

    assert.equal(workerPosts, 1);
    assert.equal(successUpdates, 0);
    assert.equal(draftStore.get("draft-1").workerRelaySendStatus, "review_required");
  });

  test("worker ts 확인 후 UI만 실패하면 재클릭은 UI만 복구하고 worker를 재게시하지 않는다", async () => {
    const { app, draftStore, client } = createHarness({
      workerSlackId: "U_WORKER",
      workerChannelId: "C_WORKER",
    });
    let workerPosts = 0;
    let updateAttempts = 0;
    client.chat.postMessage = async payload => {
      client.posts.push(payload);
      if (payload.channel === "C_WORKER" && !payload.thread_ts) {
        workerPosts++;
        return { ts: "worker-ts" };
      }
      return { ts: "notice-ts" };
    };
    client.chat.update = async () => {
      updateAttempts++;
      if (updateAttempts === 1) throw new Error("UI unavailable");
      return {};
    };
    const args = {
      ack: async () => {},
      body: {
        user: { id: "U_OWNER" },
        actions: [{ value: "draft-1" }],
        channel: { id: "D_OWNER" },
        message: { ts: "1.0" },
      },
      client,
    };

    await app.actions.get("wr_send")(args);
    await app.actions.get("wr_send")(args);

    assert.equal(workerPosts, 1);
    assert.equal(updateAttempts, 2);
    assert.equal(draftStore.get("draft-1").workerRelaySendStatus, "sent");
    assert.equal(draftStore.get("draft-1").workerRelayUiPending, false);
  });
});
