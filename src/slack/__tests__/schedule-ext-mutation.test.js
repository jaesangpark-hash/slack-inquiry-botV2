"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const registerScheduleExtFlow = require("../../scheduleExtFlow");

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
    draftId: "schext-1",
    ownerUserId: "U_OWNER",
    dmChannelId: "D1",
    workName: "테스트 작품",
    episode: 1,
    episodes: [1],
    episodeLabel: "1화",
    deliveryDateStr: "2026-08-01",
    isOverDelivery: false,
    tasks: [{ taskUuid: "task-1", opCode: "OTC0012" }],
    tasksByEpisode: {
      1: [{ taskUuid: "task-1", opCode: "OTC0012" }],
    },
    simTasks: [{
      opCode: "OTC0012",
      opName: "번역",
      startDateOrig: "2026-07-01T00:00:00+09:00",
      endDateOrig: "2026-07-02T23:59:59+09:00",
      newStartDateOrig: "2026-07-03T00:00:00+09:00",
      newEndDateOrig: "2026-07-04T23:59:59+09:00",
    }],
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
        if (failCompletionNotice && payload.text?.includes("일정 반영 완료")) {
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
  const draftStore = new Map([["schext-1", makeDraft(draftOverrides)]]);
  registerScheduleExtFlow(app, {
    ai: { models: { generateContent: async () => ({ text: "{}" }) } },
    GEMINI_MODEL: "fake",
    matchWorkTitleFromSheet: async () => null,
    generateDraftId: () => "generated",
    draftStore,
    fetchDeliveryDate: async () => null,
    sheetsClient: { getValues: async () => [] },
  });
  return { app, draftStore, handler: app.actions.get("schext_apply_all") };
}

async function invokeWithFetch(handler, client, fetchImplementation) {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (...args) => {
    calls.push(args);
    return fetchImplementation(...args);
  };
  try {
    await handler({
      ack: async () => {},
      body: { user: { id: "U_OWNER" }, actions: [{ value: "schext-1" }] },
      client,
    });
  } finally {
    global.fetch = originalFetch;
  }
  return calls;
}

