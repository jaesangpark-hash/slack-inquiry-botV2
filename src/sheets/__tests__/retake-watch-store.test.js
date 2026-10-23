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
  ownerUserId: "U_APM",
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

  test("정상 append — 20컬럼 payload·컬럼 위치·status=watching·allTaskUuids join", async () => {
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
    assert.strictEqual(row.length, 20);
    assert.strictEqual(row[1], "watching");            // status
    assert.strictEqual(row[16], "U_CFM");              // requesterUserId (CFM 멘션용)
    assert.strictEqual(row[17], "U_APM");              // ownerUserId (소환 담당자 멘션용)
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

describe("createRetakeWatchStore.markStatusMany", () => {
  test("여러 행을 batchUpdate 1회로 기록 (호출 한 번, 행마다 status+note 2 request)", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const store = createRetakeWatchStore({ sheetsClient, ...BASE_DEPS });
    await store.markStatusMany([
      { rowIndex: 5, status: "skipped", note: "감시 대상 채널 아님" },
      { rowIndex: 6, status: "skipped", note: "감시 대상 채널 아님" },
      { rowIndex: 7, status: "skipped", note: "감시 대상 채널 아님" },
    ]);
    assert.strictEqual(sheetsClient.batchUpdateCalls.length, 1);          // 호출 1회
    assert.strictEqual(sheetsClient.batchUpdateCalls[0].requests.length, 6); // 3행 × (status+note)
    // 첫 행 status request 위치 검증 (status 컬럼 = 1)
    const r0 = sheetsClient.batchUpdateCalls[0].requests[0].updateCells;
    assert.strictEqual(r0.range.startColumnIndex, 1);
    assert.strictEqual(r0.rows[0].values[0].userEnteredValue.stringValue, "skipped");
  });

  test("note 없으면 행당 request 1개(status만)", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const store = createRetakeWatchStore({ sheetsClient, ...BASE_DEPS });
    await store.markStatusMany([{ rowIndex: 5, status: "skipped" }]);
    assert.strictEqual(sheetsClient.batchUpdateCalls[0].requests.length, 1);
  });

  test("빈 배열·rowIndex 없는 항목은 호출 안 함", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const store = createRetakeWatchStore({ sheetsClient, ...BASE_DEPS });
    await store.markStatusMany([]);
    await store.markStatusMany([{ status: "skipped" }]); // rowIndex 없음
    assert.strictEqual(sheetsClient.batchUpdateCalls.length, 0);
  });

  test("감시 off면 기록 안 함", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const store = createRetakeWatchStore({ sheetsClient, watchSheetId: "", watchSheetRange: "리테이크 감시!A:P", watchGridSheetId: 777 });
    await store.markStatusMany([{ rowIndex: 5, status: "skipped" }]);
    assert.strictEqual(sheetsClient.batchUpdateCalls.length, 0);
  });
});

