"use strict";

// 게시자가 기록 탭(gid)을 게시 전에 한 번 정해 기록·버튼·후속 갱신·체크포인트에 같이 싣는지(AIA 리뷰 S1·P2).
const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const createInquiryPublisher = require("../inquiry-publisher");
const { createLangRouting } = require("../../config/lang-routing");

const langRouting = createLangRouting({
  base: { target: "C_PROD", pmRequest: "C_PMREQ", schedule: "C_SCHED", mentionUserIds: ["U_ZH"], pmSlackId: "U_PM" },
  overrides: {},
});

function makePublisher(recordGidFor) {
  const calls = [];
  const store = new Map();
  const postInquiry = createInquiryPublisher({
    appendInquiryHistory: async (draft, submitterId, target) => { calls.push(["append", target]); return 7; },
    updateInquiryHistorySourceLink: async (row, link, target) => { calls.push(["link", target]); },
    updateInquiryHistoryPivoId: async (row, pivo, target) => { calls.push(["pivo", target]); },
    inquiryRecordGidFor: recordGidFor,
    draftStore: store,
    buildFinalMainMessage: ({ recordGid }) => { calls.push(["button", recordGid]); return { text: "main" }; },
    buildThreadMessage: () => "thread",
    langRouting,
  });
  const client = {
    chat: {
      postMessage: async () => ({ ts: "ts1" }),
      getPermalink: async () => ({ permalink: "https://slack.com/archives/C/p1" }),
    },
  };
  return { calls, store, postInquiry, client };
}

describe("문의 게시 — 기록 대상(gid)", () => {
  test("기록·버튼·링크·PIVO 가 같은 gid 를 쓴다", async () => {
    const { calls, postInquiry, client } = makePublisher(lang => (lang === "ko-ja" ? 111 : 222));
    await postInquiry(client, { draftId: "d1", lang: "ko-ja", pivoId: "P1", dmChannelId: "D1" }, "U1");
    assert.deepEqual(calls, [
      ["append", { gid: 111 }], ["button", 111], ["link", { gid: 111 }], ["pivo", { gid: 111 }],
    ]);
  });

  test("체크포인트 의도에 기록 gid 가 들어간다 — 재시도 사이 설정이 바뀌면 충돌로 멈춘다", async () => {
    const { store, postInquiry, client } = makePublisher(() => 111);
    await postInquiry(client, { draftId: "d2", lang: "ko-ja", dmChannelId: "D1" }, "U1");
    const state = store.get("inquiry_publication:d2");
    assert.equal(state.intentSnapshot.recordGid, 111);
  });

  test("gid 함수가 없으면 종전처럼 언어로 고른다(옛 조립·시험 호환)", async () => {
    const { calls, postInquiry, client } = makePublisher(null);
    await postInquiry(client, { draftId: "d3", lang: "ko-ja", dmChannelId: "D1" }, "U1");
    assert.deepEqual(calls.slice(0, 2), [["append", "ko-ja"], ["button", null]]);
  });
});
