"use strict";
/**
 * 후보 선택·직접 입력으로 작품을 확정해도 회차·납품일이 이어지는가 (재상 님 실측 2026-11-04)
 *
 * 증상: 한일 <페이트메이트> 40화 문의 → 작품명 후보 2개 → 맞는 것을 골랐더니 초안에 회차가 비었다.
 * 원인: inquiry-router ⑧ 이 후보 화면으로 넘기며 만든 pending 에 회차가 없었고,
 *   inquiry_cand_pick_ / manual_title_modal 이 초안을 만들 때 회차·납품일을 아예 넣지 않았다.
 *   한 번에 매칭되는 경로만 analysis.episode 로 채우고 있었다. 언어쌍과 무관한 경로라 중일도 같다.
 *
 * 검증: pending 에 심은 회차가 초안까지 가고, 납품일 조회가 「고른 작품의 언어쌍」으로 나가는지.
 *   fetchDeliveryDate 인자를 실제 호출에서 받아 대조한다(기대값을 구현에서 베끼지 않는다).
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const registerDirectInputActions = require("../direct-input-actions");

function setup(overrides = {}) {
  const draftStore = new Map();
  const registered = { actions: {}, views: {} };
  const app = {
    action(id, h) { registered.actions[String(id)] = h; },
    view(id, h)   { registered.views[String(id)] = h; },
  };
  const deliveryCalls = [];
  const matchCalls = [];
  registerDirectInputActions(app, {
    draftStore,
    buildDraftPreviewBlocks: () => [],
    buildDraftPreviewText: () => "preview",
    buildFileInquiryBlocks: () => [],
    matchWorkTitleFromSheet: async (...a) => { matchCalls.push(a); return null; },
    fetchDeliveryDate: async (...args) => { deliveryCalls.push(args); return { allSame: true, deliveryDate: "2026-11-20" }; },
    handleFileOrderInquiry: async () => {},
    handleScheduleExt: async () => {},
    handleWorkerRelay: async () => {},
    generateDraftId: () => "draft_new",
    resolveApmUserId: () => null,
    postInquiryToTargetChannel: async () => ({ ts: "t" }),
    TARGET_CHANNEL_ID: "C_TGT",
    ...overrides,
  });
  const client = { chat: { postMessage: async () => ({ ts: "1" }), update: async () => ({}) }, views: { open: async () => ({}) } };
  return { registered, draftStore, deliveryCalls, matchCalls, client };
}

const pending = (over = {}) => ({
  isPending: true, ownerUserId: "U1", userId: "U1", dmChannelId: "DM",
  titleJa: "フェイトメイト", inquiryType: "작업 관련 문의", inquiryContent: "본문", summary: "요약",
  actionRequired: "확인", sourceLang: "ja", episode: "40", ...over,
});

const pickHandler = (ctx) => ctx.registered.actions[String(/^inquiry_cand_pick_\d+$/)];

for (const lang of ["ko-ja", "zh-ja"]) {
  describe(`${lang} 후보 선택 — 회차·납품일이 초안까지 이어진다`, () => {
    it("pending 회차가 초안에 실리고, 납품일은 고른 작품의 언어쌍으로 조회된다", async () => {
      const ctx = setup();
      ctx.draftStore.set("p1", pending());
      await pickHandler(ctx)({
        ack: async () => {},
        body: { actions: [{ value: JSON.stringify({ pendingId: "p1", pivoId: "200001", koreanProjectName: "페이트메이트", lang }) }] },
        client: ctx.client,
      });
      const draft = ctx.draftStore.get("draft_new");
      assert.equal(draft.episode, "40", "회차가 비면 이 버그가 그대로다");
      assert.equal(draft.deliveryDate, "2026-11-20");
      assert.deepEqual(ctx.deliveryCalls, [["페이트메이트", "40", lang, "페이트메이트"]]);
    });

    it("다시 찾는 작품 행은 버튼의 PIVO ID·언어쌍으로 찾는다 — 같은 이름 다른 판본을 잡지 않게", async () => {
      const ctx = setup();
      ctx.draftStore.set("p1", pending());
      await pickHandler(ctx)({
        ack: async () => {},
        body: { actions: [{ value: JSON.stringify({ pendingId: "p1", pivoId: "200001", koreanProjectName: "페이트메이트", lang }) }] },
        client: ctx.client,
      });
      assert.deepEqual(ctx.matchCalls[0][0], { pivoId: "200001", titleKo: "페이트메이트", langPair: lang });
    });
  });
}

describe("후보 선택 — 회차가 없던 문의는 그대로 비워 둔다", () => {
  it("회차 없음 → 납품일 조회를 하지 않고 「-」", async () => {
    const ctx = setup();
    ctx.draftStore.set("p1", pending({ episode: null }));
    await pickHandler(ctx)({
      ack: async () => {},
      body: { actions: [{ value: JSON.stringify({ pendingId: "p1", pivoId: "1", koreanProjectName: "작품", lang: "ko-ja" }) }] },
      client: ctx.client,
    });
    const draft = ctx.draftStore.get("draft_new");
    assert.equal(draft.episode, null);
    assert.equal(draft.deliveryDate, "-");
    assert.equal(ctx.deliveryCalls.length, 0);
  });
});

describe("후보 선택 — 스레드 맥락 여부도 이어진다(「문의 내용」 요약/전문 분기가 이걸 본다)", () => {
  for (const hasThreadContext of [true, false]) {
    it(`hasThreadContext=${hasThreadContext}`, async () => {
      const ctx = setup();
      ctx.draftStore.set("p1", pending({ hasThreadContext }));
      await pickHandler(ctx)({
        ack: async () => {},
        body: { actions: [{ value: JSON.stringify({ pendingId: "p1", pivoId: "1", koreanProjectName: "작품", lang: "ko-ja" }) }] },
        client: ctx.client,
      });
      assert.equal(ctx.draftStore.get("draft_new").hasThreadContext, hasThreadContext);
    });
  }
});

describe("직접 입력 모달 — 같은 버그가 있던 두 번째 경로", () => {
  for (const lang of ["ko-ja", "zh-ja"]) {
    it(`${lang} PIVO 로 확정해도 회차·납품일이 실린다`, async () => {
      const ctx = setup({ matchWorkTitleFromSheet: async (q) =>
        (q && q.pivoId === "200001") ? { koreanProjectName: "페이트메이트", pivoId: "200001", lang } : null });
      ctx.draftStore.set("p1", pending());
      await ctx.registered.views.manual_title_modal({
        ack: async () => {},
        body: { user: { id: "U1" } },
        view: { private_metadata: JSON.stringify({ pendingId: "p1" }),
          state: { values: { manual_pivoid_block: { value: { value: "200001" } } } } },
        client: ctx.client,
      });
      const draft = ctx.draftStore.get("draft_new");
      assert.equal(draft.episode, "40");
      assert.equal(draft.deliveryDate, "2026-11-20");
      assert.deepEqual(ctx.deliveryCalls, [["페이트메이트", "40", lang, "페이트메이트"]]);
    });
  }

  it("작품을 못 찾으면 회차는 남기고 납품일은 「-」", async () => {
    const ctx = setup({ matchWorkTitleFromSheet: async () => null });
    ctx.draftStore.set("p1", pending());
    await ctx.registered.views.manual_title_modal({
      ack: async () => {},
      body: { user: { id: "U1" } },
      view: { private_metadata: JSON.stringify({ pendingId: "p1" }),
        state: { values: { manual_work_name_ja: { value: { value: "なにか" } } } } },
      client: ctx.client,
    });
    const draft = ctx.draftStore.get("draft_new");
    assert.equal(draft.episode, "40");
    assert.equal(draft.deliveryDate, "-");
    assert.equal(ctx.deliveryCalls.length, 0);
  });
});
