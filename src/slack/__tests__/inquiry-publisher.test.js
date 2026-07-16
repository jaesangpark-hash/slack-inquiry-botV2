"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const createInquiryPublisher = require("../inquiry-publisher");

function makePublisher({ appendInquiryHistory }) {
  const draftStore = new Map();
  const postInquiry = createInquiryPublisher({
    appendInquiryHistory,
    draftStore,
    buildFinalMainMessage: metadata => ({ text: "main", metadata }),
    buildThreadMessage: () => "thread",
    targetChannelId: "C_PM",
  });
  return { draftStore, postInquiry };
}

function makeClient() {
  const calls = [];
  return {
    calls,
    chat: {
      postMessage: async payload => {
        calls.push(payload);
        return { ts: "posted-ts" };
      },
    },
  };
}

describe("inquiry publisher sheet-first contract", () => {
  test("시트 행을 확정한 뒤 PM 본문과 스레드를 게시한다", async () => {
    const { draftStore, postInquiry } = makePublisher({ appendInquiryHistory: async () => 12 });
    const client = makeClient();
    await postInquiry(client, { draftId: "d1", dmChannelId: "D1" }, "U1");

    assert.equal(client.calls.filter(call => call.channel === "C_PM").length, 2);
    assert.equal(draftStore.get("d1").historyRowIndex, 12);
    assert.equal(client.calls[0].metadata.historyRowIndex, 12);
  });

  test("시트 append가 실패하면 PM 채널에 아무것도 게시하지 않는다", async () => {
    const { postInquiry } = makePublisher({
      appendInquiryHistory: async () => { throw new Error("sheet unavailable"); },
    });
    const client = makeClient();

    await assert.rejects(
      () => postInquiry(client, { draftId: "d1", dmChannelId: "D1" }, "U1"),
      /sheet unavailable/
    );
    assert.equal(client.calls.filter(call => call.channel === "C_PM").length, 0);
  });

  test("시트가 유효한 행 번호를 반환하지 않아도 PM 게시를 중단한다", async () => {
    const { postInquiry } = makePublisher({ appendInquiryHistory: async () => null });
    const client = makeClient();

    await assert.rejects(
      () => postInquiry(client, { draftId: "d1", dmChannelId: "D1" }, "U1"),
      /시트 행 번호/
    );
    assert.equal(client.calls.filter(call => call.channel === "C_PM").length, 0);
  });

  test("main 게시 결과가 불명확하면 review_required로 고정하고 row/main을 다시 만들지 않는다", async () => {
    let appendCalls = 0;
    let mainCalls = 0;
    const { draftStore, postInquiry } = makePublisher({
      appendInquiryHistory: async () => { appendCalls++; return 20; },
    });
    const client = {
      chat: {
        postMessage: async payload => {
          if (payload.channel === "C_PM" && !payload.thread_ts) {
            mainCalls++;
            throw new Error("main response lost");
          }
          return { ts: "notice-ts" };
        },
      },
    };
    const draft = { draftId: "d-main-unknown", dmChannelId: "D1" };

    await assert.rejects(() => postInquiry(client, draft, "U1"), /main 메시지 게시 결과/);
    await postInquiry(client, draft, "U1");

    assert.equal(appendCalls, 1);
    assert.equal(mainCalls, 1);
    assert.equal(draftStore.get("inquiry_publication:d-main-unknown").status, "review_required");
  });

  test("thread 응답 유실은 review_required이고 확인된 row/main에서 blind retry하지 않는다", async () => {
    let appendCalls = 0;
    let mainCalls = 0;
    let threadCalls = 0;
    const { draftStore, postInquiry } = makePublisher({
      appendInquiryHistory: async () => { appendCalls++; return 21; },
    });
    const client = {
      chat: {
        postMessage: async payload => {
          if (payload.channel === "C_PM" && !payload.thread_ts) {
            mainCalls++;
            return { ts: "main-21" };
          }
          if (payload.channel === "C_PM" && payload.thread_ts) {
            threadCalls++;
            throw new Error("thread response lost");
          }
          return { ts: "notice-ts" };
        },
      },
    };
    const draft = { draftId: "d-thread-retry", dmChannelId: "D1" };

    await assert.rejects(() => postInquiry(client, draft, "U1"), /thread 메시지/);
    const replay = await postInquiry(client, draft, "U1");

    const state = draftStore.get("inquiry_publication:d-thread-retry");
    assert.equal(state.status, "review_required");
    assert.equal(replay.publicationStatus, "review_required");
    assert.equal(state.sheetRowIndex, 21);
    assert.equal(state.mainMessageTs, "main-21");
    assert.equal(appendCalls, 1);
    assert.equal(mainCalls, 1);
    assert.equal(threadCalls, 1);
  });

  test("완료 DM 응답 유실도 review_required이고 row/main/thread/DM을 중복하지 않는다", async () => {
    let appendCalls = 0;
    let mainCalls = 0;
    let threadCalls = 0;
    let completionNoticeAttempts = 0;
    const { draftStore, postInquiry } = makePublisher({
      appendInquiryHistory: async () => { appendCalls++; return 22; },
    });
    const client = {
      chat: {
        postMessage: async payload => {
          if (payload.channel === "C_PM" && !payload.thread_ts) {
            mainCalls++;
            return { ts: "main-22" };
          }
          if (payload.channel === "C_PM" && payload.thread_ts) {
            threadCalls++;
            return { ts: "thread-22" };
          }
          if (payload.text === "전송 완료") {
            completionNoticeAttempts++;
            throw new Error("DM response lost");
          }
          return { ts: "dm-ts" };
        },
      },
    };
    const draft = { draftId: "d-notice-retry", dmChannelId: "D1" };

    await assert.rejects(
      () => postInquiry(client, draft, "U1", { completionNoticeText: "전송 완료" }),
      /완료 안내/
    );
    const replay = await postInquiry(client, draft, "U1", { completionNoticeText: "전송 완료" });

    assert.equal(draftStore.get("inquiry_publication:d-notice-retry").status, "review_required");
    assert.equal(replay.publicationStatus, "review_required");
    assert.equal(appendCalls, 1);
    assert.equal(mainCalls, 1);
    assert.equal(threadCalls, 1);
    assert.equal(completionNoticeAttempts, 1);
  });

  test("전송된 draft의 같은 intent replay와 변경 intent를 구분하고 변경본은 외부 호출하지 않는다", async () => {
    let appendCalls = 0;
    const { postInquiry } = makePublisher({
      appendInquiryHistory: async () => { appendCalls++; return 24; },
    });
    const client = makeClient();
    const originalDraft = {
      draftId: "d-intent",
      dmChannelId: "D1",
      workName: "원본 작품",
      inquiryContent: "최초 내용",
      actionRequired: "확인",
    };

    const sent = await postInquiry(client, originalDraft, "U1");
    const sameReplay = await postInquiry(client, { ...originalDraft }, "U1");
    const changedReplay = await postInquiry(client, {
      ...originalDraft,
      inquiryContent: "이미 전송된 뒤 바뀐 내용",
    }, "U1");

    assert.equal(sent.publicationStatus, "sent");
    assert.equal(sameReplay.replay, true);
    assert.equal(sameReplay.intentConflict, false);
    assert.equal(changedReplay.intentConflict, true);
    assert.equal(appendCalls, 1);
    assert.equal(client.calls.filter(call => call.channel === "C_PM").length, 2);
  });

  test("동시 전송은 append와 main 게시를 각각 한 번만 실행한다", async () => {
    let resolveAppend;
    const appendResult = new Promise(resolve => { resolveAppend = resolve; });
    let appendCalls = 0;
    let mainCalls = 0;
    const { postInquiry } = makePublisher({
      appendInquiryHistory: async () => { appendCalls++; return appendResult; },
    });
    const client = {
      chat: {
        postMessage: async payload => {
          if (payload.channel === "C_PM" && !payload.thread_ts) mainCalls++;
          return { ts: payload.thread_ts ? "thread-ts" : "main-ts" };
        },
      },
    };
    const draft = { draftId: "d-concurrent", dmChannelId: "D1" };

    const first = postInquiry(client, draft, "U1");
    await postInquiry(client, draft, "U1");
    resolveAppend(23);
    await first;

    assert.equal(appendCalls, 1);
    assert.equal(mainCalls, 1);
  });
});
