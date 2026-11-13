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
});