describe("createRetakeWatchStore.cleanupOldRows (rolling 보존)", () => {
  // now 고정: 2026-10-23 12:00 KST → maxAgeDays=21 컷오프 = 2026-10-02 12:00 KST
  const NOW = new Date("2026-10-23T12:00:00+09:00");
  // 데이터 행 0번째(getRows[1]) = 시트 2행 = 0-base 1
  const rowOf = (registeredAt, uuid = "") => [registeredAt, "watching", uuid];
  const HEADER = ["등록시각", "status", "judgeTaskUuid"];

  test("21일 넘은 행만 삭제, 최근 행·헤더 보존(비연속 → 구간별, 내림차순)", async () => {
    const getRows = [
      HEADER,
      rowOf("2026-09-01T10:00:00+09:00", "old-1"),  // 행2(0b1) 삭제
      rowOf("2026-10-20T10:00:00+09:00", "new-1"),  // 행3(0b2) 보존
      rowOf("2026-09-30T10:00:00+09:00", "old-2"),  // 행4(0b3) 삭제
      rowOf("2026-10-22T10:00:00+09:00", "new-2"),  // 행5(0b4) 보존
    ];
    const sheetsClient = makeFakeSheetsClient({ getRows });
    const store = createRetakeWatchStore({ sheetsClient, ...BASE_DEPS });
    const res = await store.cleanupOldRows({ maxAgeDays: 21, now: NOW });

    assert.strictEqual(res.deleted, 2);
    assert.strictEqual(res.scanned, 4);
    assert.strictEqual(sheetsClient.batchUpdateCalls.length, 1);
    const reqs = sheetsClient.batchUpdateCalls[0].requests;
    assert.strictEqual(reqs.length, 2); // 비연속 → 구간 2개
    // 내림차순: 먼저 아래쪽(0b3) 삭제, 그 다음 위쪽(0b1)
    assert.deepStrictEqual(reqs.map(r => [r.deleteDimension.range.startIndex, r.deleteDimension.range.endIndex]), [[3, 4], [1, 2]]);
    reqs.forEach(r => {
      assert.strictEqual(r.deleteDimension.range.dimension, "ROWS");
      assert.strictEqual(r.deleteDimension.range.sheetId, 777);
    });
  });

  test("연속한 오래된 행은 한 구간으로 병합", async () => {
    const getRows = [
      HEADER,
      rowOf("2026-09-01T10:00:00+09:00", "old-1"), // 0b1 삭제
      rowOf("2026-09-05T10:00:00+09:00", "old-2"), // 0b2 삭제
      rowOf("2026-10-22T10:00:00+09:00", "new-1"), // 0b3 보존
    ];
    const sheetsClient = makeFakeSheetsClient({ getRows });
    const store = createRetakeWatchStore({ sheetsClient, ...BASE_DEPS });
    const res = await store.cleanupOldRows({ maxAgeDays: 21, now: NOW });
    assert.strictEqual(res.deleted, 2);
    const reqs = sheetsClient.batchUpdateCalls[0].requests;
    assert.strictEqual(reqs.length, 1); // [1,3) 하나로 병합
    assert.deepStrictEqual([reqs[0].deleteDimension.range.startIndex, reqs[0].deleteDimension.range.endIndex], [1, 3]);
  });

  test("registeredAt 파싱 불가/빈값 행은 보존(삭제 안 함)", async () => {
    const getRows = [
      HEADER,
      rowOf("", "nodate"),                          // 빈값 → 보존
      rowOf("언젠가", "bad"),                        // 파싱 불가 → 보존
      rowOf("2026-09-01T10:00:00+09:00", "old-1"),  // 0b3 삭제
    ];
    const sheetsClient = makeFakeSheetsClient({ getRows });
    const store = createRetakeWatchStore({ sheetsClient, ...BASE_DEPS });
    const res = await store.cleanupOldRows({ maxAgeDays: 21, now: NOW });
    assert.strictEqual(res.deleted, 1);
    assert.strictEqual(res.skippedUnparsable, 2);
    const reqs = sheetsClient.batchUpdateCalls[0].requests;
    assert.deepStrictEqual([reqs[0].deleteDimension.range.startIndex, reqs[0].deleteDimension.range.endIndex], [3, 4]);
  });

  test("삭제 대상 없으면 batchUpdate 미호출", async () => {
    const getRows = [
      HEADER,
      rowOf("2026-10-20T10:00:00+09:00", "new-1"),
      rowOf("2026-10-22T10:00:00+09:00", "new-2"),
    ];
    const sheetsClient = makeFakeSheetsClient({ getRows });
    const store = createRetakeWatchStore({ sheetsClient, ...BASE_DEPS });
    const res = await store.cleanupOldRows({ maxAgeDays: 21, now: NOW });
    assert.strictEqual(res.deleted, 0);
    assert.strictEqual(res.scanned, 2);
    assert.strictEqual(sheetsClient.batchUpdateCalls.length, 0);
  });

  test("기본 보존기간 21일 — 옵션 없이 호출돼도 동작", async () => {
    const getRows = [HEADER, rowOf("2000-01-01T10:00:00+09:00", "ancient")];
    const sheetsClient = makeFakeSheetsClient({ getRows });
    const store = createRetakeWatchStore({ sheetsClient, ...BASE_DEPS });
    const res = await store.cleanupOldRows(); // now=현재, maxAgeDays=21 기본
    assert.strictEqual(res.deleted, 1);
  });

  test("감시 off면 no-op(삭제·호출 없음)", async () => {
    const sheetsClient = makeFakeSheetsClient({ getRows: [["h"], ["2000-01-01T00:00:00+09:00", "watching", "x"]] });
    const store = createRetakeWatchStore({ sheetsClient, watchSheetId: "", watchSheetRange: "리테이크 감시!A:P", watchGridSheetId: 777 });
    const res = await store.cleanupOldRows({ maxAgeDays: 21, now: NOW });
    assert.strictEqual(res.deleted, 0);
    assert.strictEqual(sheetsClient.batchUpdateCalls.length, 0);
  });
});

describe("createRetakeWatchStore.setWorkerThread", () => {
  // getValues는 makeFakeSheetsClient의 getRows를 반환. 데이터는 values[1] → rowIndex 2.
  const getRows = [
    ["등록시각", "status", "judgeTaskUuid"],
    ["2026-10-21T10:00:00+09:00", "watching", "task-judge-1"],
  ];

  test("judgeTaskUuid로 행 찾아 workerChannel·workerThreadTs 기록(batchUpdate 1회, ts 소수부 보존)", async () => {
    const sheetsClient = makeFakeSheetsClient({ getRows });
    const store = createRetakeWatchStore({ sheetsClient, ...BASE_DEPS });
    const res = await store.setWorkerThread("task-judge-1", { workerChannel: "C_WORK", workerThreadTs: "1790999999.000100" });

    assert.strictEqual(res.updated, true);
    assert.strictEqual(res.rowIndex, 2);
    assert.strictEqual(sheetsClient.batchUpdateCalls.length, 1);
    const uc = sheetsClient.batchUpdateCalls[0].requests[0].updateCells;
    assert.strictEqual(uc.range.startColumnIndex, 18);  // workerChannel(S)
    assert.strictEqual(uc.range.endColumnIndex, 20);    // workerThreadTs(T)+1
    assert.strictEqual(uc.rows[0].values[0].userEnteredValue.stringValue, "C_WORK");
    assert.strictEqual(uc.rows[0].values[1].userEnteredValue.stringValue, "1790999999.000100");
  });

  test("해당 judgeTaskUuid 행이 없으면 no-op(기록 안 함)", async () => {
    const sheetsClient = makeFakeSheetsClient({ getRows });
    const store = createRetakeWatchStore({ sheetsClient, ...BASE_DEPS });
    const res = await store.setWorkerThread("없는-uuid", { workerChannel: "C_WORK", workerThreadTs: "1" });
    assert.strictEqual(res.updated, false);
    assert.strictEqual(sheetsClient.batchUpdateCalls.length, 0);
  });

  test("감시 off면 no-op", async () => {
    const sheetsClient = makeFakeSheetsClient({ getRows });
    const store = createRetakeWatchStore({ sheetsClient, watchSheetId: "", watchSheetRange: "리테이크 감시!A:T", watchGridSheetId: 777 });
    const res = await store.setWorkerThread("task-judge-1", { workerChannel: "C_WORK", workerThreadTs: "1" });
    assert.strictEqual(res.updated, false);
    assert.strictEqual(sheetsClient.batchUpdateCalls.length, 0);
  });
});
