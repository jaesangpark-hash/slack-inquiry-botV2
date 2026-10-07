"use strict";
/**
 * retakeReminderPoller.js 단위 테스트
 *
 * node:test + node:assert 빌트인. retakeWatchStore._loadRows·slackClient 목 주입.
 *
 * 검증 항목 (tick / _buildText):
 *   - 오늘 등록된 watching 행만 대상(어제·완료·DROP·만료·범위밖 제외)
 *   - 채널별 1건 요약 공지 + 소환 담당자(ownerUserId) @멘션
 *   - 작품명 정리 적용(PV코드·일본어 제거)
 *   - 대상 없으면 무발송
 *   - 소환자 미상(ownerUserId 빈 값) 표기
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const createRetakeReminderPoller = require("../retakeReminderPoller");

const todayKst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const ysdayKst = new Date(Date.now() + 9 * 3600 * 1000 - 24 * 3600 * 1000).toISOString().slice(0, 10);
const atKst = (date) => `${date}T12:00:00+09:00`;

function makeStore(rows) {
  return { _loadRows: async () => rows };
}
function makeSlack({ throwOnPost = false } = {}) {
  const postCalls = [];
  return {
    chat: {
      postMessage: async (args) => {
        if (throwOnPost) throw new Error("fake slack error");
        postCalls.push(args);
        return { ok: true };
      },
    },
    postCalls,
  };
}

const row = (over = {}) => ({
  rowIndex: 5,
  registeredAt: atKst(todayKst),
  status: "watching",
  workName: "테스트작품",
  episode: "21",
  operationName: "식자",
  watchChannel: "C09B8QLR5FG",
  ownerUserId: "U_APM",
  ...over,
});

const WATCH = new Set(["C09B8QLR5FG"]);

describe("retakeReminderPoller.tick", () => {
  test("오늘 등록 watching → 채널 공지 1건 + 소환자 태그", async () => {
    const store = makeStore([row()]);
    const slack = makeSlack();
    const poller = createRetakeReminderPoller({ retakeWatchStore: store, slackClient: slack, watchChannels: WATCH });
    await poller.tick();

    assert.strictEqual(slack.postCalls.length, 1);
    const post = slack.postCalls[0];
    assert.strictEqual(post.channel, "C09B8QLR5FG");
    assert.match(post.text, /미제출 리테이크 알림/);
    assert.match(post.text, /테스트작품 21화 \[식자\]/);
    assert.match(post.text, /<@U_APM>/);
    assert.ok(!post.thread_ts, "스레드 아닌 채널 최상위 메시지");
  });

  test("어제 등록분은 제외(오늘 요청분만)", async () => {
    const store = makeStore([row({ registeredAt: atKst(ysdayKst) })]);
    const slack = makeSlack();
    const poller = createRetakeReminderPoller({ retakeWatchStore: store, slackClient: slack, watchChannels: WATCH });
    await poller.tick();
    assert.strictEqual(slack.postCalls.length, 0);
  });

  test("watching 외 상태(notified/dropped/expired/skipped)는 제외", async () => {
    const store = makeStore([
      row({ status: "notified" }),
      row({ status: "dropped" }),
      row({ status: "expired" }),
      row({ status: "skipped" }),
    ]);
    const slack = makeSlack();
    const poller = createRetakeReminderPoller({ retakeWatchStore: store, slackClient: slack, watchChannels: WATCH });
    await poller.tick();
    assert.strictEqual(slack.postCalls.length, 0);
  });

  test("감시 대상 채널 아니면 제외", async () => {
    const store = makeStore([row({ watchChannel: "C_OTHER" })]);
    const slack = makeSlack();
    const poller = createRetakeReminderPoller({ retakeWatchStore: store, slackClient: slack, watchChannels: WATCH });
    await poller.tick();
    assert.strictEqual(slack.postCalls.length, 0);
  });

  test("여러 건 → 한 채널에 묶어 1건, 작품명 정리 적용", async () => {
    const store = makeStore([
      row({ workName: "[PV-177835] [카카오픽코마] 그린라이트 グリーンライト（仮）", episode: "64", operationName: "식자검수", ownerUserId: "U_A" }),
      row({ workName: "멜로디는 끝나지 않아", episode: "56", operationName: "식자", ownerUserId: "U_B" }),
    ]);
    const slack = makeSlack();
    const poller = createRetakeReminderPoller({ retakeWatchStore: store, slackClient: slack, watchChannels: WATCH });
    await poller.tick();

    assert.strictEqual(slack.postCalls.length, 1);
    const t = slack.postCalls[0].text;
    assert.match(t, /2건/);
    assert.match(t, /그린라이트 64화 \[식자검수\]/);
    assert.doesNotMatch(t, /PV-177835/);
    assert.match(t, /<@U_A>/);
    assert.match(t, /<@U_B>/);
  });

  test("여러 채널 → 채널별 1건씩", async () => {
    const store = makeStore([
      row({ watchChannel: "C09B8QLR5FG" }),
      row({ watchChannel: "C_SECOND" }),
    ]);
    const slack = makeSlack();
    const poller = createRetakeReminderPoller({
      retakeWatchStore: store, slackClient: slack,
      watchChannels: new Set(["C09B8QLR5FG", "C_SECOND"]),
    });
    await poller.tick();
    assert.strictEqual(slack.postCalls.length, 2);
    const channels = slack.postCalls.map(p => p.channel).sort();
    assert.deepStrictEqual(channels, ["C09B8QLR5FG", "C_SECOND"]);
  });

  test("ownerUserId 비면 '(소환자 미상)' 표기", async () => {
    const store = makeStore([row({ ownerUserId: "" })]);
    const slack = makeSlack();
    const poller = createRetakeReminderPoller({ retakeWatchStore: store, slackClient: slack, watchChannels: WATCH });
    await poller.tick();
    assert.match(slack.postCalls[0].text, /\(소환자 미상\)/);
    assert.doesNotMatch(slack.postCalls[0].text, /<@>/);
  });

  test("대상 없으면 무발송", async () => {
    const store = makeStore([]);
    const slack = makeSlack();
    const poller = createRetakeReminderPoller({ retakeWatchStore: store, slackClient: slack, watchChannels: WATCH });
    await poller.tick();
    assert.strictEqual(slack.postCalls.length, 0);
  });
});
