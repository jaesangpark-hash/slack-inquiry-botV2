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

/**
 * 복수 소환 → 리테이크/파일순서 재디스패치에 "확정 작품 언어"(matchedTitle.lang)를 넘기는지.
 *
 * 회귀 배경: 한일/중일을 한 이모지로 받다가 이모지를 둘로 쪼갠 뒤,
 *   복수 소환(납품 스레드는 대부분 복수)에서 processItem → handleRetakeInquiry 재호출 시
 *   언어를 빠뜨려(기존 코드) 내부 재매칭이 양쪽 마스터를 섞어 돌렸다.
 *   그 결과 한일 작품이 엉뚱한 중일 작품으로 잡히거나 후보 충돌로 멈춰
 *   감시행이 안 생기고 → 완료 알림이 안 나갔다. (단일 소환 경로는 멀쩡)
 *
 * self-fulfilling 금지: 매칭 결과의 lang("ko-ja")이 그대로 재호출 인자에 도달하는지만 본다.
 */
function makeCapturingHarness({ matchedLang }) {
  const app = { action() {}, view() {} };
  const retakeCalls = [];
  const fileOrderCalls = [];
  const draftStore = new Map();
  const api = registerMultipleInquiryFlow(app, {
    ai: { models: { generateContent: async () => ({ text: "{}" }) } },
    GEMINI_MODEL: "x",
    matchWorkTitleFromSheet: async () => ({ koreanProjectName: "아포칼립스", pivoId: "P1", lang: matchedLang }),
    matchWorkTitleByTokens: async () => null,
    generateDraftId: () => "d1",
    draftStore,
    fetchDeliveryDate: async () => null,
    handleFileOrderInquiry: async (...args) => { fileOrderCalls.push(args); },
    handleRetakeInquiry:   async (...args) => { retakeCalls.push(args); },
    handleScheduleExt: async () => {},
    handleScheduleExtGrouped: null,
  });
  return { api, retakeCalls, fileOrderCalls };
}

describe("복수 문의 — 리테이크/파일순서 언어 전달 (한일 완료 알림 회귀)", () => {
  test("리테이크 항목 → handleRetakeInquiry 에 확정 언어(matchedTitle.lang) 전달", async () => {
    const { api, retakeCalls } = makeCapturingHarness({ matchedLang: "ko-ja" });

    await api.handleMultipleInquiry(
      client, "DM1", "원문", "https://link", "C1", "1.1", "요청자",
      [{ type: "리테이크", work_title_ko: "아포칼립스", work_title_ja: "", episode: "3" }],
      null, "U_REQ", "U_OWNER", null,
      "ko-ja",
    );

    assert.equal(retakeCalls.length, 1, "handleRetakeInquiry 가 불려야 한다");
    // 시그니처: (client, dmChannel, analysis, linkInfo, originalText, requesterName, requesterUserId, ownerUserId, langPair)
    assert.equal(
      retakeCalls[0][8], "ko-ja",
      `9번째 인자(langPair)로 확정 언어가 넘어가야 한다 — 빠지면 한일 완료 알림 누락. 실제: ${JSON.stringify(retakeCalls[0][8])}`,
    );
  });

  test("파일순서 항목 → handleFileOrderInquiry 에 확정 언어 전달", async () => {
    const { api, fileOrderCalls } = makeCapturingHarness({ matchedLang: "ko-ja" });

    await api.handleMultipleInquiry(
      client, "DM1", "원문", "https://link", "C1", "1.1", "요청자",
      [{ type: "파일순서", work_title_ko: "아포칼립스", work_title_ja: "", episode: "3" }],
      null, "U_REQ", "U_OWNER", null,
      "ko-ja",
    );

    assert.equal(fileOrderCalls.length, 1, "handleFileOrderInquiry 가 불려야 한다");
    // 시그니처: (client, dmChannel, analysis, linkInfo, originalText, langPair)
    assert.equal(
      fileOrderCalls[0][5], "ko-ja",
      `6번째 인자(langPair)로 확정 언어가 넘어가야 한다. 실제: ${JSON.stringify(fileOrderCalls[0][5])}`,
    );
  });
});
