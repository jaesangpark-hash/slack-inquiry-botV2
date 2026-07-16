"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const registerRetakeFlow = require("../../retakeFlow");

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

function makeResponse(json) {
  return {
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => json,
    text: async () => JSON.stringify(json),
  };
}

function makeDraft(overrides = {}) {
  return {
    draftId: "retake-1",
    ownerUserId: "U_OWNER",
    dmChannelId: "D1",
    workName: "테스트 작품",
    episode: "7",
    operationName: "번역",
    operationUuid: "operation-1",
    sourceTaskUuid: "source-task-1",
    workerEmail: null,
    ...overrides,
  };
}

function makeClient({ failCompletionNotice = false } = {}) {
  const calls = [];
  return {
    calls,
    chat: {
      postMessage: async payload => {
        calls.push(payload);
        if (failCompletionNotice && payload.text?.includes("태스크 재생성 완료")) {
          throw new Error("Slack notice failed");
        }
        return { ts: "1.0" };
      },
      update: async () => ({}),
    },
    views: { open: async () => ({}), update: async () => ({}) },
  };
}

function createHarness(draftOverrides = {}) {
  const app = makeApp();
  const draftStore = new Map([["retake-1", makeDraft(draftOverrides)]]);
  registerRetakeFlow(app, {
    ai: { models: { generateContent: async () => ({ text: "{}" }) } },
    GEMINI_MODEL: "fake",
    matchWorkTitleFromSheet: async () => null,
    matchWorkTitleByTokens: async () => null,
    matchWorkTitleWithCandidates: async () => null,
    generateDraftId: () => "generated",
    draftStore,
    sheetsClient: { getValues: async () => [] },
    fetchDeliveryDate: async () => null,
    resolveApmUserId: () => null,
  });
  return {
    draftStore,
    handler: app.views.get("submit_retake_date_modal"),
  };
}

async function invokeWithFetch(handler, client, fetchImplementation, count = 1) {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (...args) => {
    calls.push(args);
    return fetchImplementation(...args);
  };
  try {
    for (let index = 0; index < count; index++) {
      await handler({
        ack: async () => {},
        body: { user: { id: "U_OWNER" } },
        view: {
          private_metadata: JSON.stringify({ draftId: "retake-1" }),
          state: { values: {
            rt_start_block: { value: { selected_date: "2026-07-20" } },
            rt_end_block: { value: { selected_date: "2026-07-21" } },
            rt_end_time_block: { value: { selected_time: "18:30" } },
          } },
        },
        client,
      });
    }
  } finally {
    global.fetch = originalFetch;
  }
  return calls;
}

