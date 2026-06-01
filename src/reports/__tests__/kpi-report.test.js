"use strict";
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs   = require("fs");
const os   = require("os");
const path = require("path");

const createKpiReport = require("../kpi-report");

// ── 헬퍼: 임시 logDir 생성 ──────────────────────────────────────────
function makeTmpLogDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kpi-test-"));
}

// ── 헬퍼: 전날 날짜 문자열 (YYYY-MM-DD) ───────────────────────────
function yesterday() {
  return new Date(Date.now() - 86400000).toISOString().slice(0, 10);
}

// ── 헬퍼: logDir에 전날 jsonl 파일 작성 ──────────────────────────
function writeLogFile(logDir, records) {
  const date = yesterday();
  const filePath = path.join(logDir, `api-${date}.jsonl`);
  const content = records.map(r => JSON.stringify(r)).join("\n") + "\n";
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

// ── 헬퍼: 가짜 slackClient ─────────────────────────────────────
function makeSlackClient() {
  const calls = [];
  return {
    chat: {
      postMessage: async (args) => {
        calls.push(args);
        return { ok: true };
      },
    },
    getCalls: () => calls,
  };
}

// ── 기본 로그 레코드 빌더 ──────────────────────────────────────
function makeRecord(overrides = {}) {
  return {
    ts: new Date().toISOString(),
    endpoint: "/api/test",
    bot: "inquiry-bot",
    params: {},
    expectedCount: null,
    returnedCount: null,
    elapsedMs: 100,
    success: true,
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────

describe("kpi-report: sendApiAnalysisReport", () => {
  let logDir;

  beforeEach(() => {
    logDir = makeTmpLogDir();
  });

  afterEach(() => {
    // 임시 디렉토리 정리
    try { fs.rmSync(logDir, { recursive: true, force: true }); } catch (_) {}
  });

  test("로그 파일 없음 — postMessage 호출 0 (알럿 생략)", async () => {
    const slackClient = makeSlackClient();
    const { sendApiAnalysisReport } = createKpiReport({ slackClient, reportChannelId: "UREPORT", logDir });
    await sendApiAnalysisReport();
    assert.equal(slackClient.getCalls().length, 0);
  });

  test("로그 파일 비어 있음 — postMessage 호출 0", async () => {
    const slackClient = makeSlackClient();
    const { sendApiAnalysisReport } = createKpiReport({ slackClient, reportChannelId: "UREPORT", logDir });
    writeLogFile(logDir, []);
    // 빈 파일(개행만) → logs.length === 0 → 조기 return
    await sendApiAnalysisReport();
    assert.equal(slackClient.getCalls().length, 0);
  });

  test("정상 로그 — postMessage 1회 호출 + 채널·날짜 확인", async () => {
    const slackClient = makeSlackClient();
    const reportChannelId = "UREPORT123";
    const { sendApiAnalysisReport } = createKpiReport({ slackClient, reportChannelId, logDir });
    writeLogFile(logDir, [makeRecord()]);
    await sendApiAnalysisReport();
    const calls = slackClient.getCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].channel, reportChannelId);
    assert.ok(calls[0].text.includes(yesterday()), "text에 날짜 포함");
  });

  test("리포트 블록 구조: header + section(fields) + divider 포함", async () => {
    const slackClient = makeSlackClient();
    const { sendApiAnalysisReport } = createKpiReport({ slackClient, reportChannelId: "U0", logDir });
    writeLogFile(logDir, [makeRecord({ elapsedMs: 100, success: true })]);
    await sendApiAnalysisReport();
    const { blocks } = slackClient.getCalls()[0];
    assert.ok(Array.isArray(blocks), "blocks는 배열");
    const types = blocks.map(b => b.type);
    assert.ok(types.includes("header"), "header 블록 포함");
    assert.ok(types.includes("divider"), "divider 블록 포함");
    const sectionWithFields = blocks.find(b => b.type === "section" && b.fields);
    assert.ok(sectionWithFields, "fields 가진 section 블록 포함");
  });

  test("이슈 없음 — '개선 필요 항목 없음' 텍스트 포함", async () => {
    const slackClient = makeSlackClient();
    const { sendApiAnalysisReport } = createKpiReport({ slackClient, reportChannelId: "U0", logDir });
    writeLogFile(logDir, [makeRecord()]);
    await sendApiAnalysisReport();
    const { blocks } = slackClient.getCalls()[0];
    const hasNoIssue = blocks.some(b => b.type === "section" && b.text?.text?.includes("개선 필요 항목 없음"));
    assert.ok(hasNoIssue, "'개선 필요 항목 없음' 블록 포함");
  });

  test("과다 조회 이슈 집계: expectedCount/returnedCount 비율 낮을 때 🔴 이슈 발생", async () => {
    const slackClient = makeSlackClient();
    const { sendApiAnalysisReport } = createKpiReport({ slackClient, reportChannelId: "U0", logDir });
    // expectedCount=1, returnedCount=100 → 비율 0.01 < 0.2 → 과다조회
    writeLogFile(logDir, [
      makeRecord({ endpoint: "/ep/waste", expectedCount: 1, returnedCount: 100 }),
    ]);
    await sendApiAnalysisReport();
    const { blocks } = slackClient.getCalls()[0];
    const issueBlocks = blocks.filter(b => b.type === "section" && b.text?.text?.includes("과다 조회"));
    assert.ok(issueBlocks.length >= 1, "🔴 과다 조회 이슈 블록 존재");
    assert.ok(issueBlocks[0].text.text.includes("/ep/waste"), "엔드포인트 명 포함");
  });

  test("느린 호출 이슈 집계: elapsedMs >= 3000 → 🟡 이슈 발생", async () => {
    const slackClient = makeSlackClient();
    const { sendApiAnalysisReport } = createKpiReport({ slackClient, reportChannelId: "U0", logDir });
    writeLogFile(logDir, [
      makeRecord({ endpoint: "/ep/slow", elapsedMs: 5000 }),
    ]);
    await sendApiAnalysisReport();
    const { blocks } = slackClient.getCalls()[0];
    const issueBlocks = blocks.filter(b => b.type === "section" && b.text?.text?.includes("느린 호출"));
    assert.ok(issueBlocks.length >= 1, "🟡 느린 호출 이슈 블록 존재");
  });

  test("N+1 이슈 집계: 10초 이내 3회 이상 반복 → 🟠 이슈 발생", async () => {
    const slackClient = makeSlackClient();
    const { sendApiAnalysisReport } = createKpiReport({ slackClient, reportChannelId: "U0", logDir });
    const baseTime = Date.now() - 86400000; // 전날 내
    const records = [
      makeRecord({ endpoint: "/ep/n1", bot: "b1", ts: new Date(baseTime).toISOString() }),
      makeRecord({ endpoint: "/ep/n1", bot: "b1", ts: new Date(baseTime + 2000).toISOString() }),
      makeRecord({ endpoint: "/ep/n1", bot: "b1", ts: new Date(baseTime + 4000).toISOString() }),
    ];
    writeLogFile(logDir, records);
    await sendApiAnalysisReport();
    const { blocks } = slackClient.getCalls()[0];
    const issueBlocks = blocks.filter(b => b.type === "section" && b.text?.text?.includes("N+1 의심"));
    assert.ok(issueBlocks.length >= 1, "🟠 N+1 의심 이슈 블록 존재");
    assert.ok(issueBlocks[0].text.text.includes("/ep/n1"), "엔드포인트 명 포함");
  });

  test("통계 필드: 총 호출·실패·평균 응답·봇별 텍스트 포함", async () => {
    const slackClient = makeSlackClient();
    const { sendApiAnalysisReport } = createKpiReport({ slackClient, reportChannelId: "U0", logDir });
    writeLogFile(logDir, [
      makeRecord({ success: true,  elapsedMs: 200, bot: "bot-a" }),
      makeRecord({ success: false, elapsedMs: 400, bot: "bot-a" }),
    ]);
    await sendApiAnalysisReport();
    const { blocks } = slackClient.getCalls()[0];
    const fieldBlock = blocks.find(b => b.type === "section" && b.fields);
    const fieldTexts = fieldBlock.fields.map(f => f.text).join(" ");
    assert.ok(fieldTexts.includes("2회"), "총 호출 2회");
    assert.ok(fieldTexts.includes("1회"), "실패 1회");
    assert.ok(fieldTexts.includes("bot-a"), "봇별 텍스트에 bot-a 포함");
  });

  test("slackClient.chat.postMessage 에러 — 예외 삼킴 (R6 catch 보존)", async () => {
    const errorClient = {
      chat: { postMessage: async () => { throw new Error("slack error"); } },
    };
    const { sendApiAnalysisReport } = createKpiReport({ slackClient: errorClient, reportChannelId: "U0", logDir });
    writeLogFile(logDir, [makeRecord()]);
    // sendApiAnalysisReport 내부 catch가 에러를 삼킴 — throw 없어야 함
    await assert.doesNotReject(() => sendApiAnalysisReport());
  });
});
