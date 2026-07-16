"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const createInquiryBlocks = require("../inquiry-blocks.js");

// ── 고정 주입값 ─────────────────────────────────────────────
const PM_SLACK_ID = "UPMTEST001";
const FIXED_MENTION_USER_IDS = ["UMENTIONID1", "UMENTIONID2"];

const blocks = createInquiryBlocks({ pmSlackId: PM_SLACK_ID, fixedMentionUserIds: FIXED_MENTION_USER_IDS });

// ── PRIORITY_EMOJI ──────────────────────────────────────────
describe("PRIORITY_EMOJI", () => {
  it("높음/보통/낮음 이모지 매핑", () => {
    assert.equal(blocks.PRIORITY_EMOJI["높음"], "🔴");
    assert.equal(blocks.PRIORITY_EMOJI["보통"], "🟡");
    assert.equal(blocks.PRIORITY_EMOJI["낮음"], "🟢");
  });
});

// ── buildFileInquiryReason ──────────────────────────────────
describe("buildFileInquiryReason", () => {
  it("작품명+화수+사유 모두 있을 때 조합", () => {
    const result = blocks.buildFileInquiryReason(
      { work_title_ko: "테스트작품", episode: "5", reason_raw: "파일 손상" },
      { koreanProjectName: "매칭작품" }
    );
    assert.equal(result, "매칭작품 5화 파일 손상");
  });

  it("matchedTitle 없으면 fileParsed.work_title_ko 사용", () => {
    const result = blocks.buildFileInquiryReason(
      { work_title_ko: "파싱작품", episode: "3", reason_raw: "누락" },
      null
    );
    assert.equal(result, "파싱작품 3화 누락");
  });

  it("작품명/화수 없고 reason_raw 있을 때 reason만 반환", () => {
    const result = blocks.buildFileInquiryReason(
      { reason_raw: "단순 누락" },
      null
    );
    assert.equal(result, "단순 누락");
  });

  it("모두 없을 때 기본 텍스트 반환", () => {
    const result = blocks.buildFileInquiryReason({}, null);
    assert.equal(result, "원본 재수급 요청");
  });

  it("작품명 있고 reason_raw 없을 때 기본 suffix 붙음", () => {
    const result = blocks.buildFileInquiryReason(
      { work_title_ko: "작품A" },
      null
    );
    assert.equal(result, "작품A 원본 재수급 요청");
  });
});

// ── buildFileInquiryBlocks ──────────────────────────────────
describe("buildFileInquiryBlocks", () => {
  const baseDraft = {
    draftId: "draft_1",
    workName: "테스트 작품",
    episode: "7",
    deliveryDate: "2026-06-01",
    fileNumbers: ["5", "6"],
    reason: "파일 손상",
    apmUserId: "UAPMID",
    apmName: "홍길동",
  };

  it("기본 블록 구조 — section + context + actions 포함", () => {
    const result = blocks.buildFileInquiryBlocks(baseDraft);
    assert.ok(Array.isArray(result));
    const types = result.map(b => b.type);
    assert.ok(types.includes("section"));
    assert.ok(types.includes("actions"));
  });

  it("apmUserId 있을 때 멘션 형식 포함", () => {
    const result = blocks.buildFileInquiryBlocks(baseDraft);
    const sectionText = result.find(b => b.type === "section" && b.text?.text?.includes("APM"))?.text.text;
    assert.ok(sectionText.includes("<@UAPMID>"));
  });

  it("apmUserId 없을 때 미매핑 경고 블록 추가됨", () => {
    const draft = { ...baseDraft, apmUserId: null, apmName: "홍길동" };
    const result = blocks.buildFileInquiryBlocks(draft);
    const warnBlock = result.find(b => b.type === "context" && b.elements?.[0]?.text?.includes("Slack ID를 찾지 못했어"));
    assert.ok(warnBlock, "미매핑 경고 context 블록 존재해야 함");
  });

  it("파일번호 배열을 쉼표 결합", () => {
    const result = blocks.buildFileInquiryBlocks(baseDraft);
    const infoText = result.find(b => b.type === "section" && b.text?.text?.includes("파일/페이지"))?.text.text;
    assert.ok(infoText.includes("5, 6"));
  });

  it("actions에 open_file_inquiry_modal / send_file_inquiry_now 버튼 포함", () => {
    const result = blocks.buildFileInquiryBlocks(baseDraft);
    const actionsBlock = result.find(b => b.type === "actions");
    const actionIds = actionsBlock.elements.map(e => e.action_id);
    assert.ok(actionIds.includes("open_file_inquiry_modal"));
    assert.ok(actionIds.includes("send_file_inquiry_now"));
  });
});

