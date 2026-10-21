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
  judgeTaskUuid: "judge-1",
  workName: "테스트작품",
  episode: "21",
  operationName: "식자",
  watchChannel: "C09B8QLR5FG",
  watchThreadTs: "1790904681.097009",
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
    assert.strictEqual(post.thread_ts, "1790904681.097009", "납품 스레드에 답글");
  });

  test("납품 스레드(watchThreadTs)에 답글로 달린다", async () => {
    const store = makeStore([row({ watchThreadTs: "1790999999.123456" })]);
    const slack = makeSlack();
    const poller = createRetakeReminderPoller({ retakeWatchStore: store, slackClient: slack, watchChannels: WATCH });
    await poller.tick();
    assert.strictEqual(slack.postCalls.length, 1);
    assert.strictEqual(slack.postCalls[0].thread_ts, "1790999999.123456");
  });

  test("납품 스레드가 다르면 스레드별로 답글(여러 건)", async () => {
    const store = makeStore([
      row({ rowIndex: 5, watchThreadTs: "T_A", workName: "작품1" }),
      row({ rowIndex: 6, watchThreadTs: "T_A", workName: "작품2" }),
      row({ rowIndex: 7, watchThreadTs: "T_B", workName: "작품3" }),
    ]);
    const slack = makeSlack();
    const poller = createRetakeReminderPoller({ retakeWatchStore: store, slackClient: slack, watchChannels: WATCH });
    await poller.tick();
    assert.strictEqual(slack.postCalls.length, 2); // 스레드 2개 → 2건
    const byTs = Object.fromEntries(slack.postCalls.map(p => [p.thread_ts, p.text]));
    assert.match(byTs["T_A"], /2건/);  // T_A에 2건
    assert.match(byTs["T_B"], /1건/);  // T_B에 1건
  });

  test("watchThreadTs 없으면 채널 최상위로 fallback(답글 아님)", async () => {
    const store = makeStore([row({ watchThreadTs: "" })]);
    const slack = makeSlack();
    const poller = createRetakeReminderPoller({ retakeWatchStore: store, slackClient: slack, watchChannels: WATCH });
    await poller.tick();
    assert.strictEqual(slack.postCalls.length, 1);
    assert.ok(!slack.postCalls[0].thread_ts);
  });

  test("어제 등록분은 제외(오늘 요청분만)", async () => {
    const store = makeStore([row({ registeredAt: atKst(ysdayKst) })]);
    const slack = makeSlack();
    const poller = createRetakeReminderPoller({ retakeWatchStore: store, slackClient: slack, watchChannels: WATCH });
    await poller.tick();
    assert.strictEqual(slack.postCalls.length, 0);
  });

  test("미제출·완료 없이 드랍/만료만 있으면 무발송(안내도 안 함)", async () => {
    const store = makeStore([
      row({ rowIndex: 5, status: "dropped" }),
      row({ rowIndex: 6, status: "expired" }),
    ]);
    const slack = makeSlack();
    const poller = createRetakeReminderPoller({ retakeWatchStore: store, slackClient: slack, watchChannels: WATCH });
    await poller.tick();
    assert.strictEqual(slack.postCalls.length, 0);
  });

  test("미제출 0 + 완료(notified) 있으면 → 납품 스레드에 '전체 제출 완료' 안내(태그 없음)", async () => {
    const store = makeStore([
      row({ rowIndex: 5, status: "notified" }),
      row({ rowIndex: 6, status: "notified" }),
    ]);
    const slack = makeSlack();
    const poller = createRetakeReminderPoller({ retakeWatchStore: store, slackClient: slack, watchChannels: WATCH });
    await poller.tick();
    assert.strictEqual(slack.postCalls.length, 1);
    const post = slack.postCalls[0];
    assert.strictEqual(post.thread_ts, "1790904681.097009"); // 납품 스레드에 답글
    assert.match(post.text, /모두 제출 완료/);
    assert.doesNotMatch(post.text, /<@/); // 아무도 태그 안 함
  });

  test("완료만 있어도 미제출(watching)이 하나라도 있으면 안내 대신 리마인더", async () => {
    const store = makeStore([
      row({ rowIndex: 5, status: "notified", workName: "완료작품" }),
      row({ rowIndex: 6, status: "watching", workName: "미제출작품", ownerUserId: "U_OWNER" }),
    ]);
    const slack = makeSlack();
    const poller = createRetakeReminderPoller({ retakeWatchStore: store, slackClient: slack, watchChannels: WATCH });
    await poller.tick();
    assert.strictEqual(slack.postCalls.length, 1);
    const t = slack.postCalls[0].text;
    assert.match(t, /미제출 리테이크 알림/);        // 리마인더
    assert.match(t, /미제출작품/);
    assert.doesNotMatch(t, /완료작품/);              // 완료건은 리마인더 목록에서 제외
    assert.doesNotMatch(t, /모두 제출 완료/);        // 안내 아님
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

  test("ownerUserId 비면 헤더에 소환자 멘션 없음(그래도 발송)", async () => {
    const store = makeStore([row({ ownerUserId: "" })]);
    const slack = makeSlack();
    const poller = createRetakeReminderPoller({ retakeWatchStore: store, slackClient: slack, watchChannels: WATCH });
    await poller.tick();
    assert.strictEqual(slack.postCalls.length, 1);
    assert.doesNotMatch(slack.postCalls[0].text, /알림\]\* <@/); // 헤더에 소환자 태그 없음
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

describe("retakeReminderPoller 발송 직전 Totus 재확인 (apiFetch)", () => {
  // /tasks/{uuid} 응답을 uuid→상태 매핑으로 흉내. 매핑에 없으면 success:false(조회 실패).
  function makeApiFetch(stateByUuid, { throwOnCall = false } = {}) {
    const calls = [];
    const fn = async (url) => {
      calls.push(url);
      if (throwOnCall) throw new Error("fake totus error");
      const m = String(url).match(/\/tasks\/([^?]+)$/);
      const uuid = m ? m[1] : null;
      const state = stateByUuid[uuid];
      if (state === undefined) return { success: false };
      return { success: true, data: { "상태": state } };
    };
    fn.calls = calls;
    return fn;
  }

  test("watching이지만 Totus 상태가 COMPLETED면 공지에서 빠진다", async () => {
    const store = makeStore([row({ judgeTaskUuid: "done-1" })]);
    const slack = makeSlack();
    const apiFetch = makeApiFetch({ "done-1": "COMPLETED" });
    const poller = createRetakeReminderPoller({ retakeWatchStore: store, slackClient: slack, watchChannels: WATCH, apiFetch });
    await poller.tick();
    assert.strictEqual(slack.postCalls.length, 0); // 완료건 → 공지 안 함
    assert.strictEqual(apiFetch.calls.length, 1);  // 재확인 1회
  });

  test("DROP도 공지에서 빠진다", async () => {
    const store = makeStore([row({ judgeTaskUuid: "drop-1" })]);
    const slack = makeSlack();
    const apiFetch = makeApiFetch({ "drop-1": "DROP" });
    const poller = createRetakeReminderPoller({ retakeWatchStore: store, slackClient: slack, watchChannels: WATCH, apiFetch });
    await poller.tick();
    assert.strictEqual(slack.postCalls.length, 0);
  });

  test("PROCESSING(미완료)은 공지에 포함", async () => {
    const store = makeStore([row({ judgeTaskUuid: "proc-1" })]);
    const slack = makeSlack();
    const apiFetch = makeApiFetch({ "proc-1": "PROCESSING" });
    const poller = createRetakeReminderPoller({ retakeWatchStore: store, slackClient: slack, watchChannels: WATCH, apiFetch });
    await poller.tick();
    assert.strictEqual(slack.postCalls.length, 1);
    assert.match(slack.postCalls[0].text, /테스트작품 21화/);
  });

  test("완료·미완료 혼재 → 미완료만 공지", async () => {
    const store = makeStore([
      row({ rowIndex: 5, judgeTaskUuid: "done-1", workName: "완료작품" }),
      row({ rowIndex: 6, judgeTaskUuid: "proc-1", workName: "진행작품" }),
    ]);
    const slack = makeSlack();
    const apiFetch = makeApiFetch({ "done-1": "COMPLETED", "proc-1": "PROCESSING" });
    const poller = createRetakeReminderPoller({ retakeWatchStore: store, slackClient: slack, watchChannels: WATCH, apiFetch });
    await poller.tick();
    assert.strictEqual(slack.postCalls.length, 1);
    assert.match(slack.postCalls[0].text, /1건/);
    assert.match(slack.postCalls[0].text, /진행작품/);
    assert.doesNotMatch(slack.postCalls[0].text, /완료작품/);
  });

  test("조회 실패(success:false)는 제외로 고정 — 공지 안 함", async () => {
    const store = makeStore([row({ judgeTaskUuid: "unknown-1" })]); // 매핑에 없음 → success:false
    const slack = makeSlack();
    const apiFetch = makeApiFetch({});
    const poller = createRetakeReminderPoller({ retakeWatchStore: store, slackClient: slack, watchChannels: WATCH, apiFetch });
    await poller.tick();
    assert.strictEqual(slack.postCalls.length, 0);
  });

  test("조회 예외도 제외로 고정 — 공지 안 함", async () => {
    const store = makeStore([row({ judgeTaskUuid: "x-1" })]);
    const slack = makeSlack();
    const apiFetch = makeApiFetch({ "x-1": "PROCESSING" }, { throwOnCall: true });
    const poller = createRetakeReminderPoller({ retakeWatchStore: store, slackClient: slack, watchChannels: WATCH, apiFetch });
    await poller.tick();
    assert.strictEqual(slack.postCalls.length, 0);
  });

  test("apiFetch 미주입이면 재확인 생략(시트 watching 신뢰) — 기존 동작", async () => {
    const store = makeStore([row()]);
    const slack = makeSlack();
    const poller = createRetakeReminderPoller({ retakeWatchStore: store, slackClient: slack, watchChannels: WATCH });
    await poller.tick();
    assert.strictEqual(slack.postCalls.length, 1); // apiFetch 없으면 시트만 보고 공지
  });

  test("리마인더는 상태 기록을 하지 않는다(markStatus 호출 없음)", async () => {
    let markCalled = false;
    const store = { _loadRows: async () => [row({ judgeTaskUuid: "proc-1" })], markStatus: async () => { markCalled = true; } };
    const slack = makeSlack();
    const apiFetch = makeApiFetch({ "proc-1": "PROCESSING" });
    const poller = createRetakeReminderPoller({ retakeWatchStore: store, slackClient: slack, watchChannels: WATCH, apiFetch });
    await poller.tick();
    assert.strictEqual(markCalled, false); // 읽기 전용 — 완료 답글 중복 방지
  });
});

describe("retakeReminderPoller 헤더=소환자 (CFM cc·PM 없음)", () => {
  test("헤더에 소환자 태그, 각 줄은 작품만(cc/PM 없음)", async () => {
    const store = makeStore([row({ ownerUserId: "U_OWNER" })]);
    const slack = makeSlack();
    const poller = createRetakeReminderPoller({
      retakeWatchStore: store, slackClient: slack, watchChannels: WATCH,
    });
    await poller.tick();

    assert.strictEqual(slack.postCalls.length, 1);
    const t = slack.postCalls[0].text;
    assert.match(t, /\[미제출 리테이크 알림\]\* <@U_OWNER> 오늘/); // 헤더=소환자
    assert.doesNotMatch(t, /cc /);                                // cc 없음
    assert.doesNotMatch(t, /PM/);                                 // PM 없음
  });

  test("소환자 여러 명이면 헤더에 중복 없이 모두 태그", async () => {
    const store = makeStore([
      row({ rowIndex: 5, ownerUserId: "U_A", workName: "작품1" }),
      row({ rowIndex: 6, ownerUserId: "U_B", workName: "작품2" }),
      row({ rowIndex: 7, ownerUserId: "U_A", workName: "작품3" }), // U_A 중복
    ]);
    const slack = makeSlack();
    const poller = createRetakeReminderPoller({
      retakeWatchStore: store, slackClient: slack, watchChannels: WATCH,
    });
    await poller.tick();
    const head = slack.postCalls[0].text.split("\n")[0];
    assert.match(head, /<@U_A>/);
    assert.match(head, /<@U_B>/);
    assert.strictEqual((head.match(/<@U_A>/g) || []).length, 1); // 중복 제거
  });
});

describe("retakeReminderPoller 작업자 수정요청 스레드 리마인드", () => {
  test("workerChannel·workerThreadTs 있으면 그 스레드에 답글 추가 발송", async () => {
    const store = makeStore([row({ workerChannel: "C_WORK", workerThreadTs: "1790888.000100" })]);
    const slack = makeSlack();
    const poller = createRetakeReminderPoller({ retakeWatchStore: store, slackClient: slack, watchChannels: WATCH });
    await poller.tick();
    // 공지(납품) 스레드 답글 1 + 작업자 스레드 답글 1 = 2
    assert.strictEqual(slack.postCalls.length, 2);
    const worker = slack.postCalls.find(p => p.channel === "C_WORK");
    assert.ok(worker, "작업자 채널 발송 있어야 함");
    assert.strictEqual(worker.thread_ts, "1790888.000100");
    assert.match(worker.text, /아직 제출되지 않은/);
  });

  test("workerThreadTs 없으면 작업자 리마인드 안 함(공지만)", async () => {
    const store = makeStore([row({ workerChannel: "C_WORK", workerThreadTs: "" })]);
    const slack = makeSlack();
    const poller = createRetakeReminderPoller({ retakeWatchStore: store, slackClient: slack, watchChannels: WATCH });
    await poller.tick();
    assert.strictEqual(slack.postCalls.length, 1);
    assert.ok(!slack.postCalls.some(p => p.channel === "C_WORK"));
  });

  test("작업자 스레드별로 묶어 답글(같은 스레드 2건 → 1답글)", async () => {
    const store = makeStore([
      row({ rowIndex: 5, workName: "작품1", workerChannel: "C_W", workerThreadTs: "T1" }),
      row({ rowIndex: 6, workName: "작품2", workerChannel: "C_W", workerThreadTs: "T1" }),
      row({ rowIndex: 7, workName: "작품3", workerChannel: "C_W", workerThreadTs: "T2" }),
    ]);
    const slack = makeSlack();
    const poller = createRetakeReminderPoller({ retakeWatchStore: store, slackClient: slack, watchChannels: WATCH });
    await poller.tick();
    const workerPosts = slack.postCalls.filter(p => p.channel === "C_W");
    assert.strictEqual(workerPosts.length, 2); // T1, T2 각 1건
    const t1 = workerPosts.find(p => p.thread_ts === "T1");
    assert.match(t1.text, /작품1/);
    assert.match(t1.text, /작품2/);
  });
});
