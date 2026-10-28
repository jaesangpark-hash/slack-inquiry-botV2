"use strict";
/**
 * inquiry-router.js — 한일(ko-ja) 배선 테스트
 *
 * node:test + node:assert 빌트인 사용 (신규 dep 추가 금지).
 * inquiry-router.test.js 의 spy/deps/ctx 패턴을 그대로 따른다(하네스 중복을 줄이려 최소 복제).
 *
 * 검증 항목 (AIA 리뷰 T1·T3):
 *   T3 소환 이모지의 langPair 가 ctx → routeInquiry → 매처까지 간다
 *      - matchWorkTitleWithCandidates(ja, ko, pivoId, langPair) 4번째 인자
 *      - matchWorkTitleFromSheet({ ..., langPair }) 객체 인자
 *      - 메시지(DM 링크) 경로는 신호가 없으므로 null
 *   T1 납품 탭은 **확정된 마스터 행의 lang** 으로 고른다 (이모지가 아니라)
 *      - 한일 행 → fetchDeliveryDate 3번째 인자 "ko-ja"
 *      - 중일 행 → "zh-ja" (기존 동작 불변)
 *      - 이모지가 중일이어도 작품이 한일이면 한일 탭 (이모지는 우선순위일 뿐)
 *
 * fixture self-fulfilling 금지:
 *   기대값을 호출부에서 베끼지 않고, "마스터 행에 실린 lang" 과 "실제로 넘어간 인자"가
 *   일치하는지로 본다. 이모지와 행의 lang 을 일부러 엇갈리게 둔 케이스를 포함한다.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const createInquiryRouter = require("../inquiry-router");

function spy(returnValue) {
  const calls = [];
  const fn = async (...args) => {
    calls.push(args);
    return typeof returnValue === "function" ? returnValue(...args) : returnValue;
  };
  fn.calls = calls;
  fn.lastArgs = () => calls[calls.length - 1];
  return fn;
}
const noopSpy = () => spy(undefined);

const ZH_ROW = { koreanProjectName: "중일작품", chineseOriginalTitle: "中日作品", japaneseFixedTitle: "テスト", pivoId: "101", lang: "zh-ja" };
const KO_ROW = { koreanProjectName: "한일작품", chineseOriginalTitle: "한일작품", japaneseFixedTitle: "テスト", pivoId: "201", lang: "ko-ja" };

function makeDeps(row = ZH_ROW, overrides = {}) {
  return {
    parseScheduleInquiry: spy({ work_title_ja: "テスト", work_title_ko: "테스트" }),
    parseFileInquiry: spy({ work_title_ja: "テスト", work_title_ko: "테스트", episode: "1", file_numbers: [1], reason_raw: "" }),
    matchWorkTitleWithCandidates: spy({ single: row }),
    matchWorkTitleFromSheet: spy(row),
    matchWorkTitleByTokens: spy({ single: row }),
    fetchDeliveryDate: spy({ episodeLabel: "1화", allSame: true, deliveryDate: "2026-06-01", episodes: [] }),
    generateDraftId: spy("draft_test_001"),
    draftStore: new Map(),
    buildFileInquiryBlocks: spy([]),
    buildFileInquiryReason: spy("reason"),
    buildDraftPreviewBlocks: spy([]),
    buildDraftPreviewText: spy("preview"),
    buildOtherInquirySummary: spy("other-summary"),
    buildProgressText: spy("progress"),
    flows: {
      handleScheduleExt: noopSpy(), handleMultipleInquiry: noopSpy(),
      handleWorkerRelay: noopSpy(), handleRetakeInquiry: noopSpy(), handleFileOrderInquiry: noopSpy(),
    },
    retakeChannels: new Set(["RETAKE_CH1"]),
    analyzeInquiryWithAI: spy({ title_ja: "テスト", title_ko: "테스트", episode: "1" }),
    ...overrides,
  };
}

function makeCtx(overrides = {}) {
  const client = {
    chat: { update: noopSpy(), postMessage: noopSpy(), postEphemeral: noopSpy() },
    users: { info: spy({ user: { profile: { display_name: "테스터" }, real_name: "테스터" } }) },
    conversations: { open: spy({ channel: { id: "DM_CH" } }) },
  };
  return {
    source: "reaction", client, dmChannel: "DM_CH", progressMsg: { ts: "100.000" },
    // "기타"는 3번 분기에서 조기 반환돼 납품 조회까지 안 간다. 8번 기본 처리로 떨어지는 유형을 쓴다.
    analysis: { inquiry_type: "작업 관련 문의", title_ja: "テスト", title_ko: "테스트", episode: "1" },
    originalText: "테스트 원문", hasThreadContext: false, threadContextText: "",
    sourceLink: "https://slack.com/archives/CH/p100000",
    sourceMeta: { channelId: "GENERAL_CH", ts: "100.000" },
    files: [], requesterUserId: "U_REQUESTER", requesterName: "", userId: "U_OWNER",
    ...overrides,
  };
}

describe("T3 소환 이모지의 langPair 가 매처까지 간다", () => {
  it("한일 이모지 → matchWorkTitleWithCandidates 4번째 인자 ko-ja", async () => {
    const deps = makeDeps(KO_ROW);
    await createInquiryRouter(deps).routeInquiry(makeCtx({ langPair: "ko-ja" }));
    assert.equal(deps.matchWorkTitleWithCandidates.lastArgs()[3], "ko-ja");
  });

  it("중일 이모지 → zh-ja", async () => {
    const deps = makeDeps(ZH_ROW);
    await createInquiryRouter(deps).routeInquiry(makeCtx({ langPair: "zh-ja" }));
    assert.equal(deps.matchWorkTitleWithCandidates.lastArgs()[3], "zh-ja");
  });

  it("DM 링크 소환은 신호가 없어 null — 양쪽을 다 뒤진다", async () => {
    const deps = makeDeps(ZH_ROW);
    await createInquiryRouter(deps).routeInquiry(makeCtx({ source: "message", langPair: undefined }));
    assert.equal(deps.matchWorkTitleWithCandidates.lastArgs()[3], null);
  });

  it("파일 문의 경로는 객체 인자로 langPair 를 받는다", async () => {
    const deps = makeDeps(KO_ROW);
    await createInquiryRouter(deps).routeInquiry(makeCtx({
      langPair: "ko-ja",
      analysis: { inquiry_type: "원본 파일 확인", title_ja: "テスト", title_ko: "테스트", episode: "1" },
    }));
    const call = deps.matchWorkTitleFromSheet.calls.find(a => a[0] && typeof a[0] === "object");
    assert.ok(call, "객체 인자 호출이 있어야 한다");
    assert.equal(call[0].langPair, "ko-ja");
  });
});

describe("T1 납품 탭은 확정된 작품의 lang 으로 고른다", () => {
  const langOf = (deps) => deps.fetchDeliveryDate.lastArgs()?.[2];

  it("한일 행 → ko-ja", async () => {
    const deps = makeDeps(KO_ROW);
    await createInquiryRouter(deps).routeInquiry(makeCtx({ langPair: "ko-ja" }));
    assert.equal(langOf(deps), "ko-ja");
  });

  it("중일 행 → zh-ja (기존 동작 불변)", async () => {
    const deps = makeDeps(ZH_ROW);
    await createInquiryRouter(deps).routeInquiry(makeCtx({ langPair: "zh-ja" }));
    assert.equal(langOf(deps), "zh-ja");
  });

  it("탭은 이모지가 아니라 확정된 행이 고른다 — PIVO 로 푼 반대 언어 작품도 맞게 나온다", async () => {
    // 하드 필터는 제목 매칭에만 걸리고 PIVO 조회는 거르지 않는다. 중일 이모지 상태에서
    // 한일 작품이 확정되는 경로가 실제로 있으므로, 탭은 행의 lang 을 따라야 한다.
    const deps = makeDeps(KO_ROW);
    await createInquiryRouter(deps).routeInquiry(makeCtx({ langPair: "zh-ja" }));
    assert.equal(langOf(deps), "ko-ja");
  });

  it("lang 이 없는 행(수동 입력 등)은 zh-ja 로 떨어진다", async () => {
    const deps = makeDeps({ koreanProjectName: "이름만", pivoId: "301" });
    await createInquiryRouter(deps).routeInquiry(makeCtx({ langPair: "ko-ja" }));
    assert.equal(langOf(deps), "zh-ja");
  });
});

describe("하드 필터 - 반대 언어에 있으면 짚어 준다", () => {
  const KO_HIT = { koreanProjectName: "한일작품", pivoId: "201", lang: "ko-ja" };

  it("wrongLang 이면 후보로 올리고 어느 이모지인지 알려 준다", async () => {
    const posted = [];
    const deps = makeDeps(null, { matchWorkTitleWithCandidates: spy({ wrongLang: [KO_HIT] }) });
    const ctx = makeCtx({ langPair: "zh-ja" });
    ctx.client.chat.postMessage = async (a) => { posted.push(a); return {}; };
    const updates = [];
    ctx.client.chat.update = async (a) => { updates.push(a); return {}; };

    await createInquiryRouter(deps).routeInquiry(ctx);

    assert.ok(updates.some(u => /한일 작품/.test(u.text)), "어느 언어 작품인지 말해야 한다");
    assert.ok(updates.some(u => /한일문의봇소환/.test(u.text)), "다시 찍을 이모지를 알려야 한다");
    const withButtons = posted.find(m => Array.isArray(m.blocks) && m.blocks.some(b => b.type === "actions"));
    assert.ok(withButtons, "후보 버튼을 올려야 한다");
    const ids = withButtons.blocks.find(b => b.type === "actions").elements.map(e => e.action_id);
    assert.ok(ids.includes("open_pivo_id_modal"), "PIVO 입력 구멍은 항상 있어야 한다");
  });

  it("흐름 모듈에도 langPair 가 넘어간다 - 하드 필터라 안 넘기면 라우터와 갈린다", async () => {
    const deps = makeDeps(ZH_ROW);
    await createInquiryRouter(deps).routeInquiry(makeCtx({
      langPair: "ko-ja",
      analysis: { inquiry_type: "원본 파일 순서", title_ja: "テスト", title_ko: "테스트", episode: "1" },
    }));
    const args = deps.flows.handleFileOrderInquiry.lastArgs();
    assert.equal(args[args.length - 1], "ko-ja", "마지막 인자로 langPair 가 가야 한다");
  });
});
