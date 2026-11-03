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
const { createLangRouting } = require("../../config/lang-routing");
// 실제 라우팅 모듈을 그대로 쓴다 — 가짜로 대체하면 "언어별로 갈린다"는 계약을 안 보게 된다.
const routing = (overrides = {}) => createLangRouting({
  base: { target: "C_TGT", pmRequest: "C_PM", schedule: "C_SCH", mentionUserIds: ["U_FWD"], pmSlackId: "U_PM" },
  overrides,
});

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
    langRouting: routing(),
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

describe("T6·T7 직접 입력 모달의 PIVO 칸 (문의 흐름)", () => {
  const submit = async (ctx, values) => {
    const errs = [];
    ctx.draftStore.set("p1", { isPending: true, ownerUserId: "U1", userId: "U1", dmChannelId: "DM", titleJa: "テスト" });
    await ctx.app._registered.views.manual_title_modal({
      ack: async (a) => { if (a) errs.push(a); },
      body: { user: { id: "U1" } },
      view: { private_metadata: JSON.stringify({ pendingId: "p1" }), state: { values } },
      client: fakeClient(),
    });
    const created = [...ctx.draftStore.values()].find(d => d.draftId);
    return { errs, created };
  };
  const field = (v) => ({ value: { value: v } });

  it("PIVO 로 풀리면 draft 에 lang 까지 실린다", async () => {
    const ctx = setup({ matchWorkTitleFromSheet: async (q) =>
      (q && q.pivoId === "82357") ? { koreanProjectName: "한일작품", pivoId: "82357", lang: "ko-ja" } : null });
    const { created } = await submit(ctx, { manual_pivoid_block: field("82357") });
    assert.equal(created.lang, "ko-ja");
    assert.equal(created.pivoId, "82357");
  });

  it("T6 PIVO 가 틀려도 작품명이 맞으면 작품명으로 확정한다", async () => {
    const ctx = setup({ matchWorkTitleFromSheet: async (a) => {
      if (a && typeof a === "object" && a.pivoId) return null;            // 틀린 PIVO
      return { koreanProjectName: "제목으로찾음", pivoId: "999", lang: "zh-ja" };
    } });
    const { errs, created } = await submit(ctx, {
      manual_pivoid_block: field("00000"), manual_work_name_ja: field("テスト"),
    });
    assert.deepEqual(errs, [], "작품명으로 찾았으면 창을 막으면 안 된다");
    assert.equal(created.workName, "제목으로찾음");
  });

  it("T7 둘 다 비면 창 안에서 막고 초안을 안 만든다", async () => {
    const ctx = setup();
    const { errs, created } = await submit(ctx, {});
    assert.equal(errs.length, 1);
    assert.ok(errs[0].errors.manual_work_name_ja);
    assert.equal(created, undefined);
  });

  it("T7 PIVO 만 넣고 못 찾으면 창 안에서 막는다", async () => {
    const ctx = setup({ matchWorkTitleFromSheet: async () => null });
    const { errs, created } = await submit(ctx, { manual_pivoid_block: field("00000") });
    assert.equal(errs.length, 1);
    assert.match(errs[0].errors.manual_pivoid_block, /00000/);
    assert.equal(created, undefined);
  });
});