// ── buildFileInquiryMessage ─────────────────────────────────
describe("buildFileInquiryMessage", () => {
  const draft = {
    apmUserId: "UAPMID",
    apmName: "홍길동",
    workName: "테스트 작품",
    episode: "5",
    deliveryDate: "2026-06-01",
    fileNumbers: ["3", "4"],
    reason: "파일 손상",
    originalChannelId: "CORIGID",
    originalTs: "1234567890.000100",
  };
  const submitterId = "USUBMITTER";

  it("text에 pmSlackId 멘션 포함", () => {
    const result = blocks.buildFileInquiryMessage(draft, submitterId);
    assert.ok(result.text.includes(`<@${PM_SLACK_ID}>`));
  });

  it("text에 submitterId 멘션 포함", () => {
    const result = blocks.buildFileInquiryMessage(draft, submitterId);
    assert.ok(result.text.includes(`<@${submitterId}>`));
  });

  it("apmUserId 있으면 apm 멘션 포함", () => {
    const result = blocks.buildFileInquiryMessage(draft, submitterId);
    assert.ok(result.text.includes("<@UAPMID>"));
  });

  it("apmUserId 없고 apmName 있으면 텍스트 이름 사용", () => {
    const d = { ...draft, apmUserId: null };
    const result = blocks.buildFileInquiryMessage(d, submitterId);
    assert.ok(result.text.includes("홍길동"));
    assert.ok(!result.text.includes("<@UAPMID>"));
  });

  it("apmUserId/apmName 모두 없으면 submitter 멘션 폴백", () => {
    const d = { ...draft, apmUserId: null, apmName: null };
    const result = blocks.buildFileInquiryMessage(d, submitterId);
    // submitterId가 두 번 등장 (담당자 + APM 폴백)
    const count = (result.text.match(new RegExp(`<@${submitterId}>`, "g")) || []).length;
    assert.ok(count >= 2);
  });

  it("blocks에 file_resupply_done 버튼 포함", () => {
    const result = blocks.buildFileInquiryMessage(draft, submitterId);
    const actionsBlock = result.blocks.find(b => b.type === "actions");
    const actionIds = actionsBlock.elements.map(e => e.action_id);
    assert.ok(actionIds.includes("file_resupply_done"));
  });
});

