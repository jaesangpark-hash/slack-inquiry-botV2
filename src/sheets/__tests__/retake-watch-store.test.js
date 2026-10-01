"use strict";
/**
 * sheets/retake-watch-store.js 단위 테스트
 *
 * node:test + node:assert 빌트인. 가짜 sheetsClient 주입 — 실 Google API 없이 도메인 로직 검증.
 *
 * 검증 항목:
 *   registerWatch:
 *     - sheet 미설정 시 skip (append 미호출)
 *     - judgeTaskUuid 없으면 skip
 *     - 정상 append: 16컬럼 payload·컬럼 위치·status="watching"·allTaskUuids join
 *     - judgeTaskUuid 중복 시 skip (append 미호출)
 *   loadWatching:
 *     - status="watching" 행만 반환, rowIndex(시트 실제 행번호) 계산
 *   markStatus:
 *     - status 컬럼(1)·gridId batchUpdate range
 *     - notifiedAt(14)/note(15) 동반 기록
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const createRetakeWatchStore = require("../retake-watch-store");

function makeFakeSheetsClient({ getRows = [], appendThrow = false, batchUpdateThrow = false } = {}) {
  const appendCalls = [];
  const batchUpdateCalls = [];
  const getValuesCalls = [];
  return {
    getValues: async (spreadsheetId, range) => {
      getValuesCalls.push({ spreadsheetId, range });
      return getRows;
    },
    append: async (spreadsheetId, range, rows, opts) => {
      if (appendThrow) throw new Error("fake append error");
      appendCalls.push({ spreadsheetId, range, rows, opts });
      return { data: { updates: { updatedRange: "리테이크 감시!A5:P5" } } };
    },
    batchUpdate: async (spreadsheetId, requests) => {
      if (batchUpdateThrow) throw new Error("fake batchUpdate error");
      batchUpdateCalls.push({ spreadsheetId, requests });
      return { data: {} };
    },
    appendCalls,
    batchUpdateCalls,
    getValuesCalls,
  };
}

const BASE_DEPS = {
  watchSheetId: "watch-sheet-id",
  watchSheetRange: "리테이크 감시!A:P",
  watchGridSheetId: 777,
};

const SAMPLE_WATCH = {
  judgeTaskUuid: "task-judge-1",
  allTaskUuids: ["task-judge-1", "task-sub-2"],
  projectUuid: "proj-1",
  jobUuid: "job-1",
  episode: "21",
  workName: "테스트작품",
  operationCode: "OTC0012",
  operationName: "번역",
  watchChannel: "C09B8QLR5FG",
  watchThreadTs: "1700000000.000100",
  startDate: "2026-09-22T00:00:00+09:00",
  endDate: "2026-09-25T23:59:00+09:00",
  requesterUserId: "U_CFM",
};

describe("createRetakeWatchStore.registerWatch", () => {
  test("sheet 미설정 시 skip — append 미호출", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const store = createRetakeWatchStore({ sheetsClient, watchSheetId: undefined, watchSheetRange: undefined, watchGridSheetId: 777 });
    const res = await store.registerWatch(SAMPLE_WATCH);
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(sheetsClient.appendCalls.length, 0);
  });

  test("judgeTaskUuid 없으면 skip", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const store = createRetakeWatchStore({ sheetsClient, ...BASE_DEPS });
    const res = await store.registerWatch({ ...SAMPLE_WATCH, judgeTaskUuid: "" });
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(sheetsClient.appendCalls.length, 0);
  });

  test("정상 append — 16컬럼 payload·컬럼 위치·status=watching·allTaskUuids join", async () => {
    const sheetsClient = makeFakeSheetsClient({ getRows: [["등록시각", "status"]] }); // 헤더만
    const store = createRetakeWatchStore({ sheetsClient, ...BASE_DEPS });
    const res = await store.registerWatch(SAMPLE_WATCH);

    assert.strictEqual(res.skipped, false);
    assert.strictEqual(res.rowIndex, 5);
    assert.strictEqual(sheetsClient.appendCalls.length, 1);
    const call = sheetsClient.appendCalls[0];
    assert.strictEqual(call.spreadsheetId, "watch-sheet-id");
    assert.strictEqual(call.range, "리테이크 감시!A:P");
    assert.strictEqual(call.opts.valueInputOption, "RAW"); // ts·uuid 소수부/문자열 보존 (형민님 검수)
    const row = call.rows[0];
    assert.strictEqual(row.length, 17);
    assert.strictEqual(row[1], "watching");            // status
    assert.strictEqual(row[16], "U_CFM");              // requesterUserId (CFM 멘션용)
    assert.strictEqual(row[2], "task-judge-1");        // judgeTaskUuid
    assert.strictEqual(row[3], "task-judge-1,task-sub-2"); // allTaskUuids join
    assert.strictEqual(row[4], "proj-1");              // projectUuid
    assert.strictEqual(row[5], "job-1");               // jobUuid
    assert.strictEqual(row[6], "21");                  // episode
    assert.strictEqual(row[7], "테스트작품");           // workName
    assert.strictEqual(row[8], "OTC0012");             // operationCode
    assert.strictEqual(row[9], "번역");                 // operationName
    assert.strictEqual(row[10], "C09B8QLR5FG");        // watchChannel
    assert.strictEqual(row[11], "1700000000.000100");  // watchThreadTs
    assert.strictEqual(row[14], "");                   // notifiedAt (미기록)
  });

  test("judgeTaskUuid 중복 시 skip — append 미호출", async () => {
    // 기존 시트에 동일 judgeTaskUuid 행이 이미 존재(상태 무관: notified)
    const getRows = [
      ["등록시각", "status", "judgeTaskUuid"],
      ["t", "notified", "task-judge-1"],
    ];
    const sheetsClient = makeFakeSheetsClient({ getRows });
    const store = createRetakeWatchStore({ sheetsClient, ...BASE_DEPS });
    const res = await store.registerWatch(SAMPLE_WATCH);
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(res.reason, "중복");
    assert.strictEqual(sheetsClient.appendCalls.length, 0);
  });
});

describe("createRetakeWatchStore.loadWatching", () => {
  test("status=watching 행만 반환하고 rowIndex(시트 실제 행번호)를 계산한다", async () => {
    const getRows = [
      ["등록시각", "status", "judgeTaskUuid", "allTaskUuids", "projectUuid", "jobUuid", "episode", "workName", "operationCode", "operationName", "watchChannel", "watchThreadTs", "startDate", "endDate", "notifiedAt", "note"],
      ["t1", "watching", "uuid-a", "uuid-a", "p1", "j1", "10", "작품A", "OTC0012", "번역", "C1", "111.1", "s", "e", "", "", "U_CFM1"],   // 2행
      ["t2", "notified", "uuid-b", "uuid-b", "p2", "j2", "11", "작품B", "OTC0013", "번역검수", "C2", "222.2", "s", "e", "n", ""], // 3행
      ["t3", "watching", "uuid-c", "uuid-c", "p3", "j3", "12", "작품C", "OTC0014", "식자", "C3", "333.3", "s", "e", "", ""],   // 4행
    ];
    const sheetsClient = makeFakeSheetsClient({ getRows });
    const store = createRetakeWatchStore({ sheetsClient, ...BASE_DEPS });
    const watching = await store.loadWatching();
    assert.strictEqual(watching.length, 2);
    assert.strictEqual(watching[0].judgeTaskUuid, "uuid-a");
    assert.strictEqual(watching[0].rowIndex, 2);
    assert.strictEqual(watching[0].watchChannel, "C1");
    assert.strictEqual(watching[0].watchThreadTs, "111.1");
    assert.strictEqual(watching[0].requesterUserId, "U_CFM1");
    assert.strictEqual(watching[1].judgeTaskUuid, "uuid-c");
    assert.strictEqual(watching[1].rowIndex, 4);
  });

  test("sheet 미설정 시 빈 배열", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const store = createRetakeWatchStore({ sheetsClient, watchSheetId: undefined, watchSheetRange: undefined, watchGridSheetId: 777 });
    const watching = await store.loadWatching();
    assert.deepStrictEqual(watching, []);
  });
});

describe("createRetakeWatchStore.markStatus", () => {
  test("status 컬럼(1)·gridId batchUpdate range", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const store = createRetakeWatchStore({ sheetsClient, ...BASE_DEPS });
    await store.markStatus(5, "dropped");

    assert.strictEqual(sheetsClient.batchUpdateCalls.length, 1);
    const requests = sheetsClient.batchUpdateCalls[0].requests;
    assert.strictEqual(requests.length, 1);
    const range = requests[0].updateCells.range;
    assert.strictEqual(range.sheetId, 777);
    assert.strictEqual(range.startRowIndex, 4);        // rowIndex - 1
    assert.strictEqual(range.endRowIndex, 5);
    assert.strictEqual(range.startColumnIndex, 1);     // status
    assert.strictEqual(range.endColumnIndex, 2);
    assert.strictEqual(
      requests[0].updateCells.rows[0].values[0].userEnteredValue.stringValue, "dropped");
  });

  test("notifiedAt/note 동반 기록 — 두 번째 updateCells가 컬럼 14~16", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const store = createRetakeWatchStore({ sheetsClient, ...BASE_DEPS });
    await store.markStatus(5, "notified", { notifiedAt: "2026-09-22 10:00", note: "완료알림" });

    const requests = sheetsClient.batchUpdateCalls[0].requests;
    assert.strictEqual(requests.length, 2);
    const range2 = requests[1].updateCells.range;
    assert.strictEqual(range2.startColumnIndex, 14);   // notifiedAt
    assert.strictEqual(range2.endColumnIndex, 16);     // note+1
    const vals = requests[1].updateCells.rows[0].values;
    assert.strictEqual(vals[0].userEnteredValue.stringValue, "2026-09-22 10:00");
    assert.strictEqual(vals[1].userEnteredValue.stringValue, "완료알림");
  });

  test("gridId 미설정 시 batchUpdate 미호출", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const store = createRetakeWatchStore({ sheetsClient, watchSheetId: "id", watchSheetRange: "리테이크 감시!A:P", watchGridSheetId: undefined });
    await store.markStatus(5, "notified");
    assert.strictEqual(sheetsClient.batchUpdateCalls.length, 0);
  });
});

describe("createRetakeWatchStore 활성 게이트 (시트ID·gridId 둘 다 필요)", () => {
  test("gridId만 빠지면 감시 off — registerWatch skip(append 미호출), loadWatching []", async () => {
    const sheetsClient = makeFakeSheetsClient({ getRows: [["header"], ["t", "watching", "uuid-x"]] });
    const store = createRetakeWatchStore({
      sheetsClient,
      watchSheetId: "watch-sheet-id",
      watchSheetRange: "리테이크 감시!A:P",
      watchGridSheetId: undefined, // gridId 없음
    });
    assert.strictEqual(store.enabled, false);

    const res = await store.registerWatch(SAMPLE_WATCH);
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(sheetsClient.appendCalls.length, 0);

    const watching = await store.loadWatching();
    assert.deepStrictEqual(watching, []);
    assert.strictEqual(sheetsClient.getValuesCalls.length, 0); // 조회조차 안 함
  });

  test("sheetId만 빠지면 감시 off — registerWatch skip", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const store = createRetakeWatchStore({
      sheetsClient,
      watchSheetId: "",
      watchSheetRange: "리테이크 감시!A:P",
      watchGridSheetId: 777,
    });
    assert.strictEqual(store.enabled, false);
    const res = await store.registerWatch(SAMPLE_WATCH);
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(sheetsClient.appendCalls.length, 0);
  });

  test("셋 다 있으면 감시 on — enabled true", () => {
    const sheetsClient = makeFakeSheetsClient();
    const store = createRetakeWatchStore({ sheetsClient, ...BASE_DEPS });
    assert.strictEqual(store.enabled, true);
  });
});
