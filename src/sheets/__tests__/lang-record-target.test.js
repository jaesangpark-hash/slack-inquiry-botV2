"use strict";

// 기록 대상(gid) — 후속 호출이 「기록한 탭」을 찾아가는지. 게시와 클릭 사이에 설정이 바뀌어도 다른 탭을 건드리지 않아야 한다.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { routeInquiryHistory, routeResupplyRecord, recordTargetFromMeta } = require("../lang-record-router");

const BASE_GID = 268190314;
const KOJA_GID = 1179736144;

function fakeHistory(tag, calls) {
  return {
    appendInquiryHistory: async (draft) => { calls.push([tag, "append", draft.workName]); return 7; },
    updateInquiryHistorySourceLink: async (row) => { calls.push([tag, "link", row]); },
    updateInquiryHistoryPivoId: async (row) => { calls.push([tag, "pivo", row]); },
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
const withKoja = (calls) => routeInquiryHistory({
  base: fakeHistory("base", calls), koja: fakeHistory("koja", calls), baseGid: BASE_GID, kojaGid: KOJA_GID,
});
const withoutKoja = (calls) => routeInquiryHistory({ base: fakeHistory("base", calls), koja: null, baseGid: BASE_GID, kojaGid: null });

describe("lang-record-router — 기록 대상(gid)", () => {
  it("recordGidFor 는 지금 기록하면 쓰게 될 탭의 gid 다", () => {
    const r = withKoja([]);
    assert.equal(r.recordGidFor("ko-ja"), KOJA_GID);
    assert.equal(r.recordGidFor("zh-ja"), BASE_GID);
    assert.equal(r.recordGidFor(null), BASE_GID);
    assert.equal(withoutKoja([]).recordGidFor("ko-ja"), BASE_GID);
  });

  it("기록 대상을 주면 draft 언어와 무관하게 그 탭에 append 한다", async () => {
    const calls = [];
    const r = withKoja(calls);
    await r.appendInquiryHistory({ workName: "A", lang: "ko-ja" }, "U1", { gid: BASE_GID });
    await r.appendInquiryHistory({ workName: "B", lang: "zh-ja" }, "U1", { gid: KOJA_GID });
    assert.deepEqual(calls.map(c => c[0] + ":" + c[2]), ["base:A", "koja:B"]);
  });

  it("[S1] 한일 탭에 기록한 버튼을 한일 분리가 꺼진 뒤 누르면 — 공통 탭을 체크하지 않고 거부한다", async () => {
    const posted = withKoja([]);
    const rg = posted.recordGidFor("ko-ja");                 // 게시 때: 한일 탭
    const calls = [];
    const afterRestart = withoutKoja(calls);                  // 재배포로 설정이 빠짐
    await assert.rejects(
      () => afterRestart.checkInquiryDone(12, recordTargetFromMeta({ rg, lang: "ko-ja" })),
      /기록한 탭\(gid=1179736144\)을 지금 설정에서 찾을 수 없어/,
    );
    assert.deepEqual(calls, [], "공통 탭의 12행을 체크하면 안 된다");
  });

  it("[S1] 공통 탭에 기록한 한일 버튼을 한일 분리가 켜진 뒤 누르면 — 공통 탭을 체크한다", async () => {
    const posted = withoutKoja([]);
    const rg = posted.recordGidFor("ko-ja");                 // 게시 때: 분리 없음 → 공통 탭
    const calls = [];
    const afterEnable = withKoja(calls);                      // 그 뒤 env 를 넣고 재배포
    await afterEnable.checkInquiryDone(12, recordTargetFromMeta({ rg, lang: "ko-ja" }));
    assert.deepEqual(calls, [["base", "done", 12]]);
  });

  it("disableKoja 뒤에는 한일도 공통 탭이고, 한일 gid 기록 대상은 거부된다", async () => {
    const calls = [];
    const r = withKoja(calls);
    r.disableKoja();
    assert.equal(r.kojaEnabled(), false);
    assert.equal(r.recordGidFor("ko-ja"), BASE_GID);
    await r.appendInquiryHistory({ workName: "A", lang: "ko-ja" }, "U1");
    await assert.rejects(() => r.checkInquiryDone(3, { gid: KOJA_GID }));
    assert.deepEqual(calls.map(c => c[0]), ["base"]);
  });

  it("옛 버튼 — rg 없으면 lang 으로, 둘 다 없으면 공통", async () => {
    const calls = [];
    const r = withKoja(calls);
    await r.checkInquiryDone(4, recordTargetFromMeta({ lang: "ko-ja" }));
    await r.checkInquiryDone(5, recordTargetFromMeta({}));
    assert.deepEqual(calls.map(c => c[0] + ":" + c[2]), ["koja:4", "base:5"]);
  });

  it("recordTargetFromMeta 는 rg 를 우선한다", () => {
    assert.deepEqual(recordTargetFromMeta({ rg: 5, lang: "ko-ja" }), { gid: 5 });
    assert.deepEqual(recordTargetFromMeta({ rg: 0 }), { gid: 0 });
    assert.equal(recordTargetFromMeta({ lang: "zh-ja" }), "zh-ja");
    assert.equal(recordTargetFromMeta(null), null);
  });

  it("재수급도 같은 규칙 — 모르는 gid 는 거부", async () => {
    const calls = [];
    const r = routeResupplyRecord({ base: fakeResupply("base", calls), koja: fakeResupply("koja", calls), baseGid: 511152201, kojaGid: 486785012 });
    await r.updateResupplyPivoId(9, "1", { gid: 486785012 });
    await r.checkResupplyDone(9, { gid: 511152201 });
    await assert.rejects(() => r.checkResupplyDone(9, { gid: 123 }));
    assert.deepEqual(calls.map(c => c[0] + ":" + c[1]), ["koja:pivo", "base:done"]);
  });
});
