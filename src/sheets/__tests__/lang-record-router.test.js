"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { routeInquiryHistory, routeResupplyRecord } = require("../lang-record-router");

// 호출을 기록하는 가짜 기록 모듈 — 어느 탭(base/koja)으로 갔는지만 본다
function fakeHistory(tag, calls) {
  return {
    appendInquiryHistory: async (draft) => { calls.push([tag, "append", draft.workName]); return 7; },
    updateInquiryHistorySourceLink: async (row, link) => { calls.push([tag, "link", row, link]); },
    updateInquiryHistoryPivoId: async (row, pivo) => { calls.push([tag, "pivo", row, pivo]); },
    checkInquiryDone: async (row) => { calls.push([tag, "done", row]); },
  };
}
function fakeResupply(tag, calls) {
  return {
    appendResupplyRecord: async (draft) => { calls.push([tag, "append", draft.workName]); return 9; },
    updateResupplySourceLink: async (row) => { calls.push([tag, "link", row]); },
    updateResupplyPivoId: async (row) => { calls.push([tag, "pivo", row]); },
    checkResupplyDone: async (row) => { calls.push([tag, "done", row]); },
  };
}

describe("lang-record-router — 한일 기록 탭 분리", () => {
  it("한일(ko-ja) 문의는 한일 탭, 중일·미상은 공통 탭에 append 한다", async () => {
    const calls = [];
    const r = routeInquiryHistory({ base: fakeHistory("base", calls), koja: fakeHistory("koja", calls) });
    assert.equal(await r.appendInquiryHistory({ workName: "A", lang: "ko-ja" }, "U1"), 7);
    await r.appendInquiryHistory({ workName: "B", lang: "zh-ja" }, "U1");
    await r.appendInquiryHistory({ workName: "C" }, "U1");
    await r.appendInquiryHistory({ workName: "D", langPair: "ko-ja" }, "U1");   // lang 없고 langPair 만 있어도
    assert.deepEqual(calls.map(c => c[0] + ":" + c[2]), ["koja:A", "base:B", "base:C", "koja:D"]);
  });

  it("후속 호출(링크·PIVO·완료)은 넘긴 lang 의 탭으로 간다 — lang 없으면 공통(배포 전 메시지)", async () => {
    const calls = [];
    const r = routeInquiryHistory({ base: fakeHistory("base", calls), koja: fakeHistory("koja", calls) });
    await r.updateInquiryHistorySourceLink(5, "L", "ko-ja");
    await r.updateInquiryHistoryPivoId(5, "123", "ko-ja");
    await r.checkInquiryDone(5, "ko-ja");
    await r.checkInquiryDone(6);
    assert.deepEqual(calls.map(c => c[0] + ":" + c[1]), ["koja:link", "koja:pivo", "koja:done", "base:done"]);
  });

  it("한일 탭 미설정(koja=null)이면 한일도 공통 탭 — 종전 동작", async () => {
    const calls = [];
    const r = routeResupplyRecord({ base: fakeResupply("base", calls), koja: null });
    await r.appendResupplyRecord({ workName: "A", lang: "ko-ja" }, "U1", {});
    await r.checkResupplyDone(3, "ko-ja");
    assert.deepEqual(calls.map(c => c[0]), ["base", "base"]);
    assert.equal(r.targetOf("ko-ja"), "base");
  });

  it("재수급도 같은 규칙으로 갈린다", async () => {
    const calls = [];
    const r = routeResupplyRecord({ base: fakeResupply("base", calls), koja: fakeResupply("koja", calls) });
    assert.equal(await r.appendResupplyRecord({ workName: "A", lang: "ko-ja" }, "U1", {}), 9);
    await r.updateResupplyPivoId(9, "1", "ko-ja");
    await r.checkResupplyDone(9, "zh-ja");
    assert.deepEqual(calls.map(c => c[0] + ":" + c[1]), ["koja:append", "koja:pivo", "base:done"]);
    assert.equal(r.targetOf("ko-ja"), "koja");
  });
});
