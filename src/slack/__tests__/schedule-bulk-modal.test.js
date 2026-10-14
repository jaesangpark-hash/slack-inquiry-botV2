"use strict";

// Modal B(오퍼레이션 일수) 생성 경로 — schbulk_step1 제출부터 모달이 그려질 때까지.
// 여기서 보는 건 "TOTUS 조회 결과를 사용자에게 어떻게 설명하는가"다. 조회 실패를 「태스크 없음」으로
// 적거나, 고를 게 없는데 submit 을 남겨두면 사용자가 잘못된 판단을 하게 된다.

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

function projectResponse() {
  return makeResponse({
    success: true,
    data: [{ uuid: "project-1", _detail: { pivoTitle: "테스트 작품" } }],
  });
}

function jobResponse(tasks) {
  return makeResponse({ success: true, data: [{ 오퍼레이션: [{ 태스크: tasks }] }] });
}

function task({ uuid = "task-1", opCode = "OTC0012", opName = "번역", assigned = true } = {}) {
  return {
    uuid,
    오퍼레이션유형: opCode,
    오퍼레이션유형명: opName,
    상태: "IN_PROGRESS",
    작업자: assigned ? { 이메일: "worker@example.com" } : null,
  };
}

function makeClient() {
  const updates = [];
  const posts = [];
  return {
    updates,
    posts,
    views: {
      open: async () => ({ view: { id: "V_LOADING" } }),
      update: async payload => { updates.push(payload); return {}; },
    },
    chat: { postMessage: async payload => { posts.push(payload); return { ts: "1.0" }; } },
  };
}

function stepOneArgs(client, { execMode = "schedule" } = {}) {
  return {
    ack: async () => {},
    body: { user: { id: "U_OWNER" }, trigger_id: "T1" },
    view: {
      private_metadata: JSON.stringify({
        draftId: "bulk-1", dmChannelId: "D1", mode: "multi", execMode,
      }),
      state: {
        values: {
          work_name:   { value: { value: "테스트 작품" } },
          ep_start:    { value: { value: "1" } },
          ep_end:      { value: { value: "2" } },
          first_start: { value: { selected_date: "2026-07-20" } },
        },
      },
    },
    client,
  };
}

async function runStepOne(fetchImplementation, options = {}) {
  const app = makeApp();
  const draftStore = new Map([["bulk-1", { draftId: "bulk-1", ownerUserId: "U_OWNER", dmChannelId: "D1" }]]);
  registerScheduleBulkFlow(app, { draftStore, generateDraftId: () => "generated" });
  const client = makeClient();
  const originalFetch = global.fetch;
  global.fetch = fetchImplementation;
  try {
    await app.views.get("schbulk_step1")(stepOneArgs(client, options));
  } finally {
    global.fetch = originalFetch;
  }
  return { client, draftStore, modalB: client.updates.at(-1)?.view || null };
}

function blockText(view) {
  return JSON.stringify(view?.blocks || []);
}

describe("scheduleBulkFlow Modal B", () => {
  // ★TOTUS 가 success:false 를 돌려주는 건 권한·로그인 등 오류지 "태스크가 없음"이 아니다.
  //   연결이 끊긴 경우만 고쳐두면 이 경로가 그대로 「n개 회차엔 이 태스크가 없어 건너뜀」으로 샌다.
  test("오퍼레이션 조회가 success:false면 조회 실패로 알리고 집계에서 뺀다", async () => {
    const { modalB } = await runStepOne(async url => {
      if (url.includes("/api/v1/projects?")) return projectResponse();
      if (url.includes("/jobs?episode=1")) {
        return makeResponse({ success: false, error: { message: "권한이 없습니다" } });
      }
      if (url.includes("/jobs?episode=2")) return jobResponse([task()]);
      throw new Error(`unexpected URL: ${url}`);
    });

    assert.ok(modalB, "Modal B 가 그려져야 한다");
    const text = blockText(modalB);
    assert.ok(text.includes("조회 자체가 실패"), text);
    assert.ok(text.includes("권한이 없습니다"), text);
    assert.ok(text.includes("1화"), "실패한 회차 번호를 적어야 한다");
    // 실패 회차는 분모에서 빠지므로, 남은 1회차 기준으로 "부분 보유" 표기가 나오면 안 된다
    assert.ok(!text.includes("회차엔 이 태스크가 없어 건너뜀"), text);
  });

  // ★고를 게 하나도 없는데 submit 을 남겨두면, 눌러서 전부 0일인 빈 일정이 계산되고
  //   그 다음 단계에 가서야 막힌다. 막을 거면 모달에서 막는다.
  test("고를 수 있는 오퍼레이션이 없으면 submit 버튼을 빼고 사유만 보여준다", async () => {
    const { modalB } = await runStepOne(async url => {
      if (url.includes("/api/v1/projects?")) return projectResponse();
      if (url.includes("/jobs?episode=")) return jobResponse([task({ assigned: false })]);
      throw new Error(`unexpected URL: ${url}`);
    }, { execMode: "retake" });

    assert.ok(modalB, "Modal B 가 그려져야 한다");
    assert.equal(modalB.submit, undefined, "진행할 수 없으면 submit 이 없어야 한다");
    const text = blockText(modalB);
    assert.ok(text.includes("작업자 미배정이라 선택 불가"), text);
    assert.ok(text.includes("진행할 수 없어"), text);
  });

  test("작업자가 붙어 있으면 평소대로 submit 과 입력란이 나온다", async () => {
    const { modalB } = await runStepOne(async url => {
      if (url.includes("/api/v1/projects?")) return projectResponse();
      if (url.includes("/jobs?episode=")) return jobResponse([task()]);
      throw new Error(`unexpected URL: ${url}`);
    }, { execMode: "retake" });

    assert.ok(modalB?.submit, "진행 가능하면 submit 이 있어야 한다");
    assert.ok(blockText(modalB).includes("op_OTC0012"), blockText(modalB));
  });
});
