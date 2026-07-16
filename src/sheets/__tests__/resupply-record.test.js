"use strict";
/**
 * sheets/resupply-record.js 단위 테스트
 *
 * node:test + node:assert 빌트인 사용.
 * 가짜 sheetsClient·Slack client 주입 — 실 API 없이 도메인 로직 검증.
 *
 * 검증 항목:
 *   appendResupplyRecord:
 *     - Slack users.info 조회 성공 시 display_name 사용
 *     - users.info 실패 시 submitterId fallback (silent 무시 — 기존 동작 보존)
 *     - sheetsClient.append 호출 payload 검증 (spreadsheetId·range·rows·opts)
 *     - rows 구조: 8컬럼 [requesterName, apmName, workName, episodeAndFiles, reason, now, sourceLink, japaneseFixedTitle]
 *     - episode 있을 때 / 없을 때 episodeAndFiles 조합
 *     - fileNumbers 있을 때 / 없을 때
 *     - 성공 시 rowIndex 반환 (updatedRange 파싱)
 *     - updatedRange 없을 때 null 반환
 *     - sheetsClient.append throw 시 호출자에게 에러 전파
 *   checkResupplyDone:
 *     - rowIndex null/undefined 시 sheetsClient.batchUpdate 미호출 (early return)
 *     - sheetsClient.batchUpdate 호출 payload 검증 (spreadsheetId·requests 구조)
 *     - resupplyGridSheetId·startRowIndex·endRowIndex 정확히 전달
 *     - L열 체크박스 true 업데이트 검증
 *     - batchUpdate throw 시 호출자에게 에러 전파
 *     - F2 invariant: sheetsClient는 알림·로깅 없이 throw만
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const createResupplyRecord = require("../resupply-record");

// ── fake sheetsClient ─────────────────────────────────────────────────────────
function makeFakeSheetsClient({ appendThrow = false, batchUpdateThrow = false, updatedRange = "Sheet1!A10:H10" } = {}) {
  const appendCalls = [];
  const batchUpdateCalls = [];
  return {
    append: async (spreadsheetId, range, rows, opts) => {
      if (appendThrow) throw new Error("fake append error");
      appendCalls.push({ spreadsheetId, range, rows, opts });
      return { data: { updates: { updatedRange } } };
    },
    batchUpdate: async (spreadsheetId, requests) => {
      if (batchUpdateThrow) throw new Error("fake batchUpdate error");
      batchUpdateCalls.push({ spreadsheetId, requests });
      return { data: {} };
    },
    appendCalls,
    batchUpdateCalls,
  };
}

// ── fake Slack client ─────────────────────────────────────────────────────────
function makeFakeSlackClient({ displayName = null, realName = null, shouldThrow = false } = {}) {
  return {
    users: {
      info: async ({ user }) => {
        if (shouldThrow) throw new Error("fake users.info error");
        return {
          user: {
            profile: { display_name: displayName },
            real_name: realName,
          },
        };
      },
    },
  };
}

const BASE_DEPS = {
  resupplySheetId: "resupply-sheet-id",
  resupplySheetRange: "Resupply!A:H",
  resupplyGridSheetId: 511152201,
};

describe("createResupplyRecord.appendResupplyRecord", () => {
  test("users.info display_name 사용 — requesterName·apmName 모두 display_name", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const slackClient = makeFakeSlackClient({ displayName: "홍길동" });
    const { appendResupplyRecord } = createResupplyRecord({ sheetsClient, ...BASE_DEPS });

    await appendResupplyRecord({ workName: "작품A", episode: "1", fileNumbers: [], reason: "파손" }, "U123", slackClient);

    const rows = sheetsClient.appendCalls[0].rows[0];
    assert.strictEqual(rows[0], "홍길동");  // requesterName
    assert.strictEqual(rows[1], "홍길동");  // apmName
  });

  test("users.info display_name 없을 때 real_name fallback", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const slackClient = makeFakeSlackClient({ displayName: "", realName: "홍길동실명" });
    const { appendResupplyRecord } = createResupplyRecord({ sheetsClient, ...BASE_DEPS });

    await appendResupplyRecord({ workName: "작품A" }, "U123", slackClient);

    const rows = sheetsClient.appendCalls[0].rows[0];
    assert.strictEqual(rows[0], "홍길동실명");
  });

  test("users.info throw 시 submitterId fallback (silent 무시)", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const slackClient = makeFakeSlackClient({ shouldThrow: true });
    const { appendResupplyRecord } = createResupplyRecord({ sheetsClient, ...BASE_DEPS });

    await appendResupplyRecord({ workName: "작품A" }, "U999", slackClient);

    const rows = sheetsClient.appendCalls[0].rows[0];
    assert.strictEqual(rows[0], "U999");  // submitterId fallback
  });

  test("sheetsClient.append 호출 — spreadsheetId·range 전달 검증", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const { appendResupplyRecord } = createResupplyRecord({ sheetsClient, ...BASE_DEPS });

    await appendResupplyRecord({ workName: "작품B" }, "U001", makeFakeSlackClient({ displayName: "작업자" }));

    assert.strictEqual(sheetsClient.appendCalls.length, 1);
    assert.strictEqual(sheetsClient.appendCalls[0].spreadsheetId, "resupply-sheet-id");
    assert.strictEqual(sheetsClient.appendCalls[0].range, "Resupply!A:H");
  });

  test("rows 구조 8컬럼 검증 — reason·sourceLink·japaneseFixedTitle", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const { appendResupplyRecord } = createResupplyRecord({ sheetsClient, ...BASE_DEPS });
    const draft = {
      workName: "테스트작품",
      episode: "5",
      fileNumbers: ["3", "4"],
      reason: "파일손상",
      sourceLink: "https://example.com/src",
      japaneseFixedTitle: "テスト作品",
    };

    await appendResupplyRecord(draft, "U111", makeFakeSlackClient({ displayName: "테스터" }));

    const rows = sheetsClient.appendCalls[0].rows[0];
    assert.strictEqual(rows.length, 8);
    assert.strictEqual(rows[2], "테스트작품");         // workName
    assert.strictEqual(rows[3], "5화 / 3, 4");         // episodeAndFiles
    assert.strictEqual(rows[4], "파일손상");            // reason
    // rows[5] = now (동적)
    assert.strictEqual(rows[6], "https://example.com/src"); // sourceLink
    assert.strictEqual(rows[7], "テスト作品");          // japaneseFixedTitle
  });

  test("episode만 있을 때 episodeAndFiles = '3화'", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const { appendResupplyRecord } = createResupplyRecord({ sheetsClient, ...BASE_DEPS });

    await appendResupplyRecord(
      { episode: "3", fileNumbers: [] },
      "U001",
      makeFakeSlackClient({ displayName: "작업자" })
    );

    const rows = sheetsClient.appendCalls[0].rows[0];
    assert.strictEqual(rows[3], "3화");
  });

  test("fileNumbers만 있을 때 episodeAndFiles = '5, 6'", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const { appendResupplyRecord } = createResupplyRecord({ sheetsClient, ...BASE_DEPS });

    await appendResupplyRecord(
      { episode: null, fileNumbers: ["5", "6"] },
      "U001",
      makeFakeSlackClient({ displayName: "작업자" })
    );

    const rows = sheetsClient.appendCalls[0].rows[0];
    assert.strictEqual(rows[3], "5, 6");
  });

  test("episode·fileNumbers 모두 없을 때 episodeAndFiles = '-'", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const { appendResupplyRecord } = createResupplyRecord({ sheetsClient, ...BASE_DEPS });

    await appendResupplyRecord({ episode: null, fileNumbers: [] }, "U001", makeFakeSlackClient({ displayName: "작업자" }));

    const rows = sheetsClient.appendCalls[0].rows[0];
    assert.strictEqual(rows[3], "-");
  });

  test("opts에 올바른 쿼리 파라미터 전달 (valueInputOption·insertDataOption 등)", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const { appendResupplyRecord } = createResupplyRecord({ sheetsClient, ...BASE_DEPS });

    await appendResupplyRecord({}, "U001", makeFakeSlackClient({ displayName: "작업자" }));

    const opts = sheetsClient.appendCalls[0].opts;
    assert.strictEqual(opts.valueInputOption, "USER_ENTERED");
    assert.strictEqual(opts.insertDataOption, "INSERT_ROWS");
    assert.strictEqual(opts.includeValuesInResponse, false);
    assert.strictEqual(opts.responseValueRenderOption, "UNFORMATTED_VALUE");
  });

  test("성공 시 rowIndex 반환 — updatedRange 끝 숫자 파싱", async () => {
    const sheetsClient = makeFakeSheetsClient({ updatedRange: "Resupply!A15:H15" });
    const { appendResupplyRecord } = createResupplyRecord({ sheetsClient, ...BASE_DEPS });

    const rowIndex = await appendResupplyRecord({}, "U001", makeFakeSlackClient({ displayName: "작업자" }));

    assert.strictEqual(rowIndex, 15);
  });

  test("updatedRange 없을 때 rowIndex = null 반환", async () => {
    const fakeSheetsClient = {
      append: async () => ({ data: { updates: {} } }),
      batchUpdate: async () => ({ data: {} }),
    };
    const { appendResupplyRecord } = createResupplyRecord({ sheetsClient: fakeSheetsClient, ...BASE_DEPS });

    const rowIndex = await appendResupplyRecord({}, "U001", makeFakeSlackClient({ displayName: "작업자" }));

    assert.strictEqual(rowIndex, null);
  });

  test("sheetsClient.append throw 시 호출자에게 에러 전파", async () => {
    const sheetsClient = makeFakeSheetsClient({ appendThrow: true });
    const { appendResupplyRecord } = createResupplyRecord({ sheetsClient, ...BASE_DEPS });
    await assert.rejects(
      () => appendResupplyRecord({}, "U001", makeFakeSlackClient({ displayName: "작업자" })),
      /fake append error/
    );
  });
});

describe("createResupplyRecord.checkResupplyDone", () => {
  test("rowIndex null 시 명시적으로 실패하고 sheetsClient.batchUpdate를 호출하지 않는다", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const { checkResupplyDone } = createResupplyRecord({ sheetsClient, ...BASE_DEPS });

    await assert.rejects(() => checkResupplyDone(null), /행 번호/);

    assert.strictEqual(sheetsClient.batchUpdateCalls.length, 0);
  });

  test("rowIndex undefined 시 명시적으로 실패한다", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const { checkResupplyDone } = createResupplyRecord({ sheetsClient, ...BASE_DEPS });

    await assert.rejects(() => checkResupplyDone(undefined), /행 번호/);

    assert.strictEqual(sheetsClient.batchUpdateCalls.length, 0);
  });

  test("완료용 sheet 설정이 누락되면 명시적으로 실패한다", async () => {
    const cases = [
      { resupplySheetId: undefined, resupplyGridSheetId: 511152201, message: /spreadsheet ID/ },
      { resupplySheetId: "sheet-id", resupplyGridSheetId: undefined, message: /grid sheet ID/ },
    ];
    for (const testCase of cases) {
      const sheetsClient = makeFakeSheetsClient();
      const { checkResupplyDone } = createResupplyRecord({
        sheetsClient,
        resupplySheetRange: "Resupply!A:H",
        ...testCase,
      });
      await assert.rejects(() => checkResupplyDone(10), testCase.message);
      assert.equal(sheetsClient.batchUpdateCalls.length, 0);
    }
  });

  test("sheetsClient.batchUpdate 호출 — spreadsheetId 전달 검증", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const { checkResupplyDone } = createResupplyRecord({ sheetsClient, ...BASE_DEPS });

    await checkResupplyDone(10);

    assert.strictEqual(sheetsClient.batchUpdateCalls.length, 1);
    assert.strictEqual(sheetsClient.batchUpdateCalls[0].spreadsheetId, "resupply-sheet-id");
  });

  test("requests 구조 검증 — updateCells.range에 resupplyGridSheetId·행·L열", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const { checkResupplyDone } = createResupplyRecord({ sheetsClient, ...BASE_DEPS });

    await checkResupplyDone(10);

    const requests = sheetsClient.batchUpdateCalls[0].requests;
    assert.strictEqual(requests.length, 1);
    const updateCells = requests[0].updateCells;
    assert.ok(updateCells, "updateCells 존재");
    assert.strictEqual(updateCells.range.sheetId, 511152201);
    assert.strictEqual(updateCells.range.startRowIndex, 9);   // rowIndex - 1
    assert.strictEqual(updateCells.range.endRowIndex, 10);    // rowIndex
    assert.strictEqual(updateCells.range.startColumnIndex, 11);
    assert.strictEqual(updateCells.range.endColumnIndex, 12);
  });

  test("완료 체크박스 true 값 검증", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const { checkResupplyDone } = createResupplyRecord({ sheetsClient, ...BASE_DEPS });

    await checkResupplyDone(5);

    const updateCells = sheetsClient.batchUpdateCalls[0].requests[0].updateCells;
    assert.deepStrictEqual(
      updateCells.rows,
      [{ values: [{ userEnteredValue: { boolValue: true } }] }]
    );
    assert.strictEqual(updateCells.fields, "userEnteredValue.boolValue");
  });

  test("batchUpdate throw 시 호출자에게 에러 전파", async () => {
    const sheetsClient = makeFakeSheetsClient({ batchUpdateThrow: true });
    const { checkResupplyDone } = createResupplyRecord({ sheetsClient, ...BASE_DEPS });
    await assert.rejects(() => checkResupplyDone(5), /fake batchUpdate error/);
  });
});
