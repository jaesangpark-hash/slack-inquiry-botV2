"use strict";
/**
 * inquiry-entry.test.js
 *
 * inquiry-entry.js 어댑터 회귀가드:
 * [결함 B 회귀가드] RETAKE 채널 reaction 시 메인 analyzeInquiryWithAI 미호출 (base 동작 복원)
 * base(app-base:342-372): RETAKE 채널은 메인 AI 분석 이전에 early-return → 메인 analyzeInquiryWithAI 호출 0회.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// ─── Spy 헬퍼 ──────────────────────────────────────────────────────────────
function spy(returnValue) {
  let calls = [];
  const fn = async (...args) => {
    calls.push(args);
    if (typeof returnValue === "function") return returnValue(...args);
    return returnValue;
  };
  fn.calls = calls;
  fn.callCount = () => calls.length;
  fn.lastArgs  = () => calls[calls.length - 1];
  fn.reset     = () => { calls = []; fn.calls = calls; };
  return fn;
}

function syncSpy(returnValue) {
  let calls = [];
  const fn = (...args) => {
    calls.push(args);
    return returnValue;
  };
  fn.calls = calls;
  fn.callCount = () => calls.length;
  return fn;
}

function noopSpy() { return spy(undefined); }

// ─── Bolt app mock ──────────────────────────────────────────────────────────
function makeApp() {
  let reactionHandler = null;
  return {
    event(name, handler) {
      if (name === "reaction_added") reactionHandler = handler;
    },
    message() {},
    client: {
      chat: { update: noopSpy(), postMessage: noopSpy() },
    },
    _triggerReaction: async (event, client) => {
      if (reactionHandler) await reactionHandler({ event, client });
    },
  };
}

// ─── client mock ─────────────────────────────────────────────────────────────
function makeClient(overrides = {}) {
  return {
    chat: { update: noopSpy(), postMessage: noopSpy(), postEphemeral: noopSpy() },
    users: { info: spy({ user: { profile: { display_name: "테스터" }, real_name: "테스터" } }) },
    conversations: {
      open:    spy({ channel: { id: "DM_CH" } }),
      history: spy({ messages: [{ ts: "100.000", text: "리테이크 요청", user: "U_MSG" }] }),
      replies: spy({ messages: [] }),
    },
    ...overrides,
  };
}

// ─── 공통 deps 팩토리 ─────────────────────────────────────────────────────────
function makeDeps(overrides = {}) {
  return {
    inquiryRouter:        { routeInquiry: noopSpy() },
    cleanSlackText:       syncSpy("리테이크 요청"),
    analyzeInquiryWithAI: spy({ inquiry_type: "기타", title_ja: null, title_ko: null }),
    buildProgressText:    syncSpy("요청을 받았어."),
    updateProgress:       noopSpy(),
    withTimeout:          async (fn, _opts) => fn(),  // 바로 실행
    checkPermission:      spy({ allowed: true }),
    isTriggerReaction:    syncSpy(true),
    triggerEmoji:         "문의봇소환",
    fetchThreadContext:   spy([{ ts: "100.000", text: "리테이크 요청", user: "U_MSG" }]),
    buildThreadContextText: syncSpy("스레드 맥락"),
    markInquiryProcessed: noopSpy(),
    extractSlackPermalink: syncSpy(null),
    fetchSingleLinkedMessage: spy(null),
    processedMessageTs:   new Set(),
    retakeChannels:       new Set(["RETAKE_CH1"]),
    ...overrides,
  };
}

// ─── 결함 B 회귀가드 ──────────────────────────────────────────────────────────
describe("[회귀가드-B] RETAKE 채널 reaction — 메인 analyzeInquiryWithAI 미호출", () => {
  it("RETAKE 채널 reaction: 메인 analyzeInquiryWithAI 호출 횟수 0 (base 동작 — 결함 B 복원)", async () => {
    const app  = makeApp();
    const deps = makeDeps();

    // inquiry-entry 등록
    require("../inquiry-entry")(app, deps);

    const client = makeClient();

    // RETAKE 채널에서 소환 이벤트 발생
    await app._triggerReaction(
      {
        reaction: "문의봇소환",
        user:     "U_APM",
        item: {
          type:    "message",
          channel: "RETAKE_CH1",   // RETAKE 채널
          ts:      "100.000",
        },
      },
      client,
    );

    // 메인 analyzeInquiryWithAI는 RETAKE 채널에서 호출되면 안 됨 (base 동작 보존)
    // base(app-base:342-372): RETAKE 선행분기가 메인 분석 이전에 early-return
    // router 내부(UD-1)의 contextAnalysis는 별도 호출이므로 어댑터의 메인 호출 횟수만 측정
    assert.equal(
      deps.analyzeInquiryWithAI.callCount(),
      0,
      "RETAKE 채널 reaction: 어댑터의 메인 analyzeInquiryWithAI 호출 0회 (결함 B 회귀가드)",
    );
  });

  it("RETAKE 채널 아닌 reaction: 메인 analyzeInquiryWithAI 호출됨 (정상 경로 보존)", async () => {
    const app  = makeApp();
    const deps = makeDeps();

    require("../inquiry-entry")(app, deps);

    const client = makeClient();

    // 일반 채널에서 소환
    await app._triggerReaction(
      {
        reaction: "문의봇소환",
        user:     "U_APM",
        item: {
          type:    "message",
          channel: "GENERAL_CH",   // RETAKE 채널 아님
          ts:      "100.000",
        },
      },
      client,
    );

    // 일반 채널은 메인 analyzeInquiryWithAI 호출이 1회 이상이어야 함
    assert.ok(
      deps.analyzeInquiryWithAI.callCount() >= 1,
      "일반 채널 reaction: 메인 analyzeInquiryWithAI 호출됨 (정상 경로 보존)",
    );
  });
});
