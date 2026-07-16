"use strict";
/**
 * inquiry-router.test.js
 *
 * routeInquiry 단위 테스트:
 * 1. 분기별 flow 호출 검증 (RETAKE + ①~⑧)
 * 2. 두 경로 동작 동등성 + divergence 보존 (C-1 결정 회귀가드)
 */

const { describe, it, before, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const createInquiryRouter = require("../inquiry-router");

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

function noopSpy() { return spy(undefined); }

// ─── 공유 deps 팩토리 ────────────────────────────────────────────────────────
function makeDeps(overrides = {}) {
  const draftStore = new Map();

  // flow spies
  const handleScheduleExt    = noopSpy();
  const handleMultipleInquiry = noopSpy();
  const handleWorkerRelay     = noopSpy();
  const handleRetakeInquiry   = noopSpy();
  const handleFileOrderInquiry = noopSpy();

  return {
    parseScheduleInquiry:        spy({ work_title_ja: "テスト", work_title_ko: "테스트" }),
    parseFileInquiry:            spy({ work_title_ja: "テスト", work_title_ko: "테스트", episode: "1", file_numbers: [1], reason_raw: "" }),
    matchWorkTitleWithCandidates: spy({ single: { koreanProjectName: "테스트작품", chineseOriginalTitle: "测试作品", pivoId: "p1" } }),
    matchWorkTitleFromSheet:      spy({ koreanProjectName: "테스트작품", chineseOriginalTitle: "测试作品", japaneseFixedTitle: "テスト", pivoId: "p1" }),
    matchWorkTitleByTokens:       spy({ single: { koreanProjectName: "테스트작품", chineseOriginalTitle: "测试作品", pivoId: "p1" } }),
    fetchDeliveryDate:            spy({ episodeLabel: "1화", allSame: true, deliveryDate: "2026-06-01", episodes: [] }),
    generateDraftId:              spy("draft_test_001"),
    draftStore,
    buildFileInquiryBlocks:       spy([]),
    buildFileInquiryReason:       spy("reason"),
    buildDraftPreviewBlocks:      spy([]),
    buildDraftPreviewText:        spy("preview"),
    buildOtherInquirySummary:     spy("other-summary"),
    buildProgressText:            spy("progress"),
    flows: {
      handleScheduleExt,
      handleMultipleInquiry,
      handleWorkerRelay,
      handleRetakeInquiry,
      handleFileOrderInquiry,
    },
    retakeChannels: new Set(["RETAKE_CH1"]),
    analyzeInquiryWithAI:         spy({ title_ja: "テスト", title_ko: "테스트", episode: "1" }),
    ...overrides,
  };
}

// ─── ctx 빌더 ────────────────────────────────────────────────────────────────
function makeReactionCtx(overrides = {}) {
  const client = {
    chat:  { update: noopSpy(), postMessage: noopSpy(), postEphemeral: noopSpy() },
    users: { info: spy({ user: { profile: { display_name: "테스터" }, real_name: "테스터" } }) },
    conversations: { open: spy({ channel: { id: "DM_CH" } }) },
  };
  return {
    source:          "reaction",
    client,
    dmChannel:       "DM_CH",
    progressMsg:     { ts: "100.000" },
    analysis:        { inquiry_type: "기타", title_ja: "テスト", title_ko: "테스트", episode: "1" },
    originalText:    "테스트 원문",
    hasThreadContext: false,
    threadContextText: "",
    sourceLink:      "https://slack.com/archives/CH/p100000",
    sourceMeta:      { channelId: "GENERAL_CH", ts: "100.000" },
    files:           [],
    requesterUserId: "U_REQUESTER",
    requesterName:   "",
    userId:          "U_OWNER",
    ...overrides,
  };
}

function makeMessageCtx(overrides = {}) {
  const client = {
    chat:  { update: noopSpy(), postMessage: noopSpy() },
    users: { info: spy({ user: { profile: { display_name: "테스터" }, real_name: "테스터" } }) },
  };
  return {
    source:          "message",
    client,
    dmChannel:       "DM_CH",
    progressMsg:     { ts: "200.000" },
    analysis:        { inquiry_type: "기타", title_ja: "テスト", title_ko: "테스트", episode: "1" },
    originalText:    "테스트 원문",
    hasThreadContext: false,
    threadContextText: "",
    sourceLink:      "https://slack.com/archives/CH/p100000",
    sourceMeta:      { channelId: "GENERAL_CH", ts: "100.000" },
    files:           [],
    requesterUserId: "U_REQUESTER",
    requesterName:   "",
    userId:          "U_OWNER",
    ...overrides,
  };
}

// ─── 테스트 ─────────────────────────────────────────────────────────────────

describe("createInquiryRouter", () => {
  it("module exports factory function", () => {
    assert.equal(typeof createInquiryRouter, "function");
  });

  it("returns routeInquiry function", () => {
    const deps = makeDeps();
    const router = createInquiryRouter(deps);
    assert.equal(typeof router.routeInquiry, "function");
  });
});

// ─── UD-1: RETAKE 채널 선행분기 (reaction만) ────────────────────────────────
describe("UD-1: RETAKE 채널 선행분기", () => {
  it("reaction + RETAKE 채널 → handleRetakeInquiry 호출", async () => {
    const deps = makeDeps();
    const router = createInquiryRouter(deps);
    const ctx = makeReactionCtx({
      sourceMeta: { channelId: "RETAKE_CH1", ts: "100.000" },
      originalText: "리테이크 요청",
    });
    await router.routeInquiry(ctx);
    assert.equal(deps.flows.handleRetakeInquiry.callCount(), 1);
    assert.equal(deps.flows.handleMultipleInquiry.callCount(), 0);
  });

  it("reaction + RETAKE 채널, 복수 항목 → handleMultipleInquiry 호출", async () => {
    const deps = makeDeps();
    const router = createInquiryRouter(deps);
    const ctx = makeReactionCtx({
      sourceMeta: { channelId: "RETAKE_CH1", ts: "100.000" },
      originalText: "[작품A] 수정\n[작품B] 수정",
    });
    await router.routeInquiry(ctx);
    assert.equal(deps.flows.handleMultipleInquiry.callCount(), 1);
    assert.equal(deps.flows.handleRetakeInquiry.callCount(), 0);
  });

  it("reaction + RETAKE 채널, 동일 화수 내 파일N 라벨 3건 → handleRetakeInquiry 호출 (단건 유지)", async () => {
    const deps = makeDeps();
    const router = createInquiryRouter(deps);
    const ctx = makeReactionCtx({
      sourceMeta: { channelId: "RETAKE_CH1", ts: "100.000" },
      originalText: "207075 | [카카오픽코마] 짐승의 발자국 / 26 PIVO 납품\n\n• 파일2 #3\n원문\n->\n수정문\n\n• 파일2 #3\n원문\n->\n수정문\n\n• 파일6 #3\n원문\n->\n수정문",
    });
    await router.routeInquiry(ctx);
    assert.equal(deps.flows.handleRetakeInquiry.callCount(), 1);
    assert.equal(deps.flows.handleMultipleInquiry.callCount(), 0);
  });

  it("reaction + RETAKE 채널, 서로 다른 화수 헤더 2건 → handleMultipleInquiry 호출 (화수별 분리)", async () => {
    const deps = makeDeps();
    const router = createInquiryRouter(deps);
    const ctx = makeReactionCtx({
      sourceMeta: { channelId: "RETAKE_CH1", ts: "100.000" },
      originalText: "207075 | [카카오픽코마] 짐승의 발자국 / 26 PIVO 납품\n\n파일2 #3\n원문\n->\n수정문\n\n207075 | [카카오픽코마] 짐승의 발자국 / 27 PIVO 납품\n\n파일6 #3\n원문\n->\n수정문",
    });
    await router.routeInquiry(ctx);
    assert.equal(deps.flows.handleMultipleInquiry.callCount(), 1);
    assert.equal(deps.flows.handleRetakeInquiry.callCount(), 0);
  });

  it("message + RETAKE 채널 → RETAKE 선행분기 진입 안 함 (UD-1 보존)", async () => {
    const deps = makeDeps();
    const router = createInquiryRouter(deps);
    // message는 RETAKE 채널 소환이 구조상 불가 (기타 분기로 흐름)
    const ctx = makeMessageCtx({
      sourceMeta: { channelId: "RETAKE_CH1", ts: "100.000" },
      analysis:   { inquiry_type: "기타", title_ja: null, title_ko: null, episode: null },
    });
    deps.matchWorkTitleWithCandidates = spy(null);
    await router.routeInquiry(ctx);
    // RETAKE flow는 호출되지 않아야 함
    assert.equal(deps.flows.handleRetakeInquiry.callCount(), 0);
  });
});

// ─── ① 스케줄 문의 ───────────────────────────────────────────────────────────
describe("① 스케줄 문의", () => {
  it("reaction: handleScheduleExt 호출", async () => {
    const deps = makeDeps();
    const router = createInquiryRouter(deps);
    const ctx = makeReactionCtx({ analysis: { inquiry_type: "스케줄 문의", title_ja: "テスト", title_ko: "테스트" } });
    await router.routeInquiry(ctx);
    assert.equal(deps.flows.handleScheduleExt.callCount(), 1);
  });

  it("message: delivery 없으면 draftStore.set(sched_pending) + handleScheduleExt 미호출 (UD-6)", async () => {
    const deps = makeDeps({ fetchDeliveryDate: spy(null) });
    const router = createInquiryRouter(deps);
    const ctx = makeMessageCtx({ analysis: { inquiry_type: "스케줄 문의", title_ja: "テスト", title_ko: "테스트" } });
    await router.routeInquiry(ctx);
    assert.equal(deps.flows.handleScheduleExt.callCount(), 0);
    // draftStore에 sched_pending 타입 항목이 생겼어야 함
    const entries = [...deps.draftStore.values()];
    assert.ok(entries.some(e => e.type === "schedule_pending"));
  });

  it("reaction: delivery null이어도 handleScheduleExt 호출 (UD-6 보존)", async () => {
    const deps = makeDeps({ fetchDeliveryDate: spy(null) });
    const router = createInquiryRouter(deps);
    const ctx = makeReactionCtx({ analysis: { inquiry_type: "스케줄 문의", title_ja: "テスト", title_ko: "테스트" } });
    await router.routeInquiry(ctx);
    assert.equal(deps.flows.handleScheduleExt.callCount(), 1);
  });

  // 결함 C 회귀가드: ① 스케줄에서 reaction만 parsed.requesterUserId 설정 / message는 미설정 (base 동작 보존)
  it("[회귀가드-C] ① 스케줄 reaction: parsed.requesterUserId 설정됨 (base:450 보존)", async () => {
    const deps = makeDeps();
    const router = createInquiryRouter(deps);
    const ctx = makeReactionCtx({
      analysis:        { inquiry_type: "스케줄 문의", title_ja: "テスト", title_ko: "테스트" },
      requesterUserId: "U_REQUESTER_R",
    });
    await router.routeInquiry(ctx);
    // handleScheduleExt 3번째 인자(parsed)에 requesterUserId가 설정되어 있어야 함
    assert.equal(deps.flows.handleScheduleExt.callCount(), 1);
    const parsed = deps.flows.handleScheduleExt.lastArgs()[2];
    assert.equal(parsed.requesterUserId, "U_REQUESTER_R", "reaction ① 스케줄: parsed.requesterUserId 설정 (결함 C 회귀가드)");
  });

  it("[회귀가드-C] ① 스케줄 message: parsed.requesterUserId 미설정 (base:784-785 보존 — divergence 고정)", async () => {
    // message 스케줄은 matchedTitle + delivery 모두 있어야 handleScheduleExt 호출됨
    // parseScheduleInquiry에 episode 포함 → fetchDeliveryDate 호출 가능 → delivery 반환
    const deps = makeDeps({
      parseScheduleInquiry: spy({ work_title_ja: "テスト", work_title_ko: "테스트", episode: "1" }),
    });
    const router = createInquiryRouter(deps);
    const ctx = makeMessageCtx({
      analysis:        { inquiry_type: "스케줄 문의", title_ja: "テスト", title_ko: "테스트" },
      requesterUserId: "U_REQUESTER_M",
    });
    await router.routeInquiry(ctx);
    assert.equal(deps.flows.handleScheduleExt.callCount(), 1);
    const parsed = deps.flows.handleScheduleExt.lastArgs()[2];
    // message 스케줄은 parsed.requesterUserId가 설정되면 안 됨 (base 동작 보존)
    assert.ok(parsed.requesterUserId === undefined || parsed.requesterUserId === null,
      "message ① 스케줄: parsed.requesterUserId 미설정 (결함 C 회귀가드)");
  });
});

// ─── ② 복수 문의 (UD-2) ──────────────────────────────────────────────────────
describe("② 복수 문의 (UD-2: reqName divergence 보존)", () => {
  it("reaction: handleMultipleInquiry 호출 (내부 users.info 조회 발생)", async () => {
    const deps = makeDeps();
    const router = createInquiryRouter(deps);
    const ctx = makeReactionCtx({ analysis: { inquiry_type: "복수 문의", multi_items: null } });
    await router.routeInquiry(ctx);
    assert.equal(deps.flows.handleMultipleInquiry.callCount(), 1);
  });

  it("message: handleMultipleInquiry 호출, reqName='' 빈문자 전달 (UD-2 보존)", async () => {
    const deps = makeDeps();
    const router = createInquiryRouter(deps);
    const ctx = makeMessageCtx({ analysis: { inquiry_type: "복수 문의", multi_items: null }, requesterName: "" });
    await router.routeInquiry(ctx);
    assert.equal(deps.flows.handleMultipleInquiry.callCount(), 1);
    // message 어댑터는 reqName="" 빈문자 그대로 전달 (6번째 인자)
    const callArgs = deps.flows.handleMultipleInquiry.lastArgs();
    assert.equal(callArgs[6], "");
  });
});

// ─── ③ 기타 ──────────────────────────────────────────────────────────────────
describe("③ 기타", () => {
  it("reaction: 5버튼 postMessage 호출", async () => {
    const deps = makeDeps();
    const router = createInquiryRouter(deps);
    const ctx = makeReactionCtx({ analysis: { inquiry_type: "기타", title_ja: "テスト", title_ko: "테스트", episode: "1" } });
    await router.routeInquiry(ctx);
    const postMsg = ctx.client.chat.postMessage;
    assert.equal(postMsg.callCount(), 1);
    const blocks = postMsg.lastArgs()[0].blocks;
    const actionIds = blocks.find(b => b.type === "actions").elements.map(e => e.action_id);
    assert.ok(actionIds.includes("direct_inquiry_btn"));
    assert.ok(actionIds.includes("direct_resupply_btn"));
    assert.ok(actionIds.includes("direct_schedule_btn"));
    assert.ok(actionIds.includes("direct_fileorder_btn"));
    assert.ok(actionIds.includes("direct_retake_btn"));
  });

  it("message: 동일 5버튼 postMessage", async () => {
    const deps = makeDeps();
    const router = createInquiryRouter(deps);
    const ctx = makeMessageCtx({ analysis: { inquiry_type: "기타", title_ja: "テスト", title_ko: "테스트", episode: "1" } });
    await router.routeInquiry(ctx);
    const postMsg = ctx.client.chat.postMessage;
    assert.equal(postMsg.callCount(), 1);
    const actionIds = postMsg.lastArgs()[0].blocks.find(b => b.type === "actions").elements.map(e => e.action_id);
    assert.ok(actionIds.includes("direct_inquiry_btn"));
  });
});

// ─── ④ 번역계열 ───────────────────────────────────────────────────────────────
describe("④ 번역계열", () => {
  for (const inquiryType of ["번역문 누락", "번역문 확인", "번역문 수정"]) {
    it(`reaction: ${inquiryType} → handleWorkerRelay 호출`, async () => {
      const deps = makeDeps();
      const router = createInquiryRouter(deps);
      const ctx = makeReactionCtx({ analysis: { inquiry_type: inquiryType } });
      await router.routeInquiry(ctx);
      assert.equal(deps.flows.handleWorkerRelay.callCount(), 1);
    });

    it(`message: ${inquiryType} → handleWorkerRelay 호출`, async () => {
      const deps = makeDeps();
      const router = createInquiryRouter(deps);
      const ctx = makeMessageCtx({ analysis: { inquiry_type: inquiryType } });
      await router.routeInquiry(ctx);
      assert.equal(deps.flows.handleWorkerRelay.callCount(), 1);
    });
  }
});

// ─── ⑤ 수정&리테이크 (UD-7) ─────────────────────────────────────────────────
describe("⑤ 수정&리테이크 (UD-7: reaction만 — divergence 보존)", () => {
  it("reaction: handleRetakeInquiry 호출", async () => {
    const deps = makeDeps();
    const router = createInquiryRouter(deps);
    const ctx = makeReactionCtx({ analysis: { inquiry_type: "수정&리테이크", title_ja: "テスト", title_ko: "테스트" } });
    await router.routeInquiry(ctx);
    assert.equal(deps.flows.handleRetakeInquiry.callCount(), 1);
  });

  it("message: handleRetakeInquiry 미호출 (UD-7 보존 — message는 분기 부재)", async () => {
    const deps = makeDeps();
    deps.matchWorkTitleWithCandidates = spy(null);
    const router = createInquiryRouter(deps);
    const ctx = makeMessageCtx({ analysis: { inquiry_type: "수정&리테이크", title_ja: "テスト", title_ko: "테스트" } });
    await router.routeInquiry(ctx);
    // message 경로에서는 수정&리테이크 분기가 없어 ⑧ 기본처리로 폴백
    assert.equal(deps.flows.handleRetakeInquiry.callCount(), 0);
  });
});

// ─── ⑥ 원본 파일 순서 ────────────────────────────────────────────────────────
describe("⑥ 원본 파일 순서", () => {
  it("reaction: handleFileOrderInquiry 호출", async () => {
    const deps = makeDeps();
    const router = createInquiryRouter(deps);
    const ctx = makeReactionCtx({ analysis: { inquiry_type: "원본 파일 순서" } });
    await router.routeInquiry(ctx);
    assert.equal(deps.flows.handleFileOrderInquiry.callCount(), 1);
  });

  it("message: handleFileOrderInquiry 호출", async () => {
    const deps = makeDeps();
    const router = createInquiryRouter(deps);
    const ctx = makeMessageCtx({ analysis: { inquiry_type: "원본 파일 순서" } });
    await router.routeInquiry(ctx);
    assert.equal(deps.flows.handleFileOrderInquiry.callCount(), 1);
  });

  // 결함 A 회귀가드: ⑥ message 경로 4번째 인자에 url 포함 (base 동작 복원 고정)
  it("[회귀가드-A] ⑥ message 경로: handleFileOrderInquiry 4번째 인자에 url 포함 (결함 A 복원)", async () => {
    const deps = makeDeps();
    const router = createInquiryRouter(deps);
    const sourceLink = "https://slack.com/archives/CH/p200000";
    const ctx = makeMessageCtx({
      analysis:   { inquiry_type: "원본 파일 순서" },
      sourceLink,
    });
    await router.routeInquiry(ctx);
    assert.equal(deps.flows.handleFileOrderInquiry.callCount(), 1);
    const callArgs = deps.flows.handleFileOrderInquiry.lastArgs();
    // 4번째 인자(linkInfo)가 url 키를 포함해야 함 (fileOrderFlow.js:301,332,360이 linkInfo?.url 소비)
    assert.equal(callArgs[3].url, sourceLink, "message ⑥ 4번째 인자에 url=sourceLink 포함 (결함 A 회귀가드)");
  });

  // 결함 A 회귀가드: reaction 경로도 url 포함 (기존 정상 동작 보존)
  it("[회귀가드-A] ⑥ reaction 경로: handleFileOrderInquiry 4번째 인자에 url 포함", async () => {
    const deps = makeDeps();
    const router = createInquiryRouter(deps);
    const sourceLink = "https://slack.com/archives/CH/p100000";
    const ctx = makeReactionCtx({
      analysis:   { inquiry_type: "원본 파일 순서" },
      sourceLink,
    });
    await router.routeInquiry(ctx);
    assert.equal(deps.flows.handleFileOrderInquiry.callCount(), 1);
    const callArgs = deps.flows.handleFileOrderInquiry.lastArgs();
    assert.equal(callArgs[3].url, sourceLink, "reaction ⑥ 4번째 인자에 url=sourceLink 포함");
  });
});

// ─── ⑦ 원본 파일 확인 (UD-8) ─────────────────────────────────────────────────
describe("⑦ 원본 파일 확인 (UD-8: 매칭 실패 처리 divergence 보존)", () => {
  it("reaction + 매칭 실패 → draftStore.set(file_inquiry_pending) + open_file_inquiry_modal (UD-8 보존)", async () => {
    const deps = makeDeps({ matchWorkTitleFromSheet: spy(null) });
    const router = createInquiryRouter(deps);
    const ctx = makeReactionCtx({ analysis: { inquiry_type: "원본 파일 확인", title_ja: "テスト", title_ko: "테스트" } });
    await router.routeInquiry(ctx);
    // draftStore에 file_inquiry_pending 항목
    const entries = [...deps.draftStore.values()];
    assert.ok(entries.some(e => e.type === "file_inquiry_pending"));
    // open_file_inquiry_modal 버튼이 postMessage로 전달됐는지
    const postMsg = ctx.client.chat.postMessage;
    assert.equal(postMsg.callCount(), 1);
    const actionIds = postMsg.lastArgs()[0].blocks.find(b => b.type === "actions").elements.map(e => e.action_id);
    assert.ok(actionIds.includes("open_file_inquiry_modal"));
  });

  it("message + 매칭 실패 → draftStore.set(draft) + buildFileInquiryBlocks (UD-8 보존: '-' draft 진행)", async () => {
    const deps = makeDeps({ matchWorkTitleFromSheet: spy(null) });
    const router = createInquiryRouter(deps);
    const ctx = makeMessageCtx({ analysis: { inquiry_type: "원본 파일 확인", title_ja: "テスト", title_ko: "테스트" } });
    await router.routeInquiry(ctx);
    // draftStore에 draft(file_inquiry_pending 아닌 일반 draft) 항목
    const entries = [...deps.draftStore.values()];
    assert.ok(entries.length > 0);
    assert.ok(!entries.some(e => e.type === "file_inquiry_pending"), "message는 file_inquiry_pending 미사용");
    assert.equal(deps.buildFileInquiryBlocks.callCount(), 1);
  });
});

// ─── ⑧ 기본 처리 (UD-9: hasThreadContext draft 필드 divergence 보존) ─────────
describe("⑧ 기본 처리 (draft 생성)", () => {
  it("reaction: draftStore.set 호출, hasThreadContext 필드 포함 (UD-9 보존)", async () => {
    const deps = makeDeps();
    const router = createInquiryRouter(deps);
    const ctx = makeReactionCtx({
      analysis:        { inquiry_type: "일반 문의", title_ja: "テスト", title_ko: "테스트", episode: "1",
                         translated_ko: "내용", summary_ko: "요약", action_required: "조치", priority: "high", source_lang: "ja" },
      hasThreadContext: true,
    });
    await router.routeInquiry(ctx);
    const entries = [...deps.draftStore.values()];
    const draft = entries.find(e => !e.isPending);
    assert.ok(draft, "draft가 draftStore에 있어야 함");
    assert.ok("hasThreadContext" in draft, "reaction draft는 hasThreadContext 필드 포함 (UD-9)");
  });

  it("message: draftStore.set 호출, hasThreadContext 필드 없음 (UD-9 보존)", async () => {
    const deps = makeDeps();
    const router = createInquiryRouter(deps);
    const ctx = makeMessageCtx({
      analysis: { inquiry_type: "일반 문의", title_ja: "テスト", title_ko: "테스트", episode: "1",
                  translated_ko: "내용", summary_ko: "요약", action_required: "조치", priority: "high", source_lang: "ja" },
    });
    await router.routeInquiry(ctx);
    const entries = [...deps.draftStore.values()];
    const draft = entries.find(e => !e.isPending);
    assert.ok(draft, "draft가 draftStore에 있어야 함");
    assert.ok(!("hasThreadContext" in draft), "message draft는 hasThreadContext 필드 없음 (UD-9)");
  });
});

// ─── 두 경로 동작 동등성 + divergence 보존 통합 테스트 ─────────────────────────
describe("두 경로 동작 동등성 통합 테스트", () => {
  it("③ 기타: reaction/message 동일 flow 동일 인자(source 제외)로 호출", async () => {
    const deps1 = makeDeps();
    const deps2 = makeDeps();
    const router1 = createInquiryRouter(deps1);
    const router2 = createInquiryRouter(deps2);

    const analysis = { inquiry_type: "기타", title_ja: "テスト", title_ko: "테스트", episode: "1" };
    const rCtx = makeReactionCtx({ analysis });
    const mCtx = makeMessageCtx({ analysis });

    await router1.routeInquiry(rCtx);
    await router2.routeInquiry(mCtx);

    // 둘 다 postMessage 1회 (5버튼)
    assert.equal(rCtx.client.chat.postMessage.callCount(), 1);
    assert.equal(mCtx.client.chat.postMessage.callCount(), 1);

    // action_id 동일
    const rIds = rCtx.client.chat.postMessage.lastArgs()[0].blocks.find(b => b.type === "actions").elements.map(e => e.action_id);
    const mIds = mCtx.client.chat.postMessage.lastArgs()[0].blocks.find(b => b.type === "actions").elements.map(e => e.action_id);
    assert.deepEqual(rIds, mIds);
  });

  it("UD-1 보존: RETAKE 채널 reaction은 진입, message는 미진입", async () => {
    const deps = makeDeps();
    const router = createInquiryRouter(deps);

    // reaction + RETAKE 채널
    const rCtx = makeReactionCtx({
      sourceMeta: { channelId: "RETAKE_CH1", ts: "100.000" },
      originalText: "단일 리테이크 요청",
    });
    await router.routeInquiry(rCtx);
    assert.equal(deps.flows.handleRetakeInquiry.callCount(), 1);
    deps.flows.handleRetakeInquiry.reset();

    // message + RETAKE 채널 (기타 분기로 처리)
    const deps2 = makeDeps();
    const router2 = createInquiryRouter(deps2);
    const mCtx = makeMessageCtx({
      sourceMeta: { channelId: "RETAKE_CH1", ts: "200.000" },
      analysis:   { inquiry_type: "기타", title_ja: null, title_ko: null },
    });
    deps2.matchWorkTitleWithCandidates = spy(null);
    await router2.routeInquiry(mCtx);
    assert.equal(deps2.flows.handleRetakeInquiry.callCount(), 0, "message RETAKE 채널은 handleRetakeInquiry 미호출 (UD-1 보존)");
  });

  it("UD-7 보존: 수정&리테이크는 reaction만 handleRetakeInquiry 호출", async () => {
    const depsR = makeDeps();
    const depsM = makeDeps();
    depsM.matchWorkTitleWithCandidates = spy(null);

    const rCtx = makeReactionCtx({ analysis: { inquiry_type: "수정&리테이크" } });
    const mCtx = makeMessageCtx({ analysis: { inquiry_type: "수정&리테이크" } });

    await createInquiryRouter(depsR).routeInquiry(rCtx);
    await createInquiryRouter(depsM).routeInquiry(mCtx);

    assert.equal(depsR.flows.handleRetakeInquiry.callCount(), 1, "reaction: handleRetakeInquiry 호출");
    assert.equal(depsM.flows.handleRetakeInquiry.callCount(), 0, "message: handleRetakeInquiry 미호출 (UD-7 보존)");
  });

  it("UD-2 보존: ② 복수 문의 message 경로 reqName='' 빈문자 그대로", async () => {
    const deps = makeDeps();
    const router = createInquiryRouter(deps);
    const ctx = makeMessageCtx({
      analysis:     { inquiry_type: "복수 문의", multi_items: null },
      requesterName: "",
    });
    await router.routeInquiry(ctx);
    // handleMultipleInquiry 6번째 인자(reqName)가 "" 인지 확인
    const callArgs = deps.flows.handleMultipleInquiry.lastArgs();
    assert.equal(callArgs[6], "", "message 복수 문의 reqName은 빈문자 (UD-2 보존)");
  });
});

// ─── 공유 상태 단일 인스턴스 검증 ─────────────────────────────────────────────
describe("공유 상태 단일 인스턴스 검증", () => {
  it("draftStore는 외부에서 주입된 동일 인스턴스 사용", async () => {
    const deps = makeDeps();
    const router = createInquiryRouter(deps);
    const ctx = makeReactionCtx({ analysis: { inquiry_type: "기타", title_ja: "テスト", title_ko: "테스트", episode: "1" } });
    await router.routeInquiry(ctx);
    // draftStore가 router가 내부에서 새로 생성한 것이 아닌 외부 주입 인스턴스인지 확인
    // → deps.draftStore 참조를 통해 접근 가능해야 함
    // (router 내부에서 new Map() 생성 시 이 참조로 접근 불가)
    // ③ 기타는 draftStore.set을 하지 않으므로 ⑧ 기본처리로 테스트
    const deps2 = makeDeps();
    const router2 = createInquiryRouter(deps2);
    const ctx2 = makeReactionCtx({
      analysis: { inquiry_type: "일반 문의", title_ja: "テスト", title_ko: "테스트", episode: "1",
                  translated_ko: "", summary_ko: "", action_required: "", priority: "", source_lang: "ja" },
    });
    await router2.routeInquiry(ctx2);
    assert.ok(deps2.draftStore.size > 0, "외부 draftStore에 draft가 set 되어야 함");
  });
});

// ─── wiring forward 검증 (dead dep 없음 — 선언 심볼 전부 소비) ──────────────
describe("wiring forward 검증", () => {
  it("matchWorkTitleByTokens: 후보 없을 때 토큰 매칭 호출됨", async () => {
    const deps = makeDeps({
      matchWorkTitleWithCandidates: spy(null), // null → 토큰 매칭 시도
      matchWorkTitleByTokens: spy({ single: { koreanProjectName: "토큰매칭작품", chineseOriginalTitle: "令牌作品", pivoId: "p2" } }),
    });
    const router = createInquiryRouter(deps);
    const ctx = makeReactionCtx({ analysis: { inquiry_type: "스케줄 문의", title_ja: "テスト", title_ko: "테스트" } });
    await router.routeInquiry(ctx);
    assert.ok(deps.matchWorkTitleByTokens.callCount() >= 1, "matchWorkTitleByTokens 실제 호출됨");
  });

  it("parseFileInquiry: 원본 파일 확인 분기에서 호출됨", async () => {
    const deps = makeDeps();
    const router = createInquiryRouter(deps);
    const ctx = makeReactionCtx({ analysis: { inquiry_type: "원본 파일 확인", title_ja: "テスト", title_ko: "테스트" } });
    await router.routeInquiry(ctx);
    assert.ok(deps.parseFileInquiry.callCount() >= 1, "parseFileInquiry 실제 호출됨");
  });

  it("fetchDeliveryDate: 스케줄 분기 reaction에서 호출됨", async () => {
    const deps = makeDeps({
      // episode를 포함한 parsed 반환 — fetchDeliveryDate가 호출되려면 episode 필수
      parseScheduleInquiry: spy({ work_title_ja: "テスト", work_title_ko: "테스트", episode: "1" }),
    });
    const router = createInquiryRouter(deps);
    const ctx = makeReactionCtx({ analysis: { inquiry_type: "스케줄 문의", title_ja: "テスト", title_ko: "테스트" } });
    await router.routeInquiry(ctx);
    assert.ok(deps.fetchDeliveryDate.callCount() >= 1, "fetchDeliveryDate 실제 호출됨");
  });
});
