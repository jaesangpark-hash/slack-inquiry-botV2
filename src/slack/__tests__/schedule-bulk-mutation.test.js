"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const registerScheduleBulkFlow = require("../scheduleBulkFlow");

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

function jobResponse({ taskUuid = "task-1", taskUuids = null, includeTask = true, tasks = null } = {}) {
  const uuids = taskUuids || [taskUuid];
  const taskEntries = tasks || (includeTask ? uuids.map(uuid => ({
    uuid,
    오퍼레이션유형: "OTC0012",
    오퍼레이션유형명: "번역",
    상태: "IN_PROGRESS",
    작업자: { 이메일: "worker@example.com" },
  })) : []);
  return makeResponse({
    success: true,
    data: [{ 오퍼레이션: [{ 태스크: taskEntries }] }],
  });
}

function makeDraft(overrides = {}) {
  return {
    draftId: "bulk-1",
    ownerUserId: "U_OWNER",
    dmChannelId: "D1",
    workName: "테스트 작품",
    projectUuid: "project-1",
    execMode: "schedule",
    calculatedSchedule: [{
      groupLabel: "1화",
      episodes: [1],
      startDate: "2026-07-20",
      endDate: "2026-07-21",
      opSchedule: [{
        opCode: "OTC0012",
        opName: "번역",
        startDate: "2026-07-20",
        endDate: "2026-07-21",
      }],
    }],
    ...overrides,
  };
}

function makeClient({ failCompletionNotice = false, failProgressNotice = false } = {}) {
  const calls = [];
  return {
    calls,
    chat: {
      postMessage: async payload => {
        calls.push(payload);
        if (failProgressNotice && payload.text?.startsWith("⏳")) {
          throw new Error("Slack progress notice failed");
        }
        if (failCompletionNotice && payload.text?.includes("일정 반영 완료")) {
          throw new Error("Slack notice failed");
        }
        return { ts: "1.0" };
      },
    },
    views: { open: async () => ({}), update: async () => ({}) },
  };
}

function createHarness(draftOverrides = {}) {
  const app = makeApp();
  const draftStore = new Map([["bulk-1", makeDraft(draftOverrides)]]);
  registerScheduleBulkFlow(app, {
    draftStore,
    generateDraftId: () => "generated",
  });
  return {
    draftStore,
    handler: app.actions.get("schbulk_apply"),
    adjustHandler: app.views.get("schbulk_adjust"),
  };
}

function actionArgs(client) {
  return {
    ack: async () => {},
    body: { user: { id: "U_OWNER" }, actions: [{ value: "bulk-1" }] },
    client,
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
    for (let i = 0; i < count; i++) {
      await handler(actionArgs(client));
    }
  } finally {
    global.fetch = originalFetch;
  }
  return calls;
}

async function invokeAdjustWithFetch(handler, client, fetchImplementation) {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (...args) => {
    calls.push(args);
    return fetchImplementation(...args);
  };
  try {
    await handler({
      ack: async () => {},
      body: { user: { id: "U_OWNER" } },
      view: {
        private_metadata: JSON.stringify({ draftId: "bulk-1" }),
        state: { values: {} },
      },
      client,
    });
  } finally {
    global.fetch = originalFetch;
  }
  return calls;
}