describe("retakeFlow mutation truth", () => {
  test("태스크 생성과 날짜 반영이 모두 성공해야 completed로 확정한다", async () => {
    const { draftStore, handler } = createHarness();
    const client = makeClient();
    const fetchCalls = await invokeWithFetch(handler, client, async url => {
      if (url.endsWith("/retake")) {
        return makeResponse({ success: true, data: { createdTaskUuids: ["created-1"] } });
      }
      return makeResponse({ success: true, data: { 실패: 0 } });
    });

    assert.equal(fetchCalls.length, 2);
    assert.deepEqual(draftStore.get("retake-1").createdTaskUuids, ["created-1"]);
    assert.equal(draftStore.get("retake-1").retakeMutationStatus, "completed");
  });

  test("날짜 반영 실패 시 생성 UUID를 보존하고 ready로 복구한다", async () => {
    const { draftStore, handler } = createHarness();
    const client = makeClient();
    await invokeWithFetch(handler, client, async url => {
      if (url.endsWith("/retake")) {
        return makeResponse({ success: true, data: { createdTaskUuids: ["created-1"] } });
      }
      return makeResponse({ success: false, error: { message: "date rejected" } });
    });

    const saved = draftStore.get("retake-1");
    assert.deepEqual(saved.createdTaskUuids, ["created-1"]);
    assert.equal(saved.retakeMutationStatus, "ready");
    const failure = client.calls.find(call => call.text?.includes("태스크는 생성됐지만"));
    assert.equal(failure.blocks[1].elements[0].action_id, "retake_open_date_modal");
  });

  test("생성 UUID가 저장된 재시도는 retake API를 건너뛰고 날짜만 반영한다", async () => {
    const { draftStore, handler } = createHarness({
      createdTaskUuids: ["created-before"],
      retakeMutationStatus: "ready",
    });
    const client = makeClient();
    const fetchCalls = await invokeWithFetch(
      handler,
      client,
      async () => makeResponse({ success: true, data: { 실패: 0 } })
    );

    assert.equal(fetchCalls.length, 1);
    assert.ok(String(fetchCalls[0][0]).endsWith("/tasks/dates"));
    assert.equal(draftStore.get("retake-1").retakeMutationStatus, "completed");
  });

  test("생성 성공 응답에 UUID가 없으면 운영자 확인 상태로 전환한다", async () => {
    const { draftStore, handler } = createHarness();
    const client = makeClient();
    const fetchCalls = await invokeWithFetch(
      handler,
      client,
      async () => makeResponse({ success: true, data: { createdTaskUuids: [] } })
    );

    assert.equal(fetchCalls.length, 1);
    assert.equal(draftStore.get("retake-1").retakeMutationStatus, "review_required");
    assert.ok(client.calls.some(call => call.text?.includes("Totus에서 생성 여부를 확인")));
  });

  test("리테이크 POST transport 예외 뒤 같은 draft 재실행은 POST를 다시 보내지 않는다", async () => {
    const { draftStore, handler } = createHarness();
    const client = makeClient();
    const fetchCalls = await invokeWithFetch(
      handler,
      client,
      async () => { throw new Error("socket closed after commit"); },
      2
    );

    assert.equal(fetchCalls.length, 1);
    assert.equal(draftStore.get("retake-1").retakeMutationStatus, "review_required");
    assert.ok(client.calls.some(call => call.text?.includes("자동 재시도하지 않았어")));
  });

  test("응답 유실 뒤 프로세스 재시작으로 draft가 사라지면 오래된 제출은 POST하지 않는다", async () => {
    const { draftStore, handler } = createHarness();
    const client = makeClient();
    const firstCalls = await invokeWithFetch(
      handler,
      client,
      async () => { throw new Error("socket closed after commit"); }
    );

    draftStore.clear();
    const afterRestartCalls = await invokeWithFetch(
      handler,
      client,
      async () => { throw new Error("must not call after restart"); }
    );

    assert.equal(firstCalls.length, 1);
    assert.equal(afterRestartCalls.length, 0);
  });

  test("명시적 success=false는 ready로 복구되어 안전 재시도할 수 있다", async () => {
    const { draftStore, handler } = createHarness();
    const client = makeClient();
    const fetchCalls = await invokeWithFetch(
      handler,
      client,
      async () => makeResponse({ success: false, error: { message: "rejected" } }),
      2
    );

    assert.equal(fetchCalls.length, 2);
    assert.equal(draftStore.get("retake-1").retakeMutationStatus, "ready");
  });

  test("날짜 API의 부분 실패를 완료로 오인하지 않는다", async () => {
    const { draftStore, handler } = createHarness();
    const client = makeClient();
    await invokeWithFetch(handler, client, async url => {
      if (url.endsWith("/retake")) {
        return makeResponse({ success: true, data: { createdTaskUuids: ["created-1"] } });
      }
      return makeResponse({
        success: true,
        data: { 실패: 1, failedTaskUuids: ["created-1"] },
      });
    });

    assert.equal(draftStore.get("retake-1").retakeMutationStatus, "ready");
    assert.equal(client.calls.some(call => call.text?.includes("재생성 완료")), false);
  });

  test("외부 변경 뒤 Slack 완료 알림이 실패해도 completed 상태를 유지한다", async () => {
    const { draftStore, handler } = createHarness();
    const client = makeClient({ failCompletionNotice: true });
    const fetchCalls = await invokeWithFetch(handler, client, async url => {
      if (url.endsWith("/retake")) {
        return makeResponse({ success: true, data: { createdTaskUuids: ["created-1"] } });
      }
      return makeResponse({ success: true, data: { 실패: 0 } });
    });

    assert.equal(fetchCalls.length, 2);
    assert.equal(draftStore.get("retake-1").retakeMutationStatus, "completed");
    assert.ok(client.calls.some(call => call.text?.includes("안내 중 오류")));
  });
});
