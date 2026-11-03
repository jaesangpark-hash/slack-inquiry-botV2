"use strict";
/**
 * AIA 4차 리뷰 C1~C3 회귀 시험 (2026-10-29)
 *
 * C1  ack 예산 초과 분기에서 「못 찾았어」 DM 뒤 return 이 없어, 빈 작품명으로 초안까지 만들고
 *     pending 을 지워 재입력 경로까지 없앴다.
 * C2  권한 게이트가 공통 PM 하나와만 비교해, 한일 PM 이 자기 앞으로 온 버튼을 못 눌렀다.
 * C3  목적지·수신자 판정이 draft.lang 뿐이라, 한일 이모지로 불렀는데 작품을 못 찾은 건이
 *     중일 공통 수신자에게 갔다.
 *
 * 셋 다 전송은 성공해 로그에 아무것도 안 남는 부류라 시험으로 묶는다.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const registerScheduleActions = require("../schedule-actions");
const registerDirectInputActions = require("../direct-input-actions");
const { createLangRouting } = require("../../config/lang-routing");
const createInquiryBlocks = require("../../slack/inquiry-blocks");

const langRouting = createLangRouting({
  base: { target: "C_PROD", pmRequest: "C_PMREQ", schedule: "C_SCHED", mentionUserIds: ["U_ZH"], pmSlackId: "U_ZH_PM" },
  overrides: { "ko-ja": { mentionUserIds: ["U_KO"], pmSlackId: "U_KO_PM" } },
});

function makeApp() {
  const reg = { actions: {}, views: {} };
  return {
    action(id, h) { reg.actions[id instanceof RegExp ? id.source : id] = h; },
    view(id, h) { reg.views[id] = h; },
    _reg: reg,
  };
}
const makeClient = () => {
  const sent = [];
  return { sent, views: { open: async () => ({}) },
    chat: { postMessage: async (p) => { sent.push(p); return { ts: "t" }; }, update: async () => ({}), getPermalink: async () => ({ permalink: "p" }) } };
};

// ── C1 ──────────────────────────────────────────────────────────────────────
describe("C1 — ack 예산 초과 + PIVO 미발견이면 거기서 멈춘다", () => {
  test("schedule_title_modal: 초안으로 진행하지 않고 pending 을 남긴다", async () => {
    const app = makeApp();
    const draftStore = new Map();
    draftStore.set("p1", { type: "schedule_pending", ownerUserId: "U1", parsed: { episode: "3" }, langPair: "ko-ja" });
    let schedCalled = false;
    registerScheduleActions(app, {
      draftStore,
      loadTitleRowsFromSheet: async () => [],
      // 예산(2.2초)을 넘기도록 느리게, 그리고 끝내 못 찾는다
      matchWorkTitleFromSheet: async () => { await new Promise((r) => setTimeout(r, 2600)); return null; },
      fetchDeliveryDate: async () => { throw new Error("여기까지 오면 안 된다"); },
      handleScheduleExt: async () => { schedCalled = true; },
      langRouting,
    });
    const client = makeClient();
    await app._reg.views["schedule_title_modal"]({
      ack: async () => {}, body: { user: { id: "U1" } }, client,
      view: { private_metadata: JSON.stringify({ pendingId: "p1" }),
        state: { values: { sched_pivoid_block: { value: { value: "999999" } } } } },
    });
    assert.equal(schedCalled, false, "빈 작품명으로 스케줄 플로우까지 진행했다");
    assert.ok(draftStore.has("p1"), "pending 이 지워져 재입력 경로가 사라졌다");
    assert.equal(client.sent.length, 1, "안내 DM 한 건만 나가야 한다");
    assert.match(client.sent[0].text, /못 찾았어/);
  });
});

// ── C2 ──────────────────────────────────────────────────────────────────────
describe("C2 — 언어쌍별 PM 을 모두 인정한다", () => {
  test("표가 아는 PM 전부가 allPmSlackIds 에 들어온다", () => {
    assert.deepEqual(langRouting.allPmSlackIds().sort(), ["U_KO_PM", "U_ZH_PM"]);
  });

  test("한일 PM 만 따로 넣어도 공통 PM 은 빠지지 않는다", () => {
    const only = createLangRouting({
      base: { target: "C", pmRequest: "C", schedule: "C", mentionUserIds: [], pmSlackId: "U_BASE" },
      overrides: { "ko-ja": { pmSlackId: "U_KO_PM" } },
    });
    assert.deepEqual(only.allPmSlackIds().sort(), ["U_BASE", "U_KO_PM"]);
  });

  test("분리하지 않으면 한 명뿐 — 중복이 생기지 않는다", () => {
    const same = createLangRouting({
      base: { target: "C", pmRequest: "C", schedule: "C", mentionUserIds: [], pmSlackId: "U_BASE" },
      overrides: { "ko-ja": {} },
    });
    assert.deepEqual(same.allPmSlackIds(), ["U_BASE"]);
  });
});

// ── C3 ──────────────────────────────────────────────────────────────────────
describe("C3 — 작품을 못 찾아도 소환 이모지의 언어로 떨어진다", () => {
  const blocks = createInquiryBlocks({
    pmSlackIdFor: (lp) => langRouting.pmSlackIdFor(lp),
    mentionUserIdsFor: (lp) => langRouting.mentionUserIdsFor(lp),
  });

  test("문의 본체 멘션: lang 이 없고 langPair 만 있으면 한일 수신자", () => {
    const d = { draftId: "d", ownerUserId: "U1", workName: "미매칭 작품", lang: null, langPair: "ko-ja" };
    const main = blocks.buildDraftPreviewBlocks(d);
    assert.ok(JSON.stringify(main).includes("U_KO"), "중일 공통 수신자에게 갔다");
  });

  test("재수급 수신 PM: 같은 폴백이 걸린다", () => {
    const line = blocks.buildFileInquiryMessage({ workName: "미매칭", lang: null, langPair: "ko-ja" }, "U1")
      .text.split("\n")[0];
    assert.equal(line, "<@U_KO_PM>");
  });

  test("lang 이 있으면 lang 이 이긴다 — 확정된 작품이 우선", () => {
    const line = blocks.buildFileInquiryMessage({ workName: "매칭됨", lang: "zh-ja", langPair: "ko-ja" }, "U1")
      .text.split("\n")[0];
    assert.equal(line, "<@U_ZH_PM>");
  });

  test("둘 다 없으면 공통 — DM 링크 소환은 신호가 없다", () => {
    const line = blocks.buildFileInquiryMessage({ workName: "무신호" }, "U1").text.split("\n")[0];
    assert.equal(line, "<@U_ZH_PM>");
  });
});