describe("scheduleBulkFlow mutation truth", () => {
  test("일정 전체 성공일 때 완료를 알리고 draft를 삭제한다", async () => {
    const { draftStore, handler } = createHarness();
    const client = makeClient();
    const fetchCalls = await invokeWithFetch(handler, client, async url => {
      if (url.includes("/jobs?episode=")) return jobResponse();
      return makeResponse({ success: true, data: { 실패: 0 } });
    });

    assert.equal(fetchCalls.length, 2);
    assert.equal(draftStore.has("bulk-1"), false);
    assert.ok(client.calls.some(call => call.text?.includes("일정 반영 완료")));
  });

  test("일정 API success=false면 draft를 ready 상태로 보존한다", async () => {
    const { draftStore, handler } = createHarness();
    const client = makeClient();
    await invokeWithFetch(handler, client, async url => {
      if (url.includes("/jobs?episode=")) return jobResponse();
      return makeResponse({ success: false, error: { message: "date rejected" } });
    });

    assert.equal(draftStore.get("bulk-1").bulkMutationStatus, "ready");
    assert.ok(client.calls.some(call => call.text?.includes("date rejected")));
  });

  test("success=true여도 실패 건수가 있으면 완료로 표시하지 않는다", async () => {
    const { draftStore, handler } = createHarness();
    const client = makeClient();
    await invokeWithFetch(handler, client, async url => {
      if (url.includes("/jobs?episode=")) return jobResponse();
      return makeResponse({ success: true, data: { 실패: 1, 실패UUID목록: ["task-1"] } });
    });

    assert.equal(draftStore.get("bulk-1").bulkMutationStatus, "ready");
    assert.equal(client.calls.some(call => call.text?.includes("반영 완료")), false);
  });

  test("한 회차 조회가 누락되면 일부 일정도 반영하지 않는다", async () => {
    const calculatedSchedule = [{
      groupLabel: "1-2화",
      episodes: [1, 2],
      startDate: "2026-07-20",
      endDate: "2026-07-21",
      opSchedule: [{ opCode: "OTC0012", opName: "번역", startDate: "2026-07-20", endDate: "2026-07-21" }],
    }];
    const { draftStore, handler } = createHarness({ calculatedSchedule });
    const client = makeClient();
    const fetchCalls = await invokeWithFetch(handler, client, async url => {
      if (url.includes("episode=1")) return jobResponse({ taskUuid: "task-1" });
      if (url.includes("episode=2")) return jobResponse({ includeTask: false });
      return makeResponse({ success: true, data: { 실패: 0 } });
    });

    assert.equal(fetchCalls.filter(([url]) => url.endsWith("/tasks/dates")).length, 0);
    assert.equal(draftStore.get("bulk-1").bulkMutationStatus, "ready");
    assert.ok(client.calls.some(call => call.text?.includes("2화/OTC0012")));
  });

  test("한 opCode가 누락되면 조회된 다른 오퍼레이션도 반영하지 않는다", async () => {
    const calculatedSchedule = [{
      groupLabel: "1화",
      episodes: [1],
      startDate: "2026-07-20",
      endDate: "2026-07-22",
      opSchedule: [
        { opCode: "OTC0012", opName: "번역", startDate: "2026-07-20", endDate: "2026-07-21" },
        { opCode: "OTC0013", opName: "번역검수", startDate: "2026-07-22", endDate: "2026-07-22" },
      ],
    }];
    const { draftStore, handler } = createHarness({ calculatedSchedule });
    const client = makeClient();
    const fetchCalls = await invokeWithFetch(handler, client, async url => {
      if (url.includes("/jobs?episode=")) return jobResponse();
      return makeResponse({ success: true, data: { 실패: 0 } });
    });

    assert.equal(fetchCalls.filter(([url]) => url.endsWith("/tasks/dates")).length, 0);
    assert.equal(draftStore.get("bulk-1").bulkMutationStatus, "ready");
    assert.ok(client.calls.some(call => call.text?.includes("1화/OTC0013")));
  });

  test("applying 상태의 중복 클릭은 외부 API를 호출하지 않는다", async () => {
    const { handler } = createHarness({ bulkMutationStatus: "applying" });
    const client = makeClient();
    const fetchCalls = await invokeWithFetch(
      handler,
      client,
      async () => { throw new Error("must not call"); }
    );

    assert.equal(fetchCalls.length, 0);
    assert.ok(client.calls[0].text.includes("이미 처리 중"));
  });

  test("외부 변경 뒤 Slack 완료 알림 실패는 재처리 상태로 되돌리지 않는다", async () => {
    const { draftStore, handler } = createHarness();
    const client = makeClient({ failCompletionNotice: true });
    const fetchCalls = await invokeWithFetch(handler, client, async url => {
      if (url.includes("/jobs?episode=")) return jobResponse();
      return makeResponse({ success: true, data: { 실패: 0 } });
    });

    assert.equal(fetchCalls.length, 2);
    assert.equal(draftStore.has("bulk-1"), false);
  });

  test("기본 적용의 진행 알림 실패는 외부 호출 없이 ready로 복구한다", async () => {
    const { draftStore, handler } = createHarness();
    const client = makeClient({ failProgressNotice: true });
    let fetchCalls;
    await assert.doesNotReject(async () => {
      fetchCalls = await invokeWithFetch(handler, client, async () => {
        throw new Error("must not call");
      });
    });

    assert.equal(fetchCalls.length, 0);
    assert.equal(draftStore.get("bulk-1").bulkMutationStatus, "ready");
  });

  test("세부 조정의 진행 알림 실패도 외부 호출 없이 ready로 복구한다", async () => {
    const { draftStore, adjustHandler } = createHarness();
    const client = makeClient({ failProgressNotice: true });
    let fetchCalls;
    await assert.doesNotReject(async () => {
      fetchCalls = await invokeAdjustWithFetch(adjustHandler, client, async () => {
        throw new Error("must not call");
      });
    });

    assert.equal(fetchCalls.length, 0);
    assert.equal(draftStore.get("bulk-1").bulkMutationStatus, "ready");
  });

  test("일괄 리테이크 source가 한 회차라도 없으면 생성 POST를 시작하지 않는다", async () => {
    const calculatedSchedule = [{
      groupLabel: "1-2화",
      episodes: [1, 2],
      startDate: "2026-07-20",
      endDate: "2026-07-21",
      opSchedule: [{ opCode: "OTC0012", opName: "번역", startDate: "2026-07-20", endDate: "2026-07-21" }],
    }];
    const { draftStore, handler } = createHarness({ execMode: "retake", calculatedSchedule });
    const client = makeClient();
    const fetchCalls = await invokeWithFetch(handler, client, async url => {
      if (url.includes("episode=1")) return jobResponse({ taskUuid: "source-1" });
      if (url.includes("episode=2")) return jobResponse({ includeTask: false });
      throw new Error(`mutation must not start: ${url}`);
    });

    assert.equal(fetchCalls.filter(([url]) => url.endsWith("/retake")).length, 0);
    assert.equal(draftStore.get("bulk-1").bulkMutationStatus, "ready");
    assert.ok(client.calls.some(call => call.text?.includes("2화/OTC0012")));
  });

  test("일괄 리테이크 source 번역 태스크가 복수면 임의 선택 없이 생성 POST를 중단한다", async () => {
    const { draftStore, handler } = createHarness({ execMode: "retake" });
    const client = makeClient();
    const fetchCalls = await invokeWithFetch(handler, client, async url => {
      if (url.includes("/jobs?episode=")) {
        return jobResponse({
          tasks: [
            { uuid: "source-a", 오퍼레이션유형: "OTC0012", 상태: "COMPLETED", 작업자: { 이메일: "a@example.com" } },
            { uuid: "source-b", 오퍼레이션유형: "OTC0012", 상태: "COMPLETED", 작업자: { 이메일: "b@example.com" } },
          ],
        });
      }
      throw new Error(`mutation must not start: ${url}`);
    });

    assert.equal(fetchCalls.filter(([url]) => url.endsWith("/retake")).length, 0);
    assert.equal(draftStore.get("bulk-1").bulkMutationStatus, "ready");
    assert.ok(client.calls.some(call => call.text?.includes("후보가 여러 개")));
  });

  test("일괄 리테이크 명시적 success=false는 ready로 남아 안전하게 재시도한다", async () => {
    const { draftStore, handler } = createHarness({ execMode: "retake" });
    const client = makeClient();
    const fetchCalls = await invokeWithFetch(handler, client, async url => {
      if (url.includes("/jobs?episode=")) return jobResponse({ taskUuid: "source-1" });
      if (url.endsWith("/retake")) {
        return makeResponse({ success: false, error: { message: "retake rejected" } });
      }
      throw new Error(`unexpected URL: ${url}`);
    }, 2);

    assert.equal(fetchCalls.filter(([url]) => url.endsWith("/retake")).length, 2);
    assert.equal(draftStore.get("bulk-1").bulkMutationStatus, "ready");
  });

  test("서로 다른 회차가 같은 생성 UUID를 반환하면 review_required로 멈추고 날짜 POST를 보내지 않는다", async () => {
    const calculatedSchedule = [{
      groupLabel: "1-2화",
      episodes: [1, 2],
      startDate: "2026-07-20",
      endDate: "2026-07-21",
      opSchedule: [{ opCode: "OTC0012", opName: "번역", startDate: "2026-07-20", endDate: "2026-07-21" }],
    }];
    const { draftStore, handler } = createHarness({ execMode: "retake", calculatedSchedule });
    const client = makeClient();
    const fetchCalls = await invokeWithFetch(handler, client, async url => {
      if (url.includes("episode=1")) return jobResponse({ taskUuid: "source-1" });
      if (url.includes("episode=2")) return jobResponse({ taskUuid: "source-2" });
      if (url.endsWith("/retake")) {
        return makeResponse({ success: true, data: { createdTaskUuids: ["created-shared"] } });
      }
      throw new Error(`date mutation must not start: ${url}`);
    });

    assert.equal(fetchCalls.filter(([url]) => url.endsWith("/retake")).length, 2);
    assert.equal(fetchCalls.filter(([url]) => url.endsWith("/tasks/dates")).length, 0);
    assert.equal(draftStore.get("bulk-1").bulkMutationStatus, "review_required");
    assert.deepEqual(
      draftStore.get("bulk-1").retakeUnverifiedCreatedTaskUuidsByEpisode[2],
      ["created-shared"]
    );
    assert.ok(client.calls.some(call => call.text?.includes("Totus에서 생성 여부")));
  });

  test("회차별 리테이크 부분 실패 후 재시도는 성공 회차를 건너뛴다", async () => {
    const calculatedSchedule = [
      {
        groupLabel: "1-2화",
        episodes: [1, 2],
        startDate: "2026-07-20",
        endDate: "2026-07-21",
        opSchedule: [{ opCode: "OTC0012", opName: "번역", startDate: "2026-07-20", endDate: "2026-07-21" }],
      },
    ];
    const { draftStore, handler } = createHarness({ execMode: "retake", calculatedSchedule });
    const client = makeClient();
    let episode1Lookups = 0;
    let episode2Lookups = 0;
    const fetchCalls = await invokeWithFetch(handler, client, async (url, options = {}) => {
      if (url.includes("/jobs?episode=2")) {
        episode2Lookups++;
        if (episode2Lookups === 1) return jobResponse({ includeTask: false });
        return episode2Lookups === 2
          ? jobResponse({ taskUuid: "source-2" })
          : jobResponse({ taskUuids: ["source-2", "created-2"] });
      }
      if (url.includes("/jobs?episode=1")) {
        episode1Lookups++;
        return episode1Lookups <= 2
          ? jobResponse({ taskUuid: "source-1" })
          : jobResponse({ taskUuids: ["source-1", "created-1"] });
      }
      if (url.includes("source-1/retake")) {
        return makeResponse({ success: true, data: { createdTaskUuids: ["created-1"] } });
      }
      if (url.includes("source-2/retake")) {
        return makeResponse({ success: true, data: { createdTaskUuids: ["created-2"] } });
      }
      if (url.endsWith("/tasks/dates")) return makeResponse({ success: true, data: { 실패: 0 } });
      throw new Error(`unexpected URL: ${url} ${options.method || "GET"}`);
    }, 2);

    const retakeCalls = fetchCalls.filter(([url]) => url.endsWith("/retake"));
    assert.equal(retakeCalls.length, 2, "1화와 2화를 각각 한 번만 생성");
    assert.equal(retakeCalls.filter(([url]) => url.includes("source-1")).length, 1);
    const datePayload = JSON.parse(
      fetchCalls.find(([url]) => url.endsWith("/tasks/dates"))[1].body
    );
    assert.deepEqual(
      datePayload.map(task => task.uuid).sort(),
      ["created-1", "created-2"],
      "기존 source 태스크가 아니라 새로 생성된 태스크만 날짜 반영"
    );
    assert.equal(draftStore.has("bulk-1"), false);
  });

  test("리테이크 생성 뒤 날짜 실패 재시도는 태스크를 다시 만들지 않는다", async () => {
    const { draftStore, handler } = createHarness({ execMode: "retake" });
    const client = makeClient();
    let jobLookups = 0;
    let dateAttempts = 0;
    const fetchCalls = await invokeWithFetch(handler, client, async url => {
      if (url.includes("/jobs?episode=")) {
        jobLookups++;
        return jobLookups === 1
          ? jobResponse({ taskUuid: "source-1" })
          : jobResponse({ taskUuids: ["source-1", "created-1"] });
      }
      if (url.endsWith("/retake")) {
        return makeResponse({ success: true, data: { createdTaskUuids: ["created-1"] } });
      }
      if (url.endsWith("/tasks/dates")) {
        dateAttempts++;
        return dateAttempts === 1
          ? makeResponse({ success: false, error: { message: "temporary failure" } })
          : makeResponse({ success: true, data: { 실패: 0 } });
      }
      throw new Error(`unexpected URL: ${url}`);
    }, 2);

    assert.equal(fetchCalls.filter(([url]) => url.endsWith("/retake")).length, 1);
    assert.equal(fetchCalls.filter(([url]) => url.endsWith("/tasks/dates")).length, 2);
    const finalDatePayload = JSON.parse(
      fetchCalls.filter(([url]) => url.endsWith("/tasks/dates")).at(-1)[1].body
    );
    assert.deepEqual(finalDatePayload.map(task => task.uuid), ["created-1"]);
    assert.equal(draftStore.has("bulk-1"), false);
  });

  test("리테이크 날짜 응답만 불확실하면 생성 확인 상태로 잠그지 않고 날짜만 재시도한다", async () => {
    const { draftStore, handler } = createHarness({ execMode: "retake" });
    const client = makeClient();
    let jobLookups = 0;
    let dateAttempts = 0;
    const fetchCalls = await invokeWithFetch(handler, client, async url => {
      if (url.includes("/jobs?episode=")) {
        jobLookups++;
        return jobLookups === 1
          ? jobResponse({ taskUuid: "source-1" })
          : jobResponse({ taskUuids: ["source-1", "created-1"] });
      }
      if (url.endsWith("/retake")) {
        return makeResponse({ success: true, data: { createdTaskUuids: ["created-1"] } });
      }
      if (url.endsWith("/tasks/dates")) {
        dateAttempts++;
        return dateAttempts === 1
          ? makeResponse({ data: { 실패: 0 } })
          : makeResponse({ success: true, data: { 실패: 0 } });
      }
      throw new Error(`unexpected URL: ${url}`);
    }, 2);

    assert.equal(fetchCalls.filter(([url]) => url.endsWith("/retake")).length, 1);
    assert.equal(fetchCalls.filter(([url]) => url.endsWith("/tasks/dates")).length, 2);
    assert.equal(draftStore.has("bulk-1"), false);
  });

  test("새 리테이크 UUID가 jobs 조회에 없으면 생성 없이 날짜 반영만 재시도 가능하게 남긴다", async () => {
    const { draftStore, handler } = createHarness({ execMode: "retake" });
    const client = makeClient();
    let jobLookups = 0;
    const fetchCalls = await invokeWithFetch(handler, client, async url => {
      if (url.includes("/jobs?episode=")) {
        jobLookups++;
        return jobLookups === 1
          ? jobResponse({ taskUuid: "source-1" })
          : jobResponse({ taskUuid: "source-1" });
      }
      if (url.endsWith("/retake")) {
        return makeResponse({ success: true, data: { createdTaskUuids: ["created-1"] } });
      }
      if (url.endsWith("/tasks/dates")) {
        throw new Error("date mutation must not start");
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    assert.equal(fetchCalls.filter(([url]) => url.endsWith("/retake")).length, 1);
    assert.equal(fetchCalls.filter(([url]) => url.endsWith("/tasks/dates")).length, 0);
    assert.deepEqual(draftStore.get("bulk-1").retakeCreatedTaskUuidsByEpisode[1], ["created-1"]);
    assert.equal(draftStore.get("bulk-1").bulkMutationStatus, "ready");
    assert.ok(client.calls.some(call => call.text?.includes("created-1")));
  });

  test("일괄 리테이크 POST transport 예외 뒤 같은 draft는 자동 생성 재시도를 막는다", async () => {
    const { draftStore, handler } = createHarness({ execMode: "retake" });
    const client = makeClient();
    const fetchCalls = await invokeWithFetch(handler, client, async url => {
      if (url.includes("/jobs?episode=")) return jobResponse({ taskUuid: "source-1" });
      if (url.endsWith("/retake")) throw new Error("socket closed after commit");
      throw new Error(`unexpected URL: ${url}`);
    }, 2);

    assert.equal(fetchCalls.filter(([url]) => url.endsWith("/retake")).length, 1);
    assert.equal(draftStore.get("bulk-1").bulkMutationStatus, "review_required");
    assert.deepEqual(draftStore.get("bulk-1").retakeUnknownOutcomeEpisodes, [1]);
    assert.ok(client.calls.some(call => call.text?.includes("Totus에서 생성 여부")));
  });

  test("응답 유실 뒤 프로세스 재시작으로 draft가 사라지면 오래된 버튼은 POST하지 않는다", async () => {
    const { draftStore, handler } = createHarness({ execMode: "retake" });
    const client = makeClient();
    const firstCalls = await invokeWithFetch(handler, client, async url => {
      if (url.includes("/jobs?episode=")) return jobResponse({ taskUuid: "source-1" });
      if (url.endsWith("/retake")) throw new Error("socket closed after commit");
      throw new Error(`unexpected URL: ${url}`);
    });

    draftStore.clear();
    const afterRestartCalls = await invokeWithFetch(
      handler,
      client,
      async () => { throw new Error("must not call after restart"); }
    );

    assert.equal(firstCalls.filter(([url]) => url.endsWith("/retake")).length, 1);
    assert.equal(afterRestartCalls.length, 0);
  });

  test("일괄 리테이크 success=true지만 UUID가 없으면 운영자 확인 상태로 남긴다", async () => {
    const { draftStore, handler } = createHarness({ execMode: "retake" });
    const client = makeClient();
    const fetchCalls = await invokeWithFetch(handler, client, async url => {
      if (url.includes("/jobs?episode=")) return jobResponse({ taskUuid: "source-1" });
      if (url.endsWith("/retake")) {
        return makeResponse({ success: true, data: { createdTaskUuids: [] } });
      }
      throw new Error(`unexpected URL: ${url}`);
    }, 2);

    assert.equal(fetchCalls.filter(([url]) => url.endsWith("/retake")).length, 1);
    assert.equal(draftStore.get("bulk-1").bulkMutationStatus, "review_required");
  });
});
