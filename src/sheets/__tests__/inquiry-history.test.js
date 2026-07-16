"use strict";
/**
 * sheets/inquiry-history.js 단위 테스트
 *
 * node:test + node:assert 빌트인 사용.
 * 가짜 sheetsClient 주입 — 실 Google API 없이 도메인 로직 검증.
 *
 * 검증 항목:
 *   appendInquiryHistory:
 *     - historySheetId 미설정 시 early return (sheetsClient.append 미호출)
 *     - historySheetRange 미설정 시 early return
 *     - 설정 시 sheetsClient.append 호출, spreadsheetId·range·rows payload 검증
 *     - append rows 구조: [now, workName, workNameKo, inquiryType, summary, actionRequired, sourceLink, submitterId, completed]
 *     - draft 필드 빈값 → "" fallback
 *     - sheetsClient.append throw 시 호출자에게 에러 전파
 */

const { test, describe, mock, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const createInquiryHistory = require("../inquiry-history");

// ── fake sheetsClient ─────────────────────────────────────────────────────────
function makeFakeSheetsClient({ shouldThrow = false, batchUpdateThrow = false } = {}) {
  const appendCalls = [];
  const batchUpdateCalls = [];
  return {
    append: async (spreadsheetId, range, rows, opts) => {
      if (shouldThrow) throw new Error("fake append error");
      appendCalls.push({ spreadsheetId, range, rows, opts });
      return { data: { updates: { updatedRange: "Sheet1!A10:H10" } } };
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

describe("createInquiryHistory.appendInquiryHistory", () => {
  test("historySheetId 미설정 시 early return — sheetsClient.append 미호출", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const { appendInquiryHistory } = createInquiryHistory({
      sheetsClient,
      historySheetId: undefined,
      historySheetRange: "Sheet1!A:I",
    });
    await appendInquiryHistory({ workName: "작품A" }, "U123");
    assert.strictEqual(sheetsClient.appendCalls.length, 0);
  });

  test("historySheetRange 미설정 시 early return — sheetsClient.append 미호출", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const { appendInquiryHistory } = createInquiryHistory({
      sheetsClient,
      historySheetId: "sheet-id-123",
      historySheetRange: undefined,
    });
    await appendInquiryHistory({ workName: "작품A" }, "U123");
    assert.strictEqual(sheetsClient.appendCalls.length, 0);
  });

  test("빈 문자열 historySheetId → early return", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const { appendInquiryHistory } = createInquiryHistory({
      sheetsClient,
      historySheetId: "",
      historySheetRange: "Sheet1!A:I",
    });
    await appendInquiryHistory({ workName: "작품A" }, "U123");
    assert.strictEqual(sheetsClient.appendCalls.length, 0);
  });

  test("설정 시 sheetsClient.append 호출 — spreadsheetId·range 전달 검증", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const { appendInquiryHistory } = createInquiryHistory({
      sheetsClient,
      historySheetId: "sheet-id-abc",
      historySheetRange: "History!A:I",
    });
    await appendInquiryHistory({ workName: "작품B" }, "U456");
    assert.strictEqual(sheetsClient.appendCalls.length, 1);
    assert.strictEqual(sheetsClient.appendCalls[0].spreadsheetId, "sheet-id-abc");
    assert.strictEqual(sheetsClient.appendCalls[0].range, "History!A:I");
  });

  test("rows 구조: 9컬럼 [now, workName, workNameKo, inquiryType, summary, actionRequired, sourceLink, submitterId, completed]", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const { appendInquiryHistory } = createInquiryHistory({
      sheetsClient,
      historySheetId: "sheet-id-abc",
      historySheetRange: "History!A:I",
    });
    const draft = {
      workName: "테스트작품",
      workNameKo: "테스트작품KO",
      inquiryType: "재수급",
      summary: "요약텍스트",
      actionRequired: "조치사항",
      sourceLink: "https://example.com",
    };
    await appendInquiryHistory(draft, "U789");
    const call = sheetsClient.appendCalls[0];
    const row = call.rows[0];
    // rows는 2D 배열, 첫 번째 행
    assert.strictEqual(row.length, 9);
    // 인덱스 1~8 검증 (0번은 now — 동적 타임스탬프라 검증 스킵)
    assert.strictEqual(row[1], "테스트작품");
    assert.strictEqual(row[2], "테스트작품KO");
    assert.strictEqual(row[3], "재수급");
    assert.strictEqual(row[4], "요약텍스트");
    assert.strictEqual(row[5], "조치사항");
    assert.strictEqual(row[6], "https://example.com");
    assert.strictEqual(row[7], "U789");
    assert.strictEqual(row[8], false);
  });

  test("draft 필드 미존재 시 '' fallback", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const { appendInquiryHistory } = createInquiryHistory({
      sheetsClient,
      historySheetId: "sheet-id-abc",
      historySheetRange: "History!A:I",
    });
    await appendInquiryHistory({}, "");
    const row = sheetsClient.appendCalls[0].rows[0];
    assert.strictEqual(row[1], "");   // workName
    assert.strictEqual(row[2], "");   // workNameKo
    assert.strictEqual(row[3], "");   // inquiryType
    assert.strictEqual(row[4], "");   // summary
    assert.strictEqual(row[5], "");   // actionRequired
    assert.strictEqual(row[6], "");   // sourceLink
    assert.strictEqual(row[7], "");   // submitterId
    assert.strictEqual(row[8], false); // completed
  });

  test("opts에 valueInputOption: USER_ENTERED 전달", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const { appendInquiryHistory } = createInquiryHistory({
      sheetsClient,
      historySheetId: "sheet-id-abc",
      historySheetRange: "History!A:I",
    });
    await appendInquiryHistory({ workName: "작품C" }, "U000");
    assert.strictEqual(sheetsClient.appendCalls[0].opts.valueInputOption, "USER_ENTERED");
  });

  test("sheetsClient.append throw 시 호출자에게 에러 전파", async () => {
    const sheetsClient = makeFakeSheetsClient({ shouldThrow: true });
    const { appendInquiryHistory } = createInquiryHistory({
      sheetsClient,
      historySheetId: "sheet-id-abc",
      historySheetRange: "History!A:I",
    });
    await assert.rejects(
      () => appendInquiryHistory({ workName: "작품D" }, "U999"),
      /fake append error/
    );
  });
});

