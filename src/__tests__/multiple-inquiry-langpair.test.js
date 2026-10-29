"use strict";
/**
 * multipleInquiryFlow.js — 복수 문의의 언어쌍(langPair) 전달 회귀 시험
 *
 * node:test + node:assert 빌트인 (신규 dep 추가 금지).
 * factory DI — registerMultipleInquiryFlow 에 가짜 app/deps 를 넣어 핸들러를 직접 집어 부른다.
 *
 * 검증 항목 (2026-10-28 AIA 3차 리뷰 B1·B2):
 *   B2 — handleMultipleInquiry 가 받은 langPair 를 제목 매칭까지 내려보낸다.
 *        안 내려보내면 복수 문의만 하드 필터가 빠져 반대 언어 작품을 집는다.
 *   B1 — 「누락 정보 채우기」 제출 핸들러가 langPair 를 pending 에서 꺼내 쓴다.
 *        예전엔 스코프에 없는 변수를 참조해 제출하는 순간 ReferenceError 로 죽었다.
 *
 * fixture self-fulfilling 금지:
 *   기대하는 langPair 값을 코드에서 베껴오지 않고, 소환 시 넘기는 "ko-ja" 가 그대로
 *   매칭 호출에 도달하는지만 본다.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const registerMultipleInquiryFlow = require("../multipleInquiryFlow");

function makeHarness() {
  const views = {};
  const app = { action() {}, view(id, handler) { views[id] = handler; } };
  const matchCalls = [];
  const draftStore = new Map();

  const api = registerMultipleInquiryFlow(app, {
    ai: { models: { generateContent: async () => ({ text: "{}" }) } },
    GEMINI_MODEL: "x",
    matchWorkTitleFromSheet: async (q) => { matchCalls.push(q); return null; },
    matchWorkTitleByTokens: async (_ko, _ja, _x, langPair) => {
      matchCalls.push({ viaTokens: true, langPair });
      return null;
    },
    generateDraftId: () => "d1",
    draftStore,
    fetchDeliveryDate: async () => null,
    handleFileOrderInquiry: async () => {},
    handleRetakeInquiry: async () => {},
    handleScheduleExt: async () => {},
    handleScheduleExtGrouped: null,
  });
  return { api, views, matchCalls, draftStore };
}

const client = {
  chat: { postMessage: async () => ({ ts: "t1" }), update: async () => ({}) },
  views: { open: async () => ({}) },
};

const ITEM = { type: "기타", work_title_ko: "아포칼립스", work_title_ja: "", content: "문의 내용", episode: "3" };

describe("복수 문의 — langPair 전달 (AIA B1·B2)", () => {
  test("B2: 소환 때 받은 langPair 가 제목 매칭까지 내려간다", async () => {
    const { api, matchCalls } = makeHarness();

    await api.handleMultipleInquiry(
      client, "DM1", "원문", "https://link", "C1", "1.1", "요청자",
      [ITEM],            // preItems — AI 파싱 건너뛴다
      null, "U_REQ", "U_OWNER", null,
      "ko-ja",           // ★langPair
    );

    assert.ok(matchCalls.length > 0, "제목 매칭이 한 번은 불려야 한다");
    assert.ok(
      matchCalls.some(c => c && c.langPair === "ko-ja"),
      `langPair 가 안 넘어갔다 — 복수 문의만 하드 필터가 빠진다. 실제: ${JSON.stringify(matchCalls)}`,
    );
  });

  test("B1: 「누락 정보 채우기」 제출이 pending 의 langPair 를 꺼내 쓴다 (예전엔 ReferenceError)", async () => {
    const { api, views, matchCalls, draftStore } = makeHarness();

    await api.handleMultipleInquiry(
      client, "DM1", "원문", "https://link", "C1", "1.1", "요청자",
      [{ ...ITEM, work_title_ko: "" }],   // 작품명 비워 누락 상태로 만든다
      null, "U_REQ", "U_OWNER", null, "ko-ja",
    );

    const pendingId = [...draftStore.keys()].find(k => String(k).startsWith("multi_"));
    assert.ok(pendingId, "복수 문의 pending 이 있어야 한다");
    assert.equal(draftStore.get(pendingId).langPair, "ko-ja", "pending 에 langPair 가 저장돼야 한다");

    const handler = views["submit_multi_fill_missing"];
    assert.ok(handler, "제출 핸들러가 등록돼 있어야 한다");

    matchCalls.length = 0;
    // 예전 코드는 이 호출에서 스코프에 없는 langPair 를 참조해 그대로 터졌다.
    await handler({
      ack: async () => {},
      body: { user: { id: "U1" } },
      view: {
        private_metadata: JSON.stringify({ multiPendingId: pendingId, itemIndex: 0 }),
        state: { values: { mi_work_block: { value: { value: "아포칼립스" } } } },
      },
      client,
    });

    assert.ok(
      matchCalls.some(c => c && c.langPair === "ko-ja"),
      `제출 경로에서도 langPair 가 살아 있어야 한다. 실제: ${JSON.stringify(matchCalls)}`,
    );
  });
});