describe("scheduleExtFlow mutation truth", () => {
  test("실제 재조회 action에서 일부 회차가 누락되면 전체 요청을 보존하고 apply를 만들지 않는다", async () => {
    const app = makeApp();
    const pendingId = "schext-retry-pending";
    const draftStore = new Map([[pendingId, {
      workName: "테스트 작품",
      pivoId: "PIVO-1",
      episodes: [1, 2],
      episodeLabel: "1-2화",
      extDays: 2,
      ownerUserId: "U_OWNER",
      dmChannelId: "D1",
    }]]);
    registerScheduleExtFlow(app, {
      ai: { models: { generateContent: async () => ({ text: "{}" }) } },
      GEMINI_MODEL: "fake",
      matchWorkTitleFromSheet: async () => null,
      generateDraftId: () => "schext-retry-next",
      draftStore,
      fetchDeliveryDate: async () => null,
      sheetsClient: { getValues: async () => [] },
    });
    const client = makeClient();
    const originalFetch = global.fetch;
    const fetchCalls = [];
    global.fetch = async (url, options = {}) => {
      fetchCalls.push({ url, method: options.method || "GET" });
      if (url.includes("/projects?pivoId=")) {
        return makeResponse({ success: true, data: [{ uuid: "project-1", pivoId: "PIVO-1", _detail: { 진행상태: "ACTIVE", pivoId: "PIVO-1" } }] });
      }
      if (url.includes("episode=1")) {
        return makeResponse({ success: true, data: [{ 오퍼레이션: [{ 태스크: [{
          uuid: "task-1",
          오퍼레이션유형: "OTC0012",
          오퍼레이션유형명: "번역",
          작업자: { 이메일: "worker@example.com", bid: "worker" },
          상태: "WORKING",
          시작일원본: "2026-07-01T00:00:00+09:00",
          마감일원본: "2026-07-02T23:59:59+09:00",
        }] }] }] });
      }
      if (url.includes("episode=2")) {
        return makeResponse({ success: true, data: [] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    try {
      await app.actions.get("schext_retry_proceed")({
        ack: async () => {},
        body: { user: { id: "U_OWNER" }, actions: [{ value: pendingId }] },
        client,
      });
    } finally {
      global.fetch = originalFetch;
    }

    const retryPending = draftStore.get("schext-retry-next");
    assert.deepEqual(retryPending.episodes, [1, 2]);
    assert.equal(retryPending.episodeLabel, "1-2화");
    assert.deepEqual(retryPending.missingEpisodes, [2]);
    assert.equal(fetchCalls.filter(call => call.method === "POST" && call.url.includes("/tasks/dates")).length, 0);
    assert.equal(client.calls.some(call => call.text?.includes("일정 반영 완료")), false);
    assert.equal(client.calls.flatMap(call => call.blocks || [])
      .flatMap(block => block.elements || [])
      .some(element => element.action_id === "schext_apply_all"), false);
  });

  test("전체 성공 응답일 때만 applied로 확정하고 완료를 알린다", async () => {
    const { draftStore, handler } = createHarness();
    const client = makeClient();
    const fetchCalls = await invokeWithFetch(
      handler,
      client,
      async () => makeResponse({ success: true, data: { 성공: 1, 실패: 0 } })
    );

    assert.equal(fetchCalls.length, 1);
    assert.equal(draftStore.get("schext-1").scheduleMutationStatus, "applied");
    assert.ok(client.calls.some(call => call.text?.includes("일정 반영 완료")));
  });

  test("TOTUS success=false면 ready로 복구하고 재시도 버튼을 남긴다", async () => {
    const { draftStore, handler } = createHarness();
    const client = makeClient();
    await invokeWithFetch(
      handler,
      client,
      async () => makeResponse({ success: false, error: { message: "rejected" } })
    );

    assert.equal(draftStore.get("schext-1").scheduleMutationStatus, "ready");
    const failure = client.calls.find(call => call.text?.includes("일정 반영 실패"));
    assert.ok(failure);
    assert.equal(failure.blocks[1].elements[0].action_id, "schext_apply_all");
  });

  test("success=true여도 실패 건수가 있으면 완료로 표시하지 않는다", async () => {
    const { draftStore, handler } = createHarness();
    const client = makeClient();
    await invokeWithFetch(
      handler,
      client,
      async () => makeResponse({
        success: true,
        data: { 실패: 1, failedTaskUuids: ["task-1"] },
      })
    );

    assert.equal(draftStore.get("schext-1").scheduleMutationStatus, "ready");
    assert.equal(client.calls.some(call => call.text?.includes("반영 완료")), false);
  });

  test("한 회차 태스크가 누락되면 부분 payload를 보내지 않는다", async () => {
    const { draftStore, handler } = createHarness({
      episodes: [1, 2],
      episodeLabel: "1-2화",
      tasksByEpisode: {
        1: [{ taskUuid: "task-1", opCode: "OTC0012" }],
        2: [],
      },
    });
    const client = makeClient();
    const fetchCalls = await invokeWithFetch(
      handler,
      client,
      async () => makeResponse({ success: true, data: { 실패: 0 } })
    );

    assert.equal(fetchCalls.length, 0);
    assert.equal(draftStore.get("schext-1").scheduleMutationStatus, "ready");
    assert.ok(client.calls.some(call => call.text?.includes("2화/OTC0012")));
  });

  test("한 opCode가 누락되면 다른 오퍼레이션도 반영하지 않는다", async () => {
    const tasks = [
      { taskUuid: "task-translation", opCode: "OTC0012" },
      { taskUuid: "task-proof", opCode: "OTC0013" },
    ];
    const simTasks = [
      {
        opCode: "OTC0012", opName: "번역",
        startDateOrig: "2026-07-01T00:00:00+09:00",
        endDateOrig: "2026-07-02T23:59:59+09:00",
        newStartDateOrig: "2026-07-03T00:00:00+09:00",
        newEndDateOrig: "2026-07-04T23:59:59+09:00",
      },
      {
        opCode: "OTC0013", opName: "번역검수",
        startDateOrig: "2026-07-03T00:00:00+09:00",
        endDateOrig: "2026-07-04T23:59:59+09:00",
        newStartDateOrig: "2026-07-05T00:00:00+09:00",
        newEndDateOrig: "2026-07-06T23:59:59+09:00",
      },
    ];
    const { draftStore, handler } = createHarness({
      tasks,
      simTasks,
      tasksByEpisode: { 1: [tasks[0]] },
    });
    const client = makeClient();
    const fetchCalls = await invokeWithFetch(
      handler,
      client,
      async () => makeResponse({ success: true, data: { 실패: 0 } })
    );

    assert.equal(fetchCalls.length, 0);
    assert.equal(draftStore.get("schext-1").scheduleMutationStatus, "ready");
    assert.ok(client.calls.some(call => call.text?.includes("1화/OTC0013")));
  });

  test("같은 회차와 opCode 태스크가 복수면 임의 선택 없이 반영 POST를 중단한다", async () => {
    const { draftStore, handler } = createHarness({
      tasksByEpisode: {
        1: [
          { taskUuid: "task-a", opCode: "OTC0012" },
          { taskUuid: "task-b", opCode: "OTC0012" },
        ],
      },
    });
    const client = makeClient();
    const fetchCalls = await invokeWithFetch(handler, client, async () => {
      throw new Error("mutation must not start");
    });

    assert.equal(fetchCalls.length, 0);
    assert.equal(draftStore.get("schext-1").scheduleMutationStatus, "ready");
    assert.ok(client.calls.some(call => call.text?.includes("후보가 여러 개")));
  });

  test("applying 상태의 중복 클릭은 외부 API를 호출하지 않는다", async () => {
    const { handler } = createHarness({ scheduleMutationStatus: "applying" });
    const client = makeClient();
    const fetchCalls = await invokeWithFetch(
      handler,
      client,
      async () => { throw new Error("must not call"); }
    );

    assert.equal(fetchCalls.length, 0);
    assert.ok(client.calls[0].text.includes("이미 일정 반영을 처리 중"));
  });

  test("applied 상태의 재클릭은 외부 API를 호출하지 않는다", async () => {
    const { handler } = createHarness({ scheduleMutationStatus: "applied" });
    const client = makeClient();
    const fetchCalls = await invokeWithFetch(
      handler,
      client,
      async () => { throw new Error("must not call"); }
    );

    assert.equal(fetchCalls.length, 0);
    assert.ok(client.calls[0].text.includes("이미 반영"));
  });

  test("외부 변경 뒤 Slack 완료 알림이 실패해도 applied 상태를 유지한다", async () => {
    const { draftStore, handler } = createHarness();
    const client = makeClient({ failCompletionNotice: true });
    const fetchCalls = await invokeWithFetch(
      handler,
      client,
      async () => makeResponse({ success: true, data: { 실패: 0 } })
    );

    assert.equal(fetchCalls.length, 1);
    assert.equal(draftStore.get("schext-1").scheduleMutationStatus, "applied");
    assert.ok(client.calls.some(call => call.text?.includes("안내 중 오류")));
  });
});