describe("createInquiryHistory.checkInquiryDone", () => {
  test("row 또는 완료용 sheet 설정이 누락되면 명시적으로 실패한다", async () => {
    const cases = [
      { rowIndex: null, historySheetId: "sheet-id", historyGridSheetId: 321, message: /행 번호/ },
      { rowIndex: 10, historySheetId: undefined, historyGridSheetId: 321, message: /spreadsheet ID/ },
      { rowIndex: 10, historySheetId: "sheet-id", historyGridSheetId: undefined, message: /grid sheet ID/ },
    ];
    for (const testCase of cases) {
      const sheetsClient = makeFakeSheetsClient();
      const { checkInquiryDone } = createInquiryHistory({ sheetsClient, ...testCase });
      await assert.rejects(() => checkInquiryDone(testCase.rowIndex), testCase.message);
      assert.equal(sheetsClient.batchUpdateCalls.length, 0);
    }
  });

  test("requests 구조 검증 — updateCells.range에 historyGridSheetId·행·I열(8/9)", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const { checkInquiryDone } = createInquiryHistory({
      sheetsClient,
      historySheetId: "sheet-id-abc",
      historyGridSheetId: 321,
    });

    await checkInquiryDone(10);

    const requests = sheetsClient.batchUpdateCalls[0].requests;
    assert.strictEqual(requests.length, 1);
    const updateCells = requests[0].updateCells;
    assert.ok(updateCells, "updateCells 존재");
    assert.strictEqual(updateCells.range.sheetId, 321);
    assert.strictEqual(updateCells.range.startRowIndex, 9);   // rowIndex - 1
    assert.strictEqual(updateCells.range.endRowIndex, 10);    // rowIndex
    assert.strictEqual(updateCells.range.startColumnIndex, 8);
    assert.strictEqual(updateCells.range.endColumnIndex, 9);
  });

  test("batchUpdate 오류를 호출자에게 전파한다", async () => {
    const sheetsClient = makeFakeSheetsClient({ batchUpdateThrow: true });
    const { checkInquiryDone } = createInquiryHistory({
      sheetsClient,
      historySheetId: "sheet-id-abc",
      historyGridSheetId: 321,
    });

    await assert.rejects(() => checkInquiryDone(10), /fake batchUpdate error/);
  });
});
