"use strict";
/**
 * handlers/direct-input-actions.js — 한일(ko-ja) 배선 테스트
 *
 * node:test + node:assert 빌트인 사용 (신규 dep 추가 금지).
 * direct-input-actions.test.js 의 fake app/deps 패턴을 따른다.
 *
 * 검증 항목 (AIA 리뷰 T1 — 초안 수정 경로):
 *   - 초안 수정 모달에는 마스터 행이 없다. 작품을 확정할 때 draft 에 넣어 둔 lang 을 쓴다.
 *   - 한일 초안 → fetchDeliveryDate 3번째 인자 "ko-ja"
 *   - 중일 초안 → "zh-ja"
 *   - lang 이 없는 옛 초안(배포 전에 만들어진 것) → "zh-ja" 로 떨어진다
 *   - PIVO ID 모달로 확정한 작품은 draft 에 lang 이 실린다
 *
 * fixture self-fulfilling 금지:
 *   기대값을 호출부에서 베끼지 않고, draftStore 에 심은 lang 과 실제로 넘어간 인자를 대조한다.
 *   회차를 바꿔야 재조회가 일어나므로(변경 없으면 기존 값 유지) 입력값을 일부러 다르게 준다.
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const registerDirectInputActions = require("../direct-input-actions");

function makeFakeApp() {
  const registered = { actions: {}, views: {} };
  return {
    action(id, handler) { registered.actions[id] = handler; },
    view(id, handler) { registered.views[id] = handler; },
    _registered: registered,
  };
}

const fakeClient = () => ({
  views: { open: async () => ({}) },
  chat: { postMessage: async () => ({ ts: "123" }), update: async () => ({}) },
  conversations: { history: async () => ({ messages: [] }) },
});

function setup(overrides = {}) {
  const draftStore = new Map();
  const app = makeFakeApp();
  const deliveryCalls = [];
  const deps = {
    draftStore,
    buildDraftPreviewBlocks: () => [],
    buildDraftPreviewText: () => "preview",
    buildFileInquiryBlocks: () => [],
    matchWorkTitleFromSheet: async () => null,
    fetchDeliveryDate: async (...args) => { deliveryCalls.push(args); return null; },
    handleFileOrderInquiry: async () => {},
    handleScheduleExt: async () => {},
    handleWorkerRelay: async () => {},
    generateDraftId: () => "draft_new",
    resolveApmUserId: () => null,
    postInquiryToTargetChannel: async () => ({ ts: "ts_tgt" }),
    TARGET_CHANNEL_ID: "C_TGT",
    ...overrides,
  };
  registerDirectInputActions(app, deps);
  return { app, draftStore, deliveryCalls, deps };
}

// 초안 수정 모달 제출 — 회차를 바꿔 납품일 재조회를 일으킨다
async function submitEdit({ app, draftStore }, draft) {
  draftStore.set(draft.draftId, draft);
  await app._registered.views.submit_inquiry_modal({
    ack: async () => {},
    body: { user: { id: draft.ownerUserId } },
    view: {
      private_metadata: JSON.stringify({ draftId: draft.draftId, draftVersion: draft.draftVersion }),
      state: { values: {
        work_name_block:    { work_name_input:    { value: draft.workName } },
        work_name_ko_block: { work_name_ko_input: { value: draft.workNameKo } },
        episode_block:      { episode_input:      { value: "99" } },   // 기존과 다른 회차 → 재조회
      } },
    },
    client: fakeClient(),
  });
}

const baseDraft = (over = {}) => ({
  draftId: "d1", draftVersion: 1, ownerUserId: "U1", userId: "U1",
  dmChannelId: "DM", workName: "작품", workNameKo: "작품", episode: "1",
  inquiryType: "기타", inquiryContent: "", summary: "", actionRequired: "",
  ...over,
});

describe("T1 초안 수정 경로 — draft.lang 으로 납품 탭을 고른다", () => {
  let ctx;
  beforeEach(() => { ctx = setup(); });

  it("한일 초안 → ko-ja", async () => {
    await submitEdit(ctx, baseDraft({ lang: "ko-ja" }));
    assert.equal(ctx.deliveryCalls.length, 1, "회차가 바뀌면 재조회해야 한다");
    assert.equal(ctx.deliveryCalls[0][2], "ko-ja");
  });

  it("중일 초안 → zh-ja", async () => {
    await submitEdit(ctx, baseDraft({ lang: "zh-ja" }));
    assert.equal(ctx.deliveryCalls[0][2], "zh-ja");
  });

  it("lang 이 없는 옛 초안 → zh-ja 로 떨어진다", async () => {
    await submitEdit(ctx, baseDraft());
    assert.equal(ctx.deliveryCalls[0][2], "zh-ja");
  });
});

describe("PIVO ID 모달이 확정한 작품은 lang 을 draft 에 싣는다", () => {
  it("한일 행으로 풀리면 draft.lang = ko-ja", async () => {
    const ctx = setup({
      matchWorkTitleFromSheet: async () => ({ koreanProjectName: "한일작품", pivoId: "82357", lang: "ko-ja" }),
    });
    ctx.draftStore.set("p1", { isPending: true, ownerUserId: "U1", userId: "U1", dmChannelId: "DM", titleJa: "テスト" });
    await ctx.app._registered.views.pivo_id_modal({
      ack: async () => {},
      body: { user: { id: "U1" } },
      view: { private_metadata: JSON.stringify({ pendingId: "p1" }), state: { values: { pivo_id: { value: { value: "82357" } } } } },
      client: fakeClient(),
    });
    const created = [...ctx.draftStore.values()].find(d => d.draftId);
    assert.ok(created, "초안이 생성돼야 한다");
    assert.equal(created.lang, "ko-ja");
    assert.equal(created.pivoId, "82357");
  });
});
