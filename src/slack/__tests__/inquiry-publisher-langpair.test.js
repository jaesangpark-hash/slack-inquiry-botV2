"use strict";
/**
 * 문의 본체가 언어쌍별 목적지·수신자로 나가는지 — 회귀 시험
 *
 * 한일 경로는 2026-10-28 에 운영에 올라갔지만 실사용 검증 전이다. 검증이 끝날 때까지
 * 한일 결과물이 중일 운영 채널에 섞이면 안 된다. 섞여도 로그에 오류가 안 남아
 * (전송은 성공한다) 사람이 알아채기 어렵다 — 그래서 시험으로 묶는다.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const createInquiryPublisher = require("../inquiry-publisher");
const { createLangRouting } = require("../../config/lang-routing");

const langRouting = createLangRouting({
  base: {
    target: "C_PROD", pmRequest: "C_PMREQ", schedule: "C_SCHED",
    mentionUserIds: ["U_ZH_APM"], pmSlackId: "U_PM",
  },
  overrides: { "ko-ja": { target: "C_KOJA_TEST", mentionUserIds: ["U_KO_APM"] } },
});

function makePublisher() {
  const sent = [];
  const postInquiry = createInquiryPublisher({
    appendInquiryHistory: async () => 7,
    draftStore: new Map(),
    // 실제 블록 빌더 대신, 전달받은 langPair 를 그대로 되비춰 수신자 선택을 눈으로 본다.
    buildFinalMainMessage: ({ langPair }) => ({ text: "main", langPair }),
    buildThreadMessage: () => "thread",
    langRouting,
  });
  const client = {
    chat: {
      postMessage: async payload => { sent.push(payload); return { ts: "ts1" }; },
      getPermalink: async () => ({ permalink: "https://slack.com/archives/C/p1" }),
    },
  };
  return { sent, postInquiry, client };
}

describe("문의 본체 — 언어쌍별 목적지", () => {
  test("한일 초안은 테스트 채널로 간다", async () => {
    const { sent, postInquiry, client } = makePublisher();
    await postInquiry(client, { draftId: "d-ko", lang: "ko-ja", dmChannelId: "D1" }, "U1");
    assert.ok(sent.length >= 1);
    assert.ok(sent.every(m => m.channel === "C_KOJA_TEST"),
      `한일인데 ${sent.map(m => m.channel).join(",")} 로 갔다`);
  });

  test("중일 초안은 종전 운영 채널 그대로", async () => {
    const { sent, postInquiry, client } = makePublisher();
    await postInquiry(client, { draftId: "d-zh", lang: "zh-ja", dmChannelId: "D1" }, "U1");
    assert.ok(sent.every(m => m.channel === "C_PROD"));
  });

  test("lang 이 없는 옛 초안도 운영 채널 — 재시작 뒤 남은 초안이 사라지면 안 된다", async () => {
    const { sent, postInquiry, client } = makePublisher();
    await postInquiry(client, { draftId: "d-old", dmChannelId: "D1" }, "U1");
    assert.ok(sent.every(m => m.channel === "C_PROD"));
  });

  test("본문 빌더에 langPair 가 전달된다 — 수신자를 언어별로 고를 수 있어야 한다", async () => {
    const { sent, postInquiry, client } = makePublisher();
    await postInquiry(client, { draftId: "d-ko2", lang: "ko-ja", dmChannelId: "D1" }, "U1");
    assert.equal(sent[0].langPair, "ko-ja");
  });
});
