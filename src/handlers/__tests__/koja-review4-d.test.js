"use strict";
/**
 * AIA 4차 리뷰 D1·D2 회귀 시험 (2026-10-29)
 *
 * C3 로 문의 본체·재수급·직접 입력은 메웠지만 PM 쪽 두 경로가 남아 있었다.
 *   D1 납품일 변경 요청 — 작품도 납품일도 못 찾으면 공통(중일) PM 을 멘션했다.
 *   D2 복수 문의 항목 초안 — langPair 폴백이 없어 같은 증상.
 *
 * 둘 다 "수신자가 틀린 채로 전송은 성공"하는 부류다. 채널을 중일과 같이 쓰기로 한 이상
 * 실제 위험은 여기뿐이라 시험으로 묶는다.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const registerScheduleActions = require("../schedule-actions");
const { createLangRouting } = require("../../config/lang-routing");

const langRouting = createLangRouting({
  base: { target: "C", pmRequest: "C", schedule: "C_SCHED", mentionUserIds: ["U_ZH"], pmSlackId: "U_ZH_PM" },
  overrides: { "ko-ja": { pmSlackId: "U_KO_PM" } },
});

function makeApp() {
  const reg = { actions: {}, views: {} };
  return { action(id, h) { reg.actions[id instanceof RegExp ? id.source : id] = h; }, view(id, h) { reg.views[id] = h; }, _reg: reg };
}
const makeClient = () => {
  const sent = [];
  return { sent, views: { open: async () => ({}) },
    chat: { postMessage: async (p) => { sent.push(p); return { ts: "t" }; }, update: async () => ({}) } };
};

// ── D1 ──────────────────────────────────────────────────────────────────────
describe("D1 — 납품일 변경 요청이 소환 언어의 PM 을 부른다", () => {
  // 납품일을 못 찾은 상태(delivery 없음)로 PM 요청 모달을 제출한다.
  async function submit(draftData) {
    const app = makeApp();
    const draftStore = new Map();
    draftStore.set("d1", draftData);
    registerScheduleActions(app, {
      draftStore, loadTitleRowsFromSheet: async () => [],
      matchWorkTitleFromSheet: async () => null, fetchDeliveryDate: async () => null,
      handleScheduleExt: async () => {}, langRouting,
    });
    const client = makeClient();
    await app._reg.views["schedule_pm_request_modal"]({
      ack: async () => {}, body: { user: { id: "U1" } }, client,
      view: { private_metadata: JSON.stringify({ draftId: "d1" }),
        state: { values: { desired_date_block: { desired_date_input: { selected_date: "2026-11-20" } } } } },
    });
    return client.sent.find((m) => m.channel !== "U1");
  }

  test("작품·납품일을 못 찾아도 langPair 로 한일 PM 을 부른다", async () => {
    const posted = await submit({ langPair: "ko-ja" });   // delivery 없음, lang 없음
    assert.ok(posted.text.startsWith("<@U_KO_PM>"), posted.text.split("\n")[0]);
  });

  test("납품일을 찾았으면 그 언어가 이긴다 — 확정된 작품이 우선", async () => {
    const posted = await submit({ langPair: "ko-ja", delivery: { lang: "zh-ja", allSame: true, deliveryDate: "2026-11-10", workName: "작품", episodeLabel: "3화" } });
    assert.ok(posted.text.startsWith("<@U_ZH_PM>"));
  });

  test("아무 신호도 없으면 공통 PM — 요청이 사라지면 안 된다", async () => {
    const posted = await submit({});
    assert.ok(posted.text.startsWith("<@U_ZH_PM>"));
  });
});

// ── D2 ──────────────────────────────────────────────────────────────────────
describe("D2 — 복수 문의 항목 초안이 langPair 를 물고 간다", () => {
  // processItem 은 flow 내부 함수라 직접 못 부른다. 대신 그 초안을 받는 쪽(재수급 PM 선택)이
  // lang 이 없을 때 langPair 로 떨어지는지를 본다 — 초안에 langPair 가 실려야 성립한다.
  const createInquiryBlocks = require("../../slack/inquiry-blocks");
  const blocks = createInquiryBlocks({
    pmSlackIdFor: (lp) => langRouting.pmSlackIdFor(lp),
    mentionUserIdsFor: (lp) => langRouting.mentionUserIdsFor(lp),
  });
  const pmLine = (draft) => blocks.buildFileInquiryMessage(draft, "U1").text.split("\n")[0];

  test("항목 초안에 lang 이 없고 langPair 만 있으면 한일 PM", () => {
    assert.equal(pmLine({ type: "file_inquiry", workName: "미매칭 항목", lang: null, langPair: "ko-ja" }), "<@U_KO_PM>");
  });

  test("lang 이 있으면 lang 이 이긴다", () => {
    assert.equal(pmLine({ type: "file_inquiry", workName: "매칭됨", lang: "zh-ja", langPair: "ko-ja" }), "<@U_ZH_PM>");
  });

  test("multipleInquiryFlow 의 processItem 이 langPair 인자를 받는다", () => {
    const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../multipleInquiryFlow.js"), "utf8");
    assert.match(src, /async function processItem\([^)]*langPair = null\)/, "processItem 시그니처에 langPair 가 없다");
    assert.match(src, /lang: matchedTitle\?\.lang \|\| null,\s*\r?\n\s*langPair,/, "항목 초안이 langPair 를 저장하지 않는다");
  });
});
