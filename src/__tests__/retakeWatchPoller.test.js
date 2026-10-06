"use strict";
/**
 * retakeWatchPoller.js 단위 테스트
 *
 * node:test + node:assert 빌트인. apiFetch·retakeWatchStore·slackClient 목 주입.
 *
 * 검증 항목 (tick / _processRow):
 *   - COMPLETED → 납품 스레드 답글 1회 + notified 마킹 (납품검수 링크 = 생성일 최신)
 *   - PROCESSING → 무발송·무마킹 (watching 유지)
 *   - DROP → dropped 마킹, 답글 없음
 *   - 등록 14일 경과 미완료 → expired 마킹
 *   - 답글(postMessage) 실패 → notified 마킹 안 함 (watching 유지, 다음 tick 재시도)
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const createRetakeWatchPoller = require("../retakeWatchPoller");

const nowIso = () => new Date().toISOString();
const daysAgoIso = (n) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();

function makeStore(rows) {
  const markCalls = [];
  return {
    loadWatching: async () => rows,
    markStatus: async (rowIndex, status, extra) => { markCalls.push({ rowIndex, status, extra }); },
    markCalls,
  };
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

// apiFetch 라우팅: /tasks/{uuid}(단건) vs /tasks?(목록) 구분
function makeApiFetch({ taskState, reviewRows = null }) {
  const calls = [];
  return async (url, options, meta) => {
    calls.push(url);
    if (/\/tasks\?/.test(url)) {
      return { success: true, data: reviewRows || [] };
    }
    if (/\/tasks\/[^?]+$/.test(url)) {
      // 단건 조회 응답은 키가 한글(상태·오퍼레이션유형). 값은 영문 그대로.
      return { success: true, data: { "상태": taskState, "오퍼레이션유형": "OTC0012" } };
    }
    return { success: false };
  };
}

const BASE_ROW = {
  rowIndex: 5,
  registeredAt: nowIso(),
  status: "watching",
  judgeTaskUuid: "judge-1",
  jobUuid: "job-1",
  episode: "21",
  workName: "테스트작품",
  operationName: "번역",
  watchChannel: "C09B8QLR5FG",
  watchThreadTs: "1700000000.000100",
  requesterUserId: "U_CFM",
};

const deps = ({ store, slack, apiFetch }) => ({
  retakeWatchStore: store,
  slackClient: slack,
  apiFetch,
  base: () => "https://gw.example",
  token: () => "tok",
});

describe("retakeWatchPoller.tick", () => {
  test("COMPLETED → 납품 스레드 답글 1회 + notified 마킹 (링크=생성일 최신)", async () => {
    const store = makeStore([{ ...BASE_ROW }]);
    const slack = makeSlack();
    const apiFetch = makeApiFetch({
      taskState: "COMPLETED",
      reviewRows: [
        { 리테이크여부: true, 생성일: "2026-09-20T00:00:00+09:00", taskUuid: "rev-old" },
        { 리테이크여부: true, 생성일: "2026-09-22T00:00:00+09:00", taskUuid: "rev-new" },
        { 리테이크여부: false, 생성일: "2026-09-23T00:00:00+09:00", taskUuid: "rev-notretake" },
      ],
    });
    const poller = createRetakeWatchPoller(deps({ store, slack, apiFetch }));
    await poller.tick();

    assert.strictEqual(slack.postCalls.length, 1);
    const post = slack.postCalls[0];
    assert.strictEqual(post.channel, "C09B8QLR5FG");
    assert.strictEqual(post.thread_ts, "1700000000.000100");
    assert.match(post.text, /rev-new/);          // 생성일 최신 uuid
    assert.doesNotMatch(post.text, /rev-old/);
    assert.match(post.text, /<@U_CFM>/);         // 수정 요청자(CFM) @멘션
    assert.strictEqual(store.markCalls.length, 1);
    assert.strictEqual(store.markCalls[0].rowIndex, 5);
    assert.strictEqual(store.markCalls[0].status, "notified");
    assert.ok(store.markCalls[0].extra.notifiedAt);
  });

  test("PROCESSING → 무발송·무마킹 (watching 유지)", async () => {
    const store = makeStore([{ ...BASE_ROW }]);
    const slack = makeSlack();
    const apiFetch = makeApiFetch({ taskState: "PROCESSING" });
    const poller = createRetakeWatchPoller(deps({ store, slack, apiFetch }));
    await poller.tick();

    assert.strictEqual(slack.postCalls.length, 0);
    assert.strictEqual(store.markCalls.length, 0);
  });

  test("DROP → dropped 마킹, 답글 없음", async () => {
    const store = makeStore([{ ...BASE_ROW }]);
    const slack = makeSlack();
    const apiFetch = makeApiFetch({ taskState: "DROP" });
    const poller = createRetakeWatchPoller(deps({ store, slack, apiFetch }));
    await poller.tick();

    assert.strictEqual(slack.postCalls.length, 0);
    assert.strictEqual(store.markCalls.length, 1);
    assert.strictEqual(store.markCalls[0].status, "dropped");
  });

  test("등록 14일 경과 미완료 → expired 마킹", async () => {
    const store = makeStore([{ ...BASE_ROW, registeredAt: daysAgoIso(20) }]);
    const slack = makeSlack();
    const apiFetch = makeApiFetch({ taskState: "PROCESSING" });
    const poller = createRetakeWatchPoller(deps({ store, slack, apiFetch }));
    await poller.tick();

    assert.strictEqual(slack.postCalls.length, 0);
    assert.strictEqual(store.markCalls.length, 1);
    assert.strictEqual(store.markCalls[0].status, "expired");
  });

  test("답글 실패 → notified 마킹 안 함 (watching 유지)", async () => {
    const store = makeStore([{ ...BASE_ROW }]);
    const slack = makeSlack({ throwOnPost: true });
    const apiFetch = makeApiFetch({ taskState: "COMPLETED", reviewRows: [] });
    const poller = createRetakeWatchPoller(deps({ store, slack, apiFetch }));
    await poller.tick(); // 예외는 행별 try/catch로 삼켜짐

    assert.strictEqual(store.markCalls.length, 0);
  });

  test("COMPLETED이나 납품검수 링크 미해석 → 답글은 발송, note에 표시", async () => {
    const store = makeStore([{ ...BASE_ROW }]);
    const slack = makeSlack();
    const apiFetch = makeApiFetch({ taskState: "COMPLETED", reviewRows: [] });
    const poller = createRetakeWatchPoller(deps({ store, slack, apiFetch }));
    await poller.tick();

    assert.strictEqual(slack.postCalls.length, 1);
    assert.match(slack.postCalls[0].text, /링크를 찾지 못했습니다/);
    assert.strictEqual(store.markCalls[0].status, "notified");
    assert.strictEqual(store.markCalls[0].extra.note, "납품검수 링크 미해석");
  });
});

describe("retakeWatchPoller 감시 대상 채널 필터 (watchChannels)", () => {
  test("대상 채널이 아니면 알림 없이 skipped 처리 (COMPLETED여도)", async () => {
    const store = makeStore([{ ...BASE_ROW, watchChannel: "C_OTHER" }]);
    const slack = makeSlack();
    const apiFetch = makeApiFetch({ taskState: "COMPLETED", reviewRows: [] });
    const poller = createRetakeWatchPoller({ ...deps({ store, slack, apiFetch }), watchChannels: new Set(["C09B8QLR5FG"]) });
    await poller.tick();

    assert.strictEqual(slack.postCalls.length, 0);       // 알림 안 감
    assert.strictEqual(store.markCalls.length, 1);
    assert.strictEqual(store.markCalls[0].status, "skipped");
  });

  test("대상 채널이면 정상 알림", async () => {
    const store = makeStore([{ ...BASE_ROW }]); // watchChannel = C09B8QLR5FG
    const slack = makeSlack();
    const apiFetch = makeApiFetch({ taskState: "COMPLETED", reviewRows: [] });
    const poller = createRetakeWatchPoller({ ...deps({ store, slack, apiFetch }), watchChannels: new Set(["C09B8QLR5FG"]) });
    await poller.tick();

    assert.strictEqual(slack.postCalls.length, 1);
    assert.strictEqual(store.markCalls[0].status, "notified");
  });
});

describe("retakeWatchPoller CFM 폴백 멘션 (watchCfmByChannel)", () => {
  test("requesterUserId 비면 채널별 CFM으로 폴백 태그", async () => {
    // 봇 메시지에 이모지 → requesterUserId 빈 상태로 등록된 행
    const store = makeStore([{ ...BASE_ROW, requesterUserId: "" }]);
    const slack = makeSlack();
    const apiFetch = makeApiFetch({ taskState: "COMPLETED", reviewRows: [] });
    const poller = createRetakeWatchPoller({
      ...deps({ store, slack, apiFetch }),
      watchChannels: new Set(["C09B8QLR5FG"]),
      watchCfmByChannel: new Map([["C09B8QLR5FG", "U07G8KC2EE6"]]),
    });
    await poller.tick();

    assert.strictEqual(slack.postCalls.length, 1);
    assert.match(slack.postCalls[0].text, /<@U07G8KC2EE6>/); // 폴백 CFM 태그
    assert.strictEqual(store.markCalls[0].status, "notified");
  });

  test("requesterUserId 있으면 폴백 무시하고 원문 작성자 우선", async () => {
    const store = makeStore([{ ...BASE_ROW }]); // requesterUserId = U_CFM
    const slack = makeSlack();
    const apiFetch = makeApiFetch({ taskState: "COMPLETED", reviewRows: [] });
    const poller = createRetakeWatchPoller({
      ...deps({ store, slack, apiFetch }),
      watchChannels: new Set(["C09B8QLR5FG"]),
      watchCfmByChannel: new Map([["C09B8QLR5FG", "U07G8KC2EE6"]]),
    });
    await poller.tick();

    assert.strictEqual(slack.postCalls.length, 1);
    assert.match(slack.postCalls[0].text, /<@U_CFM>/);           // 작성자 우선
    assert.doesNotMatch(slack.postCalls[0].text, /U07G8KC2EE6/); // 폴백 미사용
  });

  test("requesterUserId 비고 폴백도 없으면 멘션 생략(기존 동작)", async () => {
    const store = makeStore([{ ...BASE_ROW, requesterUserId: "" }]);
    const slack = makeSlack();
    const apiFetch = makeApiFetch({ taskState: "COMPLETED", reviewRows: [] });
    const poller = createRetakeWatchPoller({
      ...deps({ store, slack, apiFetch }),
      watchChannels: new Set(["C09B8QLR5FG"]),
    });
    await poller.tick();

    assert.strictEqual(slack.postCalls.length, 1);
    assert.doesNotMatch(slack.postCalls[0].text, /<@/); // 멘션 없음
    assert.strictEqual(store.markCalls[0].status, "notified");
  });
});

describe("retakeWatchPoller 작품명 정리 (_cleanWorkName)", () => {
  const poller = createRetakeWatchPoller(deps({
    store: makeStore([]), slack: makeSlack(), apiFetch: makeApiFetch({ taskState: "PROCESSING" }),
  }));

  test("PV코드·플랫폼태그·일본어원제·（仮） 제거 → 한국어 제목만", () => {
    assert.strictEqual(
      poller._cleanWorkName("[PV-177835] [카카오픽코마] 그린라이트 グリーンライト（仮）"),
      "그린라이트"
    );
  });

  test("한자만으로 된 원제도 제거", () => {
    assert.strictEqual(
      poller._cleanWorkName("[PV-188444] [카카오픽코마] 마교일진 魔教不良（仮）"),
      "마교일진"
    );
  });

  test("일본어 뒤의 APP/WEB 구분자는 보존", () => {
    assert.strictEqual(
      poller._cleanWorkName("[PV-183045] [카카오픽코마] 옆집에는 호랑이가 산다 隣には虎が住んでいる（仮）APP"),
      "옆집에는 호랑이가 산다 APP"
    );
  });

  test("이미 깨끗한 제목(중일 작품)은 그대로", () => {
    assert.strictEqual(poller._cleanWorkName("멜로디는 끝나지 않아"), "멜로디는 끝나지 않아");
  });

  test("빈 값·결과 공백이면 원본 보존", () => {
    assert.strictEqual(poller._cleanWorkName(""), "");
    assert.strictEqual(poller._cleanWorkName("魔教"), "魔教"); // 전부 제거되면 원본 유지
  });

  test("알림 본문에 정리된 제목이 들어간다", async () => {
    const store = makeStore([{ ...BASE_ROW, workName: "[PV-177835] [카카오픽코마] 그린라이트 グリーンライト（仮）", episode: "64", operationName: "식자검수" }]);
    const slack = makeSlack();
    const apiFetch = makeApiFetch({ taskState: "COMPLETED", reviewRows: [] });
    const p = createRetakeWatchPoller({ ...deps({ store, slack, apiFetch }), watchChannels: new Set(["C09B8QLR5FG"]) });
    await p.tick();

    assert.strictEqual(slack.postCalls.length, 1);
    assert.match(slack.postCalls[0].text, /\*그린라이트 64화 \[식자검수\]\*/);
    assert.doesNotMatch(slack.postCalls[0].text, /PV-177835/);
    assert.doesNotMatch(slack.postCalls[0].text, /カオ|グリーン|（仮）/);
  });
});