// ── buildDraftPreviewBlocks ─────────────────────────────────
describe("buildDraftPreviewBlocks", () => {
  const baseDraft = {
    draftId: "draft_2",
    workName: "작품B",
    workNameKo: "작품B",
    episode: "3",
    deliveryDate: "2026-06-10",
    inquiryType: "번역 문의",
    inquiryContent: "번역 내용",
    summary: "요약 내용",
    actionRequired: "필요 액션",
    sourceLink: "https://example.com",
    hasThreadContext: false,
    sourceLang: "ja",
  };

  it("기본 draft — sections + actions 포함", () => {
    const result = blocks.buildDraftPreviewBlocks(baseDraft);
    const types = result.map(b => b.type);
    assert.ok(types.includes("section"));
    assert.ok(types.includes("actions"));
  });

  it("actions에 open_inquiry_modal / send_inquiry_now 버튼 포함", () => {
    const result = blocks.buildDraftPreviewBlocks(baseDraft);
    const actionsBlock = result.find(b => b.type === "actions");
    const actionIds = actionsBlock.elements.map(e => e.action_id);
    assert.ok(actionIds.includes("open_inquiry_modal"));
    assert.ok(actionIds.includes("send_inquiry_now"));
  });

  it("hasThreadContext=true 시 스레드 맥락 안내 포함", () => {
    const d = { ...baseDraft, hasThreadContext: true };
    const result = blocks.buildDraftPreviewBlocks(d);
    const ctxBlock = result.find(b => b.type === "context" && b.elements?.[0]?.text?.includes("스레드 전체 맥락"));
    assert.ok(ctxBlock, "스레드 맥락 context 블록 존재해야 함");
  });

  it("inquiryType=작업 관련 문의 시 재수급봇 안내 context 추가", () => {
    const d = { ...baseDraft, inquiryType: "작업 관련 문의" };
    const result = blocks.buildDraftPreviewBlocks(d);
    const ctxBlock = result.find(b => b.type === "context" && b.elements?.[0]?.text?.includes("재수급봇"));
    assert.ok(ctxBlock, "재수급봇 유도 context 블록 존재해야 함");
  });

  it("workName === workNameKo 시 괄호 표기 없음", () => {
    const result = blocks.buildDraftPreviewBlocks(baseDraft);
    const header = result.find(b => b.type === "section" && b.text?.text?.includes("작품명"))?.text.text;
    assert.ok(!header.includes("(작품B)"), "동일 workName/workNameKo 시 괄호 중복 없어야 함");
  });

  it("workNameKo !== workName 시 괄호 표기 포함", () => {
    const d = { ...baseDraft, workNameKo: "한국어작품B" };
    const result = blocks.buildDraftPreviewBlocks(d);
    const header = result.find(b => b.type === "section" && b.text?.text?.includes("작품명"))?.text.text;
    assert.ok(header.includes("한국어작품B"), "다른 workNameKo 시 괄호 표기 있어야 함");
  });
});

// ── buildDraftPreviewText ───────────────────────────────────
describe("buildDraftPreviewText", () => {
  const draft = {
    workName: "작품C",
    workNameKo: "작품C",
    episode: "10",
    inquiryType: "스케줄 문의",
    summary: "요약입니다",
    actionRequired: "납품일 확인 요청",
    sourceLink: "https://example.com/link",
  };

  it("주요 필드 모두 포함", () => {
    const result = blocks.buildDraftPreviewText(draft);
    assert.ok(result.includes("작품C"));
    assert.ok(result.includes("10화"));
    assert.ok(result.includes("스케줄 문의"));
    assert.ok(result.includes("요약입니다"));
    assert.ok(result.includes("납품일 확인 요청"));
    assert.ok(result.includes("https://example.com/link"));
  });

  it("빈 draft — 대시(-) 폴백", () => {
    const result = blocks.buildDraftPreviewText({});
    assert.ok(result.includes("-"));
  });
});

// ── buildFinalMainMessage ───────────────────────────────────
describe("buildFinalMainMessage", () => {
  const params = {
    submitterId: "USUBMITTER",
    workName: "작품D",
    workNameKo: "한국D",
    episode: "2",
    inquiryType: "번역 문의",
    inquiryContent: "내용 텍스트",
    actionRequired: "번역 완료 요청",
    draftId: "draft_99",
    historyRowIndex: 31,
    originalChannelId: "C_ORIGINAL",
    originalTs: "111.222",
    sourceLink: "https://slack.example/source",
  };

  it("fixedMentionUserIds 멘션 모두 포함", () => {
    const result = blocks.buildFinalMainMessage(params);
    assert.ok(result.blocks[0].text.text.includes("<@UMENTIONID1>"));
    assert.ok(result.blocks[0].text.text.includes("<@UMENTIONID2>"));
  });

  it("fixedMentionUserIds 빈 배열이면 멘션 없이 빈 문자열", () => {
    const emptyBlocks = createInquiryBlocks({ pmSlackId: PM_SLACK_ID, fixedMentionUserIds: [] });
    const result = emptyBlocks.buildFinalMainMessage(params);
    assert.equal(result.blocks[0].text.text, "");
  });

  it("fallback text — 작품명|유형|담당자 형식", () => {
    const result = blocks.buildFinalMainMessage(params);
    assert.ok(result.text.includes("작품D"));
    assert.ok(result.text.includes("번역 문의"));
    assert.ok(result.text.includes("<@USUBMITTER>"));
  });

  it("inquiry_done 버튼 포함", () => {
    const result = blocks.buildFinalMainMessage(params);
    const actionsBlock = result.blocks.find(b => b.type === "actions");
    assert.ok(actionsBlock);
    const ids = actionsBlock.elements.map(e => e.action_id);
    assert.ok(ids.includes("inquiry_done"));
  });

  it("inquiry_done metadata에 재시작 후 답변에 필요한 원문 맥락을 영속한다", () => {
    const result = blocks.buildFinalMainMessage(params);
    const doneButton = result.blocks
      .flatMap(block => block.elements || [])
      .find(element => element.action_id === "inquiry_done");
    const metadata = JSON.parse(doneButton.value);

    assert.equal(metadata.historyRowIndex, 31);
    assert.equal(metadata.originalChannelId, "C_ORIGINAL");
    assert.equal(metadata.originalTs, "111.222");
    assert.equal(metadata.sourceLink, "https://slack.example/source");
  });
});

