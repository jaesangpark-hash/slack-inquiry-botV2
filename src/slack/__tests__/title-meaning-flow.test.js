"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const registerMultipleInquiryFlow = require("../../multipleInquiryFlow");
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

function makeJsonResponse(json) {
  return {
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => json,
    text: async () => JSON.stringify(json),
  };
}

async function withTotusProject(project, run) {
  const originalFetch = global.fetch;
  global.fetch = async () => makeJsonResponse({ success: true, data: [project] });
  try {
    return await run();
  } finally {
    global.fetch = originalFetch;
  }
}

function chineseOnlyMatch() {
  return {
    koreanProjectName: null,
    chineseOriginalTitle: "中文原名",
    pivoId: "PIVO-1",
  };
}

describe("flow title meaning", () => {
  test("multiple retake는 중국어 표시명을 한국어 필드로 전달하지 않는다", async () => {
    const app = makeApp();
    const draftStore = new Map([["multi-1", {
      items: [{ type: "리테이크", episode: "7", work_title_ko: null, work_title_ja: null }],
      missingByIndex: { 0: ["work_title"] },
      originalChannelId: "C_SOURCE",
      originalTs: "1.0",
      sourceLink: "https://example.test/source",
      requesterName: "requester",
      requesterUserId: "U_REQUESTER",
      ownerUserId: "U_OWNER",
    }]]);
    let receivedAnalysis = null;

    registerMultipleInquiryFlow(app, {
      ai: { models: { generateContent: async () => ({ text: "{}" }) } },
      GEMINI_MODEL: "fake",
      matchWorkTitleFromSheet: async () => chineseOnlyMatch(),
      matchWorkTitleByTokens: async () => null,
      generateDraftId: () => "generated",
      draftStore,
      fetchDeliveryDate: async () => null,
      handleFileOrderInquiry: async () => {},
      handleRetakeInquiry: async (_client, _channel, analysis) => { receivedAnalysis = analysis; },
      handleScheduleExt: async () => {},
      handleScheduleExtGrouped: async () => {},
    });

    await withTotusProject({
      uuid: "project-1",
      name: "Totus 中文名",
      _detail: { 진행상태: "ACTIVE", pivoId: "PIVO-1" },
    }, async () => {
      await app.views.get("submit_multi_fill_missing")({
        ack: async () => {},
        body: { user: { id: "U_OWNER" } },
        view: {
          private_metadata: JSON.stringify({ multiPendingId: "multi-1", itemIndex: 0 }),
          state: { values: {
            mi_pivoid_block: { value: { value: "PIVO-1" } },
          } },
        },
        client: { chat: { postMessage: async () => ({ ts: "1.0" }) } },
      });
    });

    assert.deepEqual(receivedAnalysis, {
      title_ja: "中文原名",
      title_ko: null,
      episode: "7",
    });
  });

  test("retake pivo 모달은 표시명은 보존하고 한국어명은 null로 유지한다", async () => {
    const app = makeApp();
    const draftStore = new Map([["pending-1", {
      type: "retake_pending",
      ownerUserId: "U_OWNER",
      dmChannelId: "D_OWNER",
      sourceLink: "https://example.test/source",
    }]]);

    registerRetakeFlow(app, {
      ai: { models: { generateContent: async () => ({ text: "{}" }) } },
      GEMINI_MODEL: "fake",
      matchWorkTitleFromSheet: async () => chineseOnlyMatch(),
      matchWorkTitleByTokens: async () => null,
      matchWorkTitleWithCandidates: async () => null,
      generateDraftId: () => "retake-generated",
      draftStore,
      sheetsClient: { getValues: async () => [] },
      fetchDeliveryDate: async () => null,
      resolveApmUserId: () => null,
    });

    await withTotusProject({
      uuid: "project-1",
      name: "Totus 中文名",
      _detail: { 진행상태: "ACTIVE", pivoId: "PIVO-1" },
    }, async () => {
      await app.views.get("submit_retake_info_modal")({
        ack: async () => {},
        body: { user: { id: "U_OWNER" } },
        view: {
          private_metadata: JSON.stringify({ pendingId: "pending-1" }),
          state: { values: {
            rt_work_block: { value: { value: "" } },
            rt_pivoid_block: { value: { value: "PIVO-1" } },
            rt_episode_block: { value: { value: "7" } },
          } },
        },
        client: { chat: { postMessage: async () => ({ ts: "1.0" }) } },
      });
    });

    const saved = draftStore.get("retake-generated");
    assert.equal(saved.workName, "中文原名");
    assert.equal(saved.workNameKo, null);
    assert.equal(saved.pivoId, "PIVO-1");
  });
});
