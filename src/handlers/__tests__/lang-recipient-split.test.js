"use strict";
/**
 * 언어쌍별 수신자·목적지 분리 — 회귀 시험 (지시 2026-10-28 ①②)
 *
 * 중일/한일 담당 APM 이 다르다. 수신자를 안 가르면 한일 문의가 중일 APM 에게 가고
 * 반대도 마찬가지다. 전송 자체는 성공하므로 로그로는 안 보인다 — 시험으로 묶는다.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const createInquiryBlocks = require("../../slack/inquiry-blocks");
const registerResupplyActions = require("../resupply-actions");
const registerScheduleActions = require("../schedule-actions");
const { createLangRouting } = require("../../config/lang-routing");

const langRouting = createLangRouting({
  base: {
    target: "C_PROD", pmRequest: "C_PMREQ", schedule: "C_SCHED",
    mentionUserIds: ["U_ZH_APM"], pmSlackId: "U_ZH_PM",
  },
  overrides: {
    "ko-ja": {
      target: "C_KOJA_TEST", pmRequest: "C_KOJA_TEST", schedule: "C_KOJA_TEST",
      mentionUserIds: ["U_KO_APM"], pmSlackId: "U_KO_PM",
    },
  },
});

const blocks = createInquiryBlocks({
  pmSlackIdFor:      langPair => langRouting.pmSlackIdFor(langPair),
  mentionUserIdsFor: langPair => langRouting.mentionUserIdsFor(langPair),
});

// ── 문의 본체 멘션 ───────────────────────────────────────────────────────────

describe("buildFinalMainMessage — 수신자는 언어쌍이 고른다", () => {
  const mentionLine = (langPair) =>
    blocks.buildFinalMainMessage({ submitterId: "U1", workName: "작품", langPair })
      .blocks[0].text.text;

  test("한일 문의는 한일 담당에게", () => {
    assert.equal(mentionLine("ko-ja"), "<@U_KO_APM>");
  });

  test("중일 문의는 종전 담당 그대로", () => {
    assert.equal(mentionLine("zh-ja"), "<@U_ZH_APM>");
  });

  test("언어를 모르면 공통 수신자 — 멘션이 비어 아무도 못 보는 일은 없어야 한다", () => {
    assert.equal(mentionLine(null), "<@U_ZH_APM>");
    assert.equal(mentionLine(undefined), "<@U_ZH_APM>");
  });
});

describe("buildFileInquiryMessage — 재수급 수신 PM 도 언어쌍이 고른다", () => {
  const pmLine = (lang) => blocks.buildFileInquiryMessage({ workName: "작품", lang }, "U1").text.split("\n")[0];

  test("한일 재수급은 한일 PM 에게", () => {
    assert.equal(pmLine("ko-ja"), "<@U_KO_PM>");
  });

  test("중일·미상은 종전 PM", () => {
    assert.equal(pmLine("zh-ja"), "<@U_ZH_PM>");
    assert.equal(pmLine(null), "<@U_ZH_PM>");
  });
});

// ── 고정 채널 목적지 ─────────────────────────────────────────────────────────

function makeFakeApp() {
  const registered = { actions: {}, views: {} };
  return {
    action(id, handler) { registered.actions[id instanceof RegExp ? id.source : id] = handler; },
    view(id, handler) { registered.views[id] = handler; },
    _registered: registered,
  };
}

function makeRecordingClient() {
  const sent = [];
  return {
    sent,
    views: { open: async () => ({}) },
    chat: {
      postMessage: async payload => { sent.push(payload); return { ts: "ts1" }; },
      update: async () => ({}),
      getPermalink: async () => ({ permalink: "https://slack.com/archives/C/p1" }),
    },
  };
}

describe("재수급 요청 — 언어쌍별 목적지", () => {
  async function send(lang) {
    const app = makeFakeApp();
    const draftStore = new Map();
    draftStore.set("d1", { draftId: "d1", workName: "작품", lang, dmChannelId: "D1" });
    registerResupplyActions(app, {
      draftStore,
      buildFileInquiryBlocks: () => [],
      buildFileInquiryMessage: () => ({ text: "req", blocks: [] }),
      appendResupplyRecord: async () => 3,
      checkResupplyDone: async () => false,
      langRouting,
    });
    const client = makeRecordingClient();
    await app._registered.actions["send_file_inquiry_now"]({
      ack: async () => {}, body: { user: { id: "U1" }, actions: [{ value: "d1" }] }, client,
    });
    // DM 안내(D1)는 빼고 채널 전송만 본다
    return client.sent.filter(m => m.channel !== "D1").map(m => m.channel);
  }

  test("한일 재수급은 테스트 채널로", async () => {
    const channels = await send("ko-ja");
    assert.ok(channels.length >= 1, "재수급 요청이 전송되지 않았다");
    assert.ok(channels.every(c => c === "C_KOJA_TEST"), `한일인데 ${channels.join(",")} 로 갔다`);
  });

  test("중일 재수급은 종전 PM 채널 그대로", async () => {
    const channels = await send("zh-ja");
    assert.ok(channels.every(c => c === "C_PMREQ"));
  });
});

describe("납품일 변경 요청 — 언어쌍별 목적지·수신 PM", () => {
  async function submit(deliveryLang) {
    const app = makeFakeApp();
    const draftStore = new Map();
    draftStore.set("d1", {
      delivery: { lang: deliveryLang, workName: "작품", allSame: true, deliveryDate: "2026-11-10", episodeLabel: "3화" },
    });
    registerScheduleActions(app, {
      draftStore,
      loadTitleRowsFromSheet: async () => [],
      matchWorkTitleFromSheet: async () => null,
      fetchDeliveryDate: async () => null,
      handleScheduleExt: async () => {},
      langRouting,
    });
    const client = makeRecordingClient();
    await app._registered.views["schedule_pm_request_modal"]({
      ack: async () => {},
      body: { user: { id: "U1" } },
      view: {
        private_metadata: JSON.stringify({ draftId: "d1" }),
        state: { values: { desired_date_block: { desired_date_input: { selected_date: "2026-11-20" } } } },
      },
      client,
    });
    return client.sent.find(m => m.channel !== "U1");
  }

  test("한일은 테스트 채널 + 한일 PM 멘션", async () => {
    const posted = await submit("ko-ja");
    assert.equal(posted.channel, "C_KOJA_TEST");
    assert.ok(posted.text.startsWith("<@U_KO_PM>"), posted.text.split("\n")[0]);
  });

  test("중일은 종전 스케줄 채널 + 종전 PM", async () => {
    const posted = await submit("zh-ja");
    assert.equal(posted.channel, "C_SCHED");
    assert.ok(posted.text.startsWith("<@U_ZH_PM>"));
  });

  test("납품일을 못 찾아 언어를 모르면 종전 채널 — 요청이 사라지면 안 된다", async () => {
    const posted = await submit(undefined);
    assert.equal(posted.channel, "C_SCHED");
  });
});
