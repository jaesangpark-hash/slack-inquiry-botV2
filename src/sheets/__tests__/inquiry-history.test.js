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
 *     - append rows 구조: [now, workName, workNameKo, inquiryType, summary, actionRequired, sourceLink, submitterId]
 *     - draft 필드 빈값 → "" fallback
 *     - sheetsClient.append throw 시 console.error 호출 (silent failure X — R6)
 *     - F2 invariant: sheetsClient.append는 알림·로깅 없이 throw만 (도메인 모듈이 catch)
 */

const { test, describe, mock, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const createInquiryHistory = require("../inquiry-history");

// ── fake sheetsClient ─────────────────────────────────────────────────────────
function makeFakeSheetsClient({ shouldThrow = false } = {}) {
  const appendCalls = [];
  return {
    append: async (spreadsheetId, range, rows, opts) => {
      if (shouldThrow) throw new Error("fake append error");
      appendCalls.push({ spreadsheetId, range, rows, opts });
      return { data: { updates: { updatedRange: "Sheet1!A10:H10" } } };
    },
    appendCalls,
  };
}

describe("createInquiryHistory.appendInquiryHistory", () => {
  test("historySheetId 미설정 시 early return — sheetsClient.append 미호출", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const { appendInquiryHistory } = createInquiryHistory({
      sheetsClient,
      historySheetId: undefined,
      historySheetRange: "Sheet1!A:H",
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
      historySheetRange: "Sheet1!A:H",
    });
    await appendInquiryHistory({ workName: "작품A" }, "U123");
    assert.strictEqual(sheetsClient.appendCalls.length, 0);
  });

  test("설정 시 sheetsClient.append 호출 — spreadsheetId·range 전달 검증", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const { appendInquiryHistory } = createInquiryHistory({
      sheetsClient,
      historySheetId: "sheet-id-abc",
      historySheetRange: "History!A:H",
    });
    await appendInquiryHistory({ workName: "작품B" }, "U456");
    assert.strictEqual(sheetsClient.appendCalls.length, 1);
    assert.strictEqual(sheetsClient.appendCalls[0].spreadsheetId, "sheet-id-abc");
    assert.strictEqual(sheetsClient.appendCalls[0].range, "History!A:H");
  });

  test("rows 구조: 8컬럼 [now, workName, workNameKo, inquiryType, summary, actionRequired, sourceLink, submitterId]", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const { appendInquiryHistory } = createInquiryHistory({
      sheetsClient,
      historySheetId: "sheet-id-abc",
      historySheetRange: "History!A:H",
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
    assert.strictEqual(row.length, 8);
    // 인덱스 1~7 검증 (0번은 now — 동적 타임스탬프라 검증 스킵)
    assert.strictEqual(row[1], "테스트작품");
    assert.strictEqual(row[2], "테스트작품KO");
    assert.strictEqual(row[3], "재수급");
    assert.strictEqual(row[4], "요약텍스트");
    assert.strictEqual(row[5], "조치사항");
    assert.strictEqual(row[6], "https://example.com");
    assert.strictEqual(row[7], "U789");
  });

  test("draft 필드 미존재 시 '' fallback", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const { appendInquiryHistory } = createInquiryHistory({
      sheetsClient,
      historySheetId: "sheet-id-abc",
      historySheetRange: "History!A:H",
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
  });

  test("opts에 valueInputOption: USER_ENTERED 전달", async () => {
    const sheetsClient = makeFakeSheetsClient();
    const { appendInquiryHistory } = createInquiryHistory({
      sheetsClient,
      historySheetId: "sheet-id-abc",
      historySheetRange: "History!A:H",
    });
    await appendInquiryHistory({ workName: "작품C" }, "U000");
    assert.strictEqual(sheetsClient.appendCalls[0].opts.valueInputOption, "USER_ENTERED");
  });

  test("sheetsClient.append throw 시 console.error 호출 — 에러 전파 X (R6 catch 보존)", async () => {
    const sheetsClient = makeFakeSheetsClient({ shouldThrow: true });
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args);
    const { appendInquiryHistory } = createInquiryHistory({
      sheetsClient,
      historySheetId: "sheet-id-abc",
      historySheetRange: "History!A:H",
    });
    // throw를 외부로 전파하지 않아야 함
    await assert.doesNotReject(() => appendInquiryHistory({ workName: "작품D" }, "U999"));
    assert.ok(errors.length > 0, "console.error 호출 필수 (R6)");
    assert.ok(errors[0][0].includes("이력 기록 실패"), "에러 메시지 접두어 확인");
    console.error = origError;
  });
});
