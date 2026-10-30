"use strict";
/**
 * 초안 = 실제 보내는 것 — 회귀 시험 (재상 님 실측 보고 2026-10-29)
 *
 * 종전엔 초안과 최종 메시지가 각자 레이아웃을 들고 있어 서로 어긋났다.
 * 특히 스레드 맥락 건은 초안에 「문의 내용」이 아예 없는데 채널엔 스레드 전문이 통째로 나갔다 —
 * APM 이 보지 못한 글이 고객사·PM 이 보는 채널에 올라간 것이다.
 *
 * 이제 초안은 최종 빌더로 그린다. 레이아웃이 갈라지면 이 시험이 깨진다.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const createInquiryBlocks = require("../inquiry-blocks");

const blocks = createInquiryBlocks({
  pmSlackIdFor: () => "U_PM",
  mentionUserIdsFor: () => ["U_APM"],
});

const draftOf = (over = {}) => ({
  draftId: "d1",
  ownerUserId: "U_SUBMITTER",
  workName: "피폐물 주인공의 부인이 되었습니다",
  workNameKo: "피폐물 주인공의 부인이 되었습니다",
  workNameJaFixed: "冷血皇子と捨てられた王女",
  workNameJaDisplay: "冷血皇子と捨てられた王女",
  workNameZh: "피폐물 주인공의 부인이 되었습니다",
  lang: "ko-ja",
  episode: "42",
  deliveryDate: "2026-11-07",
  inquiryType: "번역문 확인",
  inquiryContent: "본문 전체 내용입니다. 스레드 맥락이면 여기가 스레드 전문이 된다.",
  summary: "42화 3번 컷 대사가 원고와 다르니 확인 요청",
  actionRequired: "원고 대조 후 번역가에게 회신",
  sourceLink: "https://slack.com/archives/C1/p1",
  ...over,
});

// 최종 메시지는 publisher 가 draft 에서 뽑아 넘기는 그대로 만든다.
const sentFrom = (draft) => blocks.buildFinalMainMessage({
  submitterId: draft.ownerUserId,
  workName: draft.workName, workNameKo: draft.workNameKo,
  workNameJaFixed: draft.workNameJaFixed, workNameJaDisplay: draft.workNameJaDisplay,
  workNameZh: draft.workNameZh,
  episode: draft.episode, deliveryDate: draft.deliveryDate,
  inquiryType: draft.inquiryType, inquiryContent: draft.inquiryContent,
  summary: draft.summary, hasThreadContext: draft.hasThreadContext === true,
  actionRequired: draft.actionRequired, draftId: draft.draftId, historyRowIndex: 1,
  originalChannelId: "C1", originalTs: "1.1", sourceLink: draft.sourceLink,
  langPair: draft.lang || null,
});

/** 버튼을 뺀 본문 블록만 글로 뽑는다 — 초안과 최종을 글자 단위로 맞대본다. */
const bodyText = (blks) => JSON.stringify(
  blks.filter(b => b.type !== "actions").map(b => b.fields ? b.fields.map(f => f.text) : b.text?.text ?? b.elements?.map(e => e.text))
);

describe("초안과 실제 전송 내용이 같다", () => {
  for (const threaded of [false, true]) {
    test(`스레드 맥락 ${threaded ? "있음" : "없음"} — 본문이 글자까지 같다`, () => {
      const draft = draftOf(threaded ? { hasThreadContext: true } : {});
      const preview = blocks.buildDraftPreviewBlocks(draft);
      const sent    = sentFrom(draft);

      // 초안은 머리글 1줄 + (최종 본문) + 첫 댓글 미리보기 로 구성된다.
      // 가운데 토막이 최종 본문과 **글자까지** 같아야 한다.
      const previewBody = preview.slice(1, 1 + sent.blocks.filter(b => b.type !== "actions").length);
      assert.equal(bodyText(previewBody), bodyText(sent.blocks));
    });
  }

  // ★이게 실제로 터졌던 건이다.
  test("스레드 맥락 건은 본문에 요약이 가고 전문은 첫 댓글로 — 채널에 덤프가 안 올라간다", () => {
    const draft = draftOf({ hasThreadContext: true });
    const sent = sentFrom(draft);
    const body = JSON.stringify(sent.blocks);
    assert.ok(body.includes(draft.summary), "본문에 요약이 없다");
    assert.ok(!body.includes(draft.inquiryContent), "본문에 스레드 전문이 통째로 들어갔다");

    const thread = blocks.buildThreadMessage({
      summary: draft.summary, sourceLink: draft.sourceLink,
      inquiryContent: draft.inquiryContent, hasThreadContext: true,
    });
    assert.ok(thread.includes(draft.inquiryContent), "첫 댓글에 전문이 없다 — 정보가 사라진다");
    assert.ok(thread.includes(draft.sourceLink));
  });

  test("스레드 맥락이 아니면 종전대로 본문이 문의 내용, 첫 댓글이 요약", () => {
    const draft = draftOf();
    assert.ok(JSON.stringify(sentFrom(draft).blocks).includes(draft.inquiryContent));
    const thread = blocks.buildThreadMessage({
      summary: draft.summary, sourceLink: draft.sourceLink,
      inquiryContent: draft.inquiryContent, hasThreadContext: false,
    });
    assert.ok(thread.includes(draft.summary));
  });

  test("요약이 비면 전문으로 떨어진다 — 본문이 빈 칸으로 나가지 않게", () => {
    const draft = draftOf({ hasThreadContext: true, summary: "" });
    assert.ok(JSON.stringify(sentFrom(draft).blocks).includes(draft.inquiryContent));
  });

  test("초안에도 작품명 보조줄이 보인다 — 전송 전에 고객사용 타이틀을 확인할 수 있어야 한다", () => {
    const preview = JSON.stringify(blocks.buildDraftPreviewBlocks(draftOf()));
    assert.ok(preview.includes("고객사용"), preview.slice(0, 300));
  });

  test("초안에 전송 버튼이 그대로 있다", () => {
    const ids = blocks.buildDraftPreviewBlocks(draftOf())
      .find(b => b.type === "actions").elements.map(e => e.action_id);
    assert.deepEqual(ids, ["open_inquiry_modal", "send_inquiry_now"]);
  });
});
