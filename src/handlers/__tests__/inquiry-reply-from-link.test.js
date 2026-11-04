"use strict";
/**
 * 「답변 작성」이 원문 스레드를 찾는가 — 링크만 들고 온 초안 (재상 님 실측 2026-11-04)
 *
 * 증상: 「기타」 → 「문의봇」 버튼으로 만든 문의의 완료 후 「답변 작성」이 움직이지 않았다.
 *   실제 버튼 값: {"originalChannelId":null,"originalTs":null,"sourceLink":null,"submitterId":"U05CE8HFA6B"}
 * 원인: direct_inquiry_modal 초안이 원문 링크만 갖고 채널·ts 를 비워 뒀다. 답글은 채널·ts 로 단다.
 *
 * 검증:
 *   - 링크 → 채널·부모 ts 풀이(스레드 댓글 링크는 thread_ts 쪽)
 *   - 직접 입력 초안에 좌표가 실린다
 *   - 완료 버튼이 링크만 있어도 답변 버튼 값에 좌표를 싣는다
 *   - 이미 게시된 「다 빈」 버튼도 문의 스레드의 「원문 링크」에서 되찾아 답글을 단다
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { replyTargetFromLink } = require("../../slack/text")();
const registerDirectInputActions = require("../direct-input-actions");

describe("replyTargetFromLink", () => {
  it("일반 메시지 링크 → 그 메시지 ts", () => {
    assert.deepEqual(replyTargetFromLink("https://jamake.slack.com/archives/C0695QCJ0TF/p1793690000123456"),
      { channelId: "C0695QCJ0TF", ts: "1793690000.123456" });
  });
  it("스레드 댓글 링크 → 부모 thread_ts", () => {
    assert.deepEqual(replyTargetFromLink("https://jamake.slack.com/archives/C09B8QHP7D4/p1793762827018439?thread_ts=1793690252.686139&cid=C09B8QHP7D4"),
      { channelId: "C09B8QHP7D4", ts: "1793690252.686139" });
  });
  it("Slack 마크업 안의 링크도 푼다", () => {
    assert.deepEqual(replyTargetFromLink(":link: *원문 링크*\n<https://slack.com/archives/C0695QCJ0TF/p1793690000123456|원문>"),
      { channelId: "C0695QCJ0TF", ts: "1793690000.123456" });
  });
  it("링크가 없으면 null", () => {
    assert.equal(replyTargetFromLink(""), null);
    assert.equal(replyTargetFromLink("https://example.com/archives/C1/p1793690000123456"), null);
  });
});

function setup(overrides = {}) {
  const draftStore = new Map();
  const reg = { actions: {}, views: {} };
  const app = { action(id, h) { reg.actions[String(id)] = h; }, view(id, h) { reg.views[String(id)] = h; } };
  registerDirectInputActions(app, {
    draftStore,
    buildDraftPreviewBlocks: () => [], buildDraftPreviewText: () => "preview", buildFileInquiryBlocks: () => [],
    matchWorkTitleFromSheet: async () => null, fetchDeliveryDate: async () => null,
    handleFileOrderInquiry: async () => {}, handleScheduleExt: async () => {}, handleWorkerRelay: async () => {},
    generateDraftId: () => "draft_new", resolveApmUserId: () => null,
    postInquiryToTargetChannel: async () => ({ ts: "t" }), TARGET_CHANNEL_ID: "C_TGT",
    checkInquiryDone: async () => {},
    ...overrides,
  });
  return { reg, draftStore };
}

const LINK = "https://jamake.slack.com/archives/C0695QCJ0TF/p1793690000123456";

describe("직접 입력(「기타」 → 「문의봇」) 초안에 원문 좌표가 실린다", () => {
  it("원문 링크 칸 → originalChannelId·originalTs", async () => {
    const { reg, draftStore } = setup();
    await reg.views.direct_inquiry_modal({
      ack: async () => {},
      body: { user: { id: "U05CE8HFA6B" } },
      view: { private_metadata: JSON.stringify({ sourceLink: LINK }), state: { values: {
        di_work_block: { value: { value: "网游之我是武学家" } },
        di_type_block: { value: { selected_option: { value: "기타" } } },
        di_content_block: { value: { value: "하이픈 의미 확인" } },
        di_link_block: { value: { value: LINK } },
      } } },
      client: { chat: { postMessage: async () => ({}) } },
    });
    const d = draftStore.get("draft_new");
    assert.equal(d.originalChannelId, "C0695QCJ0TF");
    assert.equal(d.originalTs, "1793690000.123456");
  });
});

describe("완료 → 답변 버튼 값", () => {
  it("버튼 값에 링크만 있어도 좌표를 채워 싣는다", async () => {
    const { reg } = setup();
    const posted = [];
    await reg.actions.inquiry_done({
      ack: async () => {},
      body: {
        actions: [{ value: JSON.stringify({ submitterId: "U05CE8HFA6B", historyRowIndex: 5, originalChannelId: null, originalTs: null, sourceLink: LINK }) }],
        channel: { id: "C09B8QHP7D4" }, message: { ts: "1793690252.686139", text: "x", blocks: [] }, user: { id: "U05CE8HFA6B" },
      },
      client: {
        conversations: { replies: async () => ({ messages: [] }) },
        chat: { postMessage: async (a) => { posted.push(a); return { ts: "9.9" }; }, update: async () => ({}) },
      },
    });
    const btn = posted.flatMap(p => p.blocks || []).find(b => b.type === "actions")?.elements?.[0];
    assert.ok(btn, "답변 작성 버튼이 게시돼야 한다");
    const v = JSON.parse(btn.value);
    assert.equal(v.originalChannelId, "C0695QCJ0TF");
    assert.equal(v.originalTs, "1793690000.123456");
  });
});

describe("이미 게시된 「다 빈」 버튼 — 문의 스레드의 원문 링크에서 되찾는다", () => {
  const EMPTY = JSON.stringify({ originalChannelId: null, originalTs: null, sourceLink: null, submitterId: "U05CE8HFA6B" });

  async function clickAndSubmit(threadMessages) {
    const { reg } = setup();
    let opened = null;
    const posts = [];
    const client = {
      views: { open: async (a) => { opened = a.view; } },
      conversations: {
        replies: async () => ({ messages: threadMessages }),
        history: async () => ({ messages: [{ user: "U_WORKER" }] }),
      },
      chat: { postMessage: async (a) => { posts.push(a); return {}; } },
    };
    await reg.actions.open_inquiry_reply_modal({
      ack: async () => {},
      body: { trigger_id: "t", actions: [{ value: EMPTY }], channel: { id: "C09B8QHP7D4" },
        message: { ts: "1793762827.018439", thread_ts: "1793690252.686139" } },
      client,
    });
    assert.ok(opened, "모달이 열려야 한다");
    await reg.views.submit_inquiry_reply_modal({
      ack: async () => {},
      body: { user: { id: "U05CE8HFA6B" } },
      view: { private_metadata: opened.private_metadata, state: { values: { reply_block: { reply_input: { value: "범위로 작업해 주세요" } } } } },
      client,
    });
    return posts;
  }

  it("봇 요약 댓글의 「원문 링크」로 원문 스레드에 답글을 단다", async () => {
    const posts = await clickAndSubmit([
      { bot_id: "B1", text: "网游之我是武学家 | 기타" },
      { bot_id: "B1", text: `:clipboard: *요약*\n...\n:link: *원문 링크*\n<${LINK}>` },
      { user: "U04463JR4HH", text: "다른 링크 https://jamake.slack.com/archives/C999/p1793000000000001" },
    ]);
    const reply = posts.find(p => p.channel === "C0695QCJ0TF");
    assert.ok(reply, "원문 채널에 답글이 가야 한다");
    assert.equal(reply.thread_ts, "1793690000.123456");
    assert.match(reply.text, /^<@U_WORKER> 범위로/);
  });

  it("사람 댓글의 링크는 원문으로 보지 않는다 — 못 찾으면 종전대로 안내만", async () => {
    const posts = await clickAndSubmit([
      { user: "U04463JR4HH", text: "원문 링크 https://jamake.slack.com/archives/C999/p1793000000000001" },
    ]);
    assert.equal(posts.some(p => p.channel === "C999"), false);
    assert.match(posts[posts.length - 1].text, /원문 스레드 정보를 찾을 수 없어/);
  });
});
