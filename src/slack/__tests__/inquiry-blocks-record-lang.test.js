"use strict";

// 완료 버튼 값에 기록 언어(lang)가 영속되는지 — 완료 클릭이 며칠 뒤에 와도 기록한 탭(한일/공통)을 체크해야 한다.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const createInquiryBlocks = require("../inquiry-blocks");

const blocks = createInquiryBlocks({ pmSlackIdFor: () => "UPM", mentionUserIdsFor: () => ["UPM"] });
const buttonValues = (msg) => msg.blocks.flatMap(b => (b.elements || b.accessory ? [...(b.elements || []), b.accessory].filter(Boolean) : []))
  .filter(e => e.type === "button").map(e => JSON.parse(e.value || "{}"));

describe("완료 버튼 값의 lang — 한일 기록 탭 분리", () => {
  it("문의 본문 완료 버튼에 langPair 가 실린다", () => {
    const msg = blocks.buildFinalMainMessage({ submitterId: "U1", workName: "작품", historyRowIndex: 5, langPair: "ko-ja" });
    const done = buttonValues(msg).find(v => v.historyRowIndex === 5);
    assert.ok(done, "완료 버튼을 못 찾음");
    assert.equal(done.lang, "ko-ja");
  });
  it("재수급 완료 버튼에 draft.lang 이 실린다", () => {
    const msg = blocks.buildFileInquiryMessage({ workName: "작품", episode: "3", lang: "ko-ja", resupplyRowIndex: 9 }, "U1");
    const done = buttonValues(msg).find(v => v.resupplyRowIndex === 9);
    assert.ok(done, "완료 버튼을 못 찾음");
    assert.equal(done.lang, "ko-ja");
  });
  it("문의 완료 버튼에 기록 탭 gid(rg)가 실린다 — 없으면 null", () => {
    const withRg = blocks.buildFinalMainMessage({ submitterId: "U1", workName: "작품", historyRowIndex: 5, langPair: "ko-ja", recordGid: 1179736144 });
    assert.equal(buttonValues(withRg).find(v => v.historyRowIndex === 5).rg, 1179736144);
    const without = blocks.buildFinalMainMessage({ submitterId: "U1", workName: "작품", historyRowIndex: 6, langPair: "ko-ja" });
    assert.equal(buttonValues(without).find(v => v.historyRowIndex === 6).rg, null);
  });
  it("재수급 완료 버튼에 draft.resupplyRecordGid 가 rg 로 실린다", () => {
    const msg = blocks.buildFileInquiryMessage({ workName: "작품", episode: "3", lang: "ko-ja", resupplyRowIndex: 9, resupplyRecordGid: 486785012 }, "U1");
    assert.equal(buttonValues(msg).find(v => v.resupplyRowIndex === 9).rg, 486785012);
  });
});

describe("[P1] 한일 요약 판정 — sourceLang 대소문자·공백", () => {
  for (const sourceLang of ["ko", "KO", " Ko "]) {
    it(`sourceLang=${JSON.stringify(sourceLang)} 이면 한국어로 보고 본문이 요약이다`, () => {
      const thread = blocks.buildThreadMessage({ summary: "요약", inquiryContent: "전문", langPair: "ko-ja", sourceLang });
      assert.match(thread, /전체 내용/);
    });
  }
  it("일본어는 전문 본문(첫 댓글이 요약)", () => {
    const thread = blocks.buildThreadMessage({ summary: "요약", inquiryContent: "전문", langPair: "ko-ja", sourceLang: "ja" });
    assert.match(thread, /\*요약\*/);
  });
});

