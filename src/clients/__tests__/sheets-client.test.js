"use strict";
/**
 * clients/sheets-client.js 단위 테스트
 *
 * node:test + node:assert 빌트인 사용 (신규 dep 추가 금지).
 * fake google DI 패턴 — 실 Google API 없이 transport 동작 검증.
 *
 * 검증 항목:
 *   getValues(spreadsheetId, range):
 *     - 정상 응답 → res.data.values 반환 (raw, || [] 가공 없음)
 *     - res.data.values undefined 시 undefined 반환 (호출처가 || [] 처리)
 *     - API throw 전파 (client는 catch/알림 X — F2 invariant)
 *     - spreadsheetId·range 가 sheets.get에 그대로 전달됨
 *     - readonly scope 고정 — getGoogleAuth에 readonly scope 전달
 *   append(spreadsheetId, range, rows, opts):
 *     - spreadsheetId·range·requestBody.values 전달 검증
 *     - opts 파라미터 병합 (valueInputOption 등)
 *     - read-write scope 사용 (F2 scope 분리)
 *     - API throw 시 catch 없이 throw 전파 (F2 invariant)
 *     - 응답 raw 반환
 *   batchUpdate(spreadsheetId, requests):
 *     - spreadsheetId·requestBody.requests 전달 검증
 *     - read-write scope 사용 (F2 scope 분리)
 *     - API throw 시 catch 없이 throw 전파 (F2 invariant)
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const createSheetsClient = require("../sheets-client");

const READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const READWRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

// ── fake google 빌더 ──────────────────────────────────────────────────────────
function makeFakeGoogle({ values, shouldThrow = false }) {
  return {
    sheets: ({ version, auth } = {}) => ({
      _auth: auth,
      spreadsheets: {
        values: {
          get: async ({ spreadsheetId, range } = {}) => {
            if (shouldThrow) throw new Error("fake API error");
            return { data: { values } };
          },
        },
      },
    }),
  };
}

// ── fake google — append/batchUpdate 캡처용 ───────────────────────────────────
function makeFakeGoogleWrite({ appendThrow = false, batchUpdateThrow = false, updatedRange = "Sheet1!A5:H5" } = {}) {
  const appendCalls = [];
  const batchUpdateCalls = [];
  const google = {
    sheets: () => ({
      spreadsheets: {
        values: {
          append: async (params) => {
            if (appendThrow) throw new Error("fake append error");
            appendCalls.push(params);
            return { data: { updates: { updatedRange } } };
          },
        },
        batchUpdate: async (params) => {
          if (batchUpdateThrow) throw new Error("fake batchUpdate error");
          batchUpdateCalls.push(params);
          return { data: {} };
        },
      },
    }),
  };
  google._appendCalls = appendCalls;
  google._batchUpdateCalls = batchUpdateCalls;
  return google;
}

// ── getGoogleAuth: scope 캡처용 fake ─────────────────────────────────────────
function makeFakeGetGoogleAuth() {
  const calls = [];
  const fn = (scopes) => {
    calls.push(scopes);
    return { type: "fake-auth", scopes };
  };
  fn.calls = calls;
  return fn;
}

describe("createSheetsClient.getValues", () => {
  test("정상 응답 → res.data.values raw 반환 (|| [] 가공 없음)", async () => {
    const fakeValues = [["header"], ["row1a", "row1b"], ["row2a", "row2b"]];
    const client = createSheetsClient({
      google: makeFakeGoogle({ values: fakeValues }),
      getGoogleAuth: () => ({}),
    });
    const result = await client.getValues("test-sheet-id", "Sheet1!A:B");
    assert.deepStrictEqual(result, fakeValues);
  });

  test("res.data.values 미존재 시 undefined 반환 (호출처가 || [] 처리 — client raw 반환)", async () => {
    const client = createSheetsClient({
      google: makeFakeGoogle({ values: undefined }),
      getGoogleAuth: () => ({}),
    });
    const result = await client.getValues("test-sheet-id", "Sheet1!A:B");
    assert.strictEqual(result, undefined);
  });

  test("API throw 시 catch 없이 throw 전파 (F2: 알림·로깅 X)", async () => {
    const client = createSheetsClient({
      google: makeFakeGoogle({ shouldThrow: true }),
      getGoogleAuth: () => ({}),
    });
    await assert.rejects(
      () => client.getValues("test-sheet-id", "Sheet1!A:B"),
      { message: "fake API error" }
    );
  });

  test("readonly scope 고정 — getGoogleAuth에 spreadsheets.readonly scope 전달", async () => {
    const fakeGetGoogleAuth = makeFakeGetGoogleAuth();
    const client = createSheetsClient({
      google: makeFakeGoogle({ values: [] }),
      getGoogleAuth: fakeGetGoogleAuth,
    });
    await client.getValues("sheet-id", "A:A");
    assert.strictEqual(fakeGetGoogleAuth.calls.length, 1);
    assert.deepStrictEqual(fakeGetGoogleAuth.calls[0], [READONLY_SCOPE]);
  });

  test("spreadsheetId·range 가 API에 그대로 전달됨", async () => {
    let capturedParams = null;
    const capturingGoogle = {
      sheets: () => ({
        spreadsheets: {
          values: {
            get: async (params) => {
              capturedParams = params;
              return { data: { values: [["captured"]] } };
            },
          },
        },
      }),
    };
    const client = createSheetsClient({
      google: capturingGoogle,
      getGoogleAuth: () => ({}),
    });
    await client.getValues("my-spreadsheet-id", "Sheet2!B2:D10");
    assert.ok(capturedParams, "API가 호출돼야 함");
    assert.strictEqual(capturedParams.spreadsheetId, "my-spreadsheet-id");
    assert.strictEqual(capturedParams.range, "Sheet2!B2:D10");
  });

  test("호출마다 google.sheets 신규 생성 (auth 캐싱 없음 — F3 byte-동등)", async () => {
    let sheetsCallCount = 0;
    const countingGoogle = {
      sheets: () => {
        sheetsCallCount++;
        return {
          spreadsheets: {
            values: {
              get: async () => ({ data: { values: [] } }),
            },
          },
        };
      },
    };
    const client = createSheetsClient({
      google: countingGoogle,
      getGoogleAuth: () => ({}),
    });
    await client.getValues("id1", "A:A");
    await client.getValues("id2", "B:B");
    assert.strictEqual(sheetsCallCount, 2, "호출마다 sheets 인스턴스 신규 생성 (캐싱 없음)");
  });
});

// ── append ────────────────────────────────────────────────────────────────────
describe("createSheetsClient.append", () => {
  test("spreadsheetId·range·requestBody.values 전달 검증", async () => {
    const fakeGoogle = makeFakeGoogleWrite();
    const client = createSheetsClient({ google: fakeGoogle, getGoogleAuth: () => ({}) });

    const rows = [["A", "B", "C"]];
    await client.append("sheet-id-x", "Sheet1!A:C", rows);

    assert.strictEqual(fakeGoogle._appendCalls.length, 1);
    assert.strictEqual(fakeGoogle._appendCalls[0].spreadsheetId, "sheet-id-x");
    assert.strictEqual(fakeGoogle._appendCalls[0].range, "Sheet1!A:C");
    assert.deepStrictEqual(fakeGoogle._appendCalls[0].requestBody.values, rows);
  });

  test("opts 파라미터 병합 — valueInputOption·insertDataOption 전달", async () => {
    const fakeGoogle = makeFakeGoogleWrite();
    const client = createSheetsClient({ google: fakeGoogle, getGoogleAuth: () => ({}) });

    await client.append("sid", "A:A", [[]], {
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      includeValuesInResponse: false,
    });

    const call = fakeGoogle._appendCalls[0];
    assert.strictEqual(call.valueInputOption, "USER_ENTERED");
    assert.strictEqual(call.insertDataOption, "INSERT_ROWS");
    assert.strictEqual(call.includeValuesInResponse, false);
  });

  test("read-write scope 사용 (getGoogleAuth에 spreadsheets scope 전달 — R8 scope 분리)", async () => {
    const fakeGoogle = makeFakeGoogleWrite();
    const scopeCalls = [];
    const fakeGetGoogleAuth = (scopes) => { scopeCalls.push(scopes); return {}; };

    const client = createSheetsClient({ google: fakeGoogle, getGoogleAuth: fakeGetGoogleAuth });
    await client.append("sid", "A:A", [[]]);

    assert.strictEqual(scopeCalls.length, 1);
    assert.deepStrictEqual(scopeCalls[0], [READWRITE_SCOPE]);
  });

  test("응답 raw 반환 (data.updates.updatedRange 포함)", async () => {
    const fakeGoogle = makeFakeGoogleWrite({ updatedRange: "Sheet1!A20:H20" });
    const client = createSheetsClient({ google: fakeGoogle, getGoogleAuth: () => ({}) });

    const res = await client.append("sid", "A:A", [[]]);

    assert.strictEqual(res.data.updates.updatedRange, "Sheet1!A20:H20");
  });

  test("API throw 시 catch 없이 throw 전파 (F2 invariant)", async () => {
    const fakeGoogle = makeFakeGoogleWrite({ appendThrow: true });
    const client = createSheetsClient({ google: fakeGoogle, getGoogleAuth: () => ({}) });

    await assert.rejects(
      () => client.append("sid", "A:A", [[]]),
      { message: "fake append error" }
    );
  });
});

// ── batchUpdate ───────────────────────────────────────────────────────────────
describe("createSheetsClient.batchUpdate", () => {
  test("spreadsheetId·requestBody.requests 전달 검증", async () => {
    const fakeGoogle = makeFakeGoogleWrite();
    const client = createSheetsClient({ google: fakeGoogle, getGoogleAuth: () => ({}) });

    const requests = [{ repeatCell: { range: { sheetId: 511152201, startRowIndex: 9, endRowIndex: 10 } } }];
    await client.batchUpdate("sheet-id-y", requests);

    assert.strictEqual(fakeGoogle._batchUpdateCalls.length, 1);
    assert.strictEqual(fakeGoogle._batchUpdateCalls[0].spreadsheetId, "sheet-id-y");
    assert.deepStrictEqual(fakeGoogle._batchUpdateCalls[0].requestBody.requests, requests);
  });

  test("read-write scope 사용 (getGoogleAuth에 spreadsheets scope 전달 — R8 scope 분리)", async () => {
    const fakeGoogle = makeFakeGoogleWrite();
    const scopeCalls = [];
    const fakeGetGoogleAuth = (scopes) => { scopeCalls.push(scopes); return {}; };

    const client = createSheetsClient({ google: fakeGoogle, getGoogleAuth: fakeGetGoogleAuth });
    await client.batchUpdate("sid", []);

    assert.strictEqual(scopeCalls.length, 1);
    assert.deepStrictEqual(scopeCalls[0], [READWRITE_SCOPE]);
  });

  test("API throw 시 catch 없이 throw 전파 (F2 invariant)", async () => {
    const fakeGoogle = makeFakeGoogleWrite({ batchUpdateThrow: true });
    const client = createSheetsClient({ google: fakeGoogle, getGoogleAuth: () => ({}) });

    await assert.rejects(
      () => client.batchUpdate("sid", []),
      { message: "fake batchUpdate error" }
    );
  });
});

// ── getValues — readonly scope 유지 (R8: write 추가 후에도 read scope 불변) ──────
describe("createSheetsClient.getValues — readonly scope 유지 (append/batchUpdate 추가 후 회귀 없음)", () => {
  test("getValues는 여전히 readonly scope만 사용", async () => {
    const fakeGoogle = makeFakeGoogle({ values: [] });
    const scopeCalls = [];
    const fakeGetGoogleAuth = (scopes) => { scopeCalls.push(scopes); return {}; };

    const client = createSheetsClient({ google: fakeGoogle, getGoogleAuth: fakeGetGoogleAuth });
    await client.getValues("sid", "A:A");

    assert.strictEqual(scopeCalls.length, 1);
    assert.deepStrictEqual(scopeCalls[0], [READONLY_SCOPE]);
  });
});
