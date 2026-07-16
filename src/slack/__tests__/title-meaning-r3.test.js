"use strict";

const { afterEach, describe, test } = require("node:test");
const assert = require("node:assert/strict");

const registerScheduleActions = require("../../handlers/schedule-actions");
const registerDirectInputActions = require("../../handlers/direct-input-actions");
const registerFileOrderFlow = require("../../fileOrderFlow");

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeApp() {
  const actions = new Map();
  const views = new Map();
  return {
    action(id, handler) { actions.set(id instanceof RegExp ? id.source : String(id), handler); },
    view(id, handler) { views.set(String(id), handler); },
    actions,
    views,
  };
}

function makeClient() {
  return {
    chat: { postMessage: async () => ({ ts: "1.0" }), update: async () => ({}) },
    views: { open: async () => ({}) },
    conversations: { history: async () => ({ messages: [] }) },
  };
}

function jsonResponse(payload) {
  return {
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

describe("remaining title meaning paths", () => {
  test("schedule 원문 직접 입력 매칭 실패는 표시/원문만 채우고 한국어명은 null로 전달한다", async () => {
    const app = makeApp();
    const draftStore = new Map([["pending-1", {
      ownerUserId: "U_OWNER",
      parsed: { episode: "5", work_title_ja: "未知タイトル", work_title_ko: null },
      sourceLink: "https://example.test/source",
    }]]);
    let forwarded = null;
    let deliveryArgs = null;
    registerScheduleActions(app, {
      draftStore,
      loadTitleRowsFromSheet: async () => [],
      matchWorkTitleFromSheet: async () => null,
      fetchDeliveryDate: async (...args) => { deliveryArgs = args; return null; },
      handleScheduleExt: async (_client, _channel, parsed) => { forwarded = parsed; },
      PM_SLACK_ID: "U_PM",
      SCHEDULE_CHANNEL_ID: "C_SCHEDULE",
    });

    await app.views.get("schedule_title_modal")({
      ack: async () => {},
      body: { user: { id: "U_OWNER" } },
      view: {
        private_metadata: JSON.stringify({ pendingId: "pending-1" }),
        state: { values: { title_ja_block: { title_ja_input: { value: "未知タイトル" } } } },
      },
      client: makeClient(),
    });

    assert.equal(forwarded.displayWorkName, "未知タイトル");
    assert.equal(forwarded.originalWorkTitle, "未知タイトル");
    assert.equal(forwarded.koreanProjectName, null);
    assert.equal(forwarded.work_title_ja, "未知タイトル");
    assert.equal(forwarded.work_title_ko, null);
    assert.equal(deliveryArgs[3], null);
  });

  test("direct 문의의 언어 미확인 입력은 koreanProjectName/workNameKo와 sourceLang을 추정하지 않는다", async () => {
    const app = makeApp();
    const draftStore = new Map();
    registerDirectInputActions(app, {
      draftStore,
      buildDraftPreviewBlocks: () => [],
      buildDraftPreviewText: () => "preview",
      buildFileInquiryBlocks: () => [],
      matchWorkTitleFromSheet: async () => null,
      fetchDeliveryDate: async () => null,
      handleFileOrderInquiry: async () => {},
      handleScheduleExt: async () => {},
      generateDraftId: () => "direct-inquiry-1",
      resolveApmUserId: () => null,
      postInquiryToTargetChannel: async () => ({}),
      TARGET_CHANNEL_ID: "C_PM",
      handleWorkerRelay: async () => {},
      checkInquiryDone: async () => {},
    });

    await app.views.get("direct_inquiry_modal")({
      ack: async () => {},
      body: { user: { id: "U_OWNER" } },
      view: {
        private_metadata: "{}",
        state: { values: {
          di_work_block: { value: { value: "未知タイトル" } },
          di_episode_block: { value: { value: "5" } },
          di_type_block: { value: { selected_option: { value: "기타" } } },
          di_content_block: { value: { value: "문의" } },
          di_summary_block: { value: { value: "요약" } },
          di_action_block: { value: { value: "확인" } },
          di_link_block: { value: { value: "" } },
        } },
      },
      client: makeClient(),
    });

    const draft = draftStore.get("direct-inquiry-1");
    assert.equal(draft.displayWorkName, "未知タイトル");
    assert.equal(draft.originalWorkTitle, "未知タイトル");
    assert.equal(draft.koreanProjectName, null);
    assert.equal(draft.workNameKo, null);
    assert.equal(draft.sourceLang, "unknown");
  });

  test("direct schedule 원문 입력도 미확인 값을 work_title_ko로 복사하지 않는다", async () => {
    const app = makeApp();
    const draftStore = new Map();
    let forwarded = null;
    registerDirectInputActions(app, {
      draftStore,
      buildDraftPreviewBlocks: () => [],
      buildDraftPreviewText: () => "preview",
      buildFileInquiryBlocks: () => [],
      matchWorkTitleFromSheet: async () => null,
      fetchDeliveryDate: async () => null,
      handleFileOrderInquiry: async () => {},
      handleScheduleExt: async (_client, _channel, parsed) => { forwarded = parsed; },
      generateDraftId: () => "direct-schedule",
      resolveApmUserId: () => null,
      postInquiryToTargetChannel: async () => ({}),
      TARGET_CHANNEL_ID: "C_PM",
      handleWorkerRelay: async () => {},
      checkInquiryDone: async () => {},
    });

    await app.views.get("direct_schedule_modal")({
      ack: async () => {},
      body: { user: { id: "U_OWNER" } },
      view: {
        private_metadata: JSON.stringify({ ownerUserId: "U_OWNER" }),
        state: { values: {
          ds_work_block: { value: { value: "未知タイトル" } },
          ds_episode_block: { value: { value: "5" } },
          ds_extdays_block: { value: { value: "3" } },
        } },
      },
      client: makeClient(),
    });

    assert.equal(forwarded.displayWorkName, "未知タイトル");
    assert.equal(forwarded.originalWorkTitle, "未知タイトル");
    assert.equal(forwarded.koreanProjectName, null);
    assert.equal(forwarded.work_title_ja, "未知タイトル");
    assert.equal(forwarded.work_title_ko, null);
  });

  test("direct 파일순서 입력은 미확인 원문을 title_ko로 재포장하지 않는다", async () => {
    const app = makeApp();
    const draftStore = new Map();
    let receivedAnalysis = null;
    registerDirectInputActions(app, {
      draftStore,
      buildDraftPreviewBlocks: () => [],
      buildDraftPreviewText: () => "preview",
      buildFileInquiryBlocks: () => [],
      matchWorkTitleFromSheet: async () => null,
      fetchDeliveryDate: async () => null,
      handleFileOrderInquiry: async (_client, _channel, analysis) => { receivedAnalysis = analysis; },
      handleScheduleExt: async () => {},
      generateDraftId: () => "direct-file-order",
      resolveApmUserId: () => null,
      postInquiryToTargetChannel: async () => ({}),
      TARGET_CHANNEL_ID: "C_PM",
      handleWorkerRelay: async () => {},
      checkInquiryDone: async () => {},
    });

    await app.views.get("direct_fileorder_modal")({
      ack: async () => {},
      body: { user: { id: "U_OWNER" } },
      view: {
        private_metadata: JSON.stringify({ dmChannelId: "D_OWNER", ownerUserId: "U_OWNER" }),
        state: { values: {
          dfo_work_block: { value: { value: "未知タイトル" } },
          dfo_episode_block: { value: { value: "5" } },
        } },
      },
      client: makeClient(),
    });

    assert.equal(receivedAnalysis.displayWorkName, "未知タイトル");
    assert.equal(receivedAnalysis.originalWorkTitle, "未知タイトル");
    assert.equal(receivedAnalysis.koreanProjectName, null);
    assert.equal(receivedAnalysis.title_ja, "未知タイトル");
    assert.equal(receivedAnalysis.title_ko, null);
  });

  test("file-order 수동 원문 매칭 실패는 저장 draft의 한국어 필드를 null로 유지한다", async () => {
    const app = makeApp();
    const draftStore = new Map([["pending-fo", {
      type: "file_order_pending",
      ownerUserId: "U_OWNER",
      dmChannelId: "D_OWNER",
      workName: "",
      workNameKo: "",
      episode: "",
      sourceLink: "",
    }]]);
    global.fetch = async url => {
      if (url.includes("/projects?")) {
        return jsonResponse({ success: true, data: [{
          uuid: "P1",
          name: "未知タイトル",
          _detail: { 진행상태: "ACTIVE", pivoId: "PV1" },
        }] });
      }
      if (url.includes("/source-groups?")) {
        return jsonResponse({ success: true, data: [{
          id: "SG1",
          이름: "5화",
          파일목록: [{ id: "S1", 파일이름: "001.psd", 순서: 0 }],
        }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    registerFileOrderFlow(app, {
      ai: { models: { generateContent: async () => ({ text: "{}" }) } },
      GEMINI_MODEL: "fake",
      matchWorkTitleFromSheet: async () => null,
      matchWorkTitleWithCandidates: async () => null,
      generateDraftId: () => "fo-generated",
      draftStore,
    });

    await app.views.get("submit_file_order_info_modal")({
      ack: async () => {},
      body: { user: { id: "U_OWNER" } },
      view: {
        private_metadata: JSON.stringify({ pendingId: "pending-fo" }),
        state: { values: {
          fo_work_block: { value: { value: "未知タイトル" } },
          fo_episode_block: { value: { value: "5" } },
        } },
      },
      client: makeClient(),
    });

    const draft = draftStore.get("fo-generated");
    assert.equal(draft.displayWorkName, "未知タイトル");
    assert.equal(draft.originalWorkTitle, "未知タイトル");
    assert.equal(draft.koreanProjectName, null);
    assert.equal(draft.workNameKo, null);
  });
});