// ── buildThreadMessage ──────────────────────────────────────
describe("buildThreadMessage", () => {
  it("요약 + 링크 포함", () => {
    const result = blocks.buildThreadMessage({ summary: "요약 텍스트", sourceLink: "https://link.com" });
    assert.ok(result.includes("요약 텍스트"));
    assert.ok(result.includes("https://link.com"));
  });

  it("summary 없을 때 - 대시 폴백", () => {
    const result = blocks.buildThreadMessage({ sourceLink: "https://link.com" });
    assert.ok(result.includes("-"));
  });
});

// ── buildOtherInquirySummary ────────────────────────────────
describe("buildOtherInquirySummary", () => {
  const analysis = {
    translated_ko: "번역 내용",
    summary_ko: "요약",
    action_required: "봇 소환 필요",
  };

  it("❓ 아이콘 + 유형 미분류 레이블 포함", () => {
    const result = blocks.buildOtherInquirySummary(analysis, {});
    assert.ok(result.includes("❓"));
    assert.ok(result.includes("유형 미분류 문의"));
  });

  it("titleInfo.workName 있을 때 포함", () => {
    const result = blocks.buildOtherInquirySummary(analysis, { workName: "타이틀A", episode: "5" });
    assert.ok(result.includes("타이틀A"));
    assert.ok(result.includes("5화"));
  });

  it("봇 소환 안내 텍스트 포함", () => {
    const result = blocks.buildOtherInquirySummary(analysis, {});
    assert.ok(result.includes("재수급봇"));
    assert.ok(result.includes("스케줄봇"));
  });
});

// ── buildMultipleInquirySummary (dead 후보 — 소비처 0) ─────
describe("buildMultipleInquirySummary", () => {
  const analysis = {
    translated_ko: "복수 번역",
    summary_ko: "복수 요약",
    action_required: "각각 소환",
  };

  it("⚠️ 아이콘 + 복수 문의 감지 레이블 포함", () => {
    const result = blocks.buildMultipleInquirySummary(analysis, {});
    assert.ok(result.includes("⚠️"));
    assert.ok(result.includes("복수 문의 감지"));
  });

  // NOTE: buildMultipleInquirySummary는 app.js에서 소비처 0 (pre-existing dead 후보)
  // 추출은 하되 기존 미사용 코드 삭제는 금지 (별도 작업으로 분리)
});

// ── buildInquirySummaryMessage (내부 공유 헬퍼) ─────────────
describe("buildInquirySummaryMessage", () => {
  it("icon/label/guide 반영된 결과 반환", () => {
    const analysis = { translated_ko: "T", summary_ko: "S", action_required: "A" };
    const result = blocks.buildInquirySummaryMessage(analysis, { icon: "⭐", label: "테스트", guide: "가이드 안내" });
    assert.ok(result.includes("⭐"));
    assert.ok(result.includes("테스트"));
    assert.ok(result.includes("가이드 안내"));
  });

  it("titleInfo 없을 때 작품명/회차 라인 없음", () => {
    const analysis = { translated_ko: "T", summary_ko: "S", action_required: "A" };
    const result = blocks.buildInquirySummaryMessage(analysis, { icon: "⭐", label: "X", guide: "Y" }, {});
    assert.ok(!result.includes("작품명"));
    assert.ok(!result.includes("회차"));
  });
});
