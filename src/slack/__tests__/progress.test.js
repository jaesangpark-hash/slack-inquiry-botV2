"use strict";
/**
 * slack/progress.js 단위 테스트
 *
 * node:test + node:assert 빌트인 사용 (신규 dep 추가 금지).
 * factory DI 주입으로 fake slackClient / sendAlert 검증.
 *
 * 검증 항목:
 *   buildProgressText:
 *     - step=0 → 첫 단계 진행 중 (▣)
 *     - step=4 → 마지막 단계 진행 중, 이전 모두 완료(■)
 *     - note 있을 때 하단에 추가
 *   updateProgress:
 *     - slackClient.chat.update 호출 인자 검증 (channel, ts, text 포함)
 *   alertOnError:
 *     - 성공 시 fn 반환값 그대로 반환
 *     - fn이 throw → sendAlert 호출 + 다시 throw
 *   withTimeout:
 *     - 30초 초과 시 TIMEOUT 에러 + sendAlert 호출
 *     - fn이 정상 완료 시 결과 반환
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const createProgress = require("../progress");

// ── fake deps ─────────────────────────────────────────────────────────────────

function makeFakeDeps() {
  const calls = { update: [], sendAlert: [] };
  const slackClient = {
    chat: {
      update: async (args) => { calls.update.push(args); return { ok: true }; },
      postMessage: async (args) => { calls.update.push({ _postMessage: args }); return { ok: true }; },
    },
  };
  const sendAlert = async (msg) => { calls.sendAlert.push(msg); };
  return { slackClient, sendAlert, calls };
}

// ── buildProgressText ──────────────────────────────────────────────────────────

describe("buildProgressText", () => {
  const { buildProgressText } = createProgress({ slackClient: {}, sendAlert: async () => {} });

  test("step=0 → 첫 단계(▣) + 나머지(□)", () => {
    const text = buildProgressText(0);
    assert.ok(text.includes("▣ 링크 확인"), `step 0 진행 중 표시 없음: ${text}`);
    assert.ok(text.includes("□ 메시지 조회"), `step 1 대기 표시 없음: ${text}`);
    assert.ok(text.includes("*실행 중...*"), `헤더 없음: ${text}`);
  });

  test("step=4 → 마지막 단계(▣) + 이전 모두 완료(■)", () => {
    const text = buildProgressText(4);
    assert.ok(text.includes("■ 링크 확인"), `step 0 완료 표시 없음: ${text}`);
    assert.ok(text.includes("■ 시트 매칭"), `step 3 완료 표시 없음: ${text}`);
    assert.ok(text.includes("▣ 초안 작성"), `step 4 진행 중 표시 없음: ${text}`);
  });

  test("note 인자 있으면 텍스트 하단에 포함", () => {
    const text = buildProgressText(1, "테스트 노트");
    assert.ok(text.includes("테스트 노트"), `note가 텍스트에 없음: ${text}`);
  });

  test("note 없으면 빈 줄 + note 없음", () => {
    const text = buildProgressText(2);
    // note 줄이 없어야 함 (기본값 "" → note 블록 미추가)
    const lines = text.split("\n");
    // 헤더(1) + 5단계(5) = 6줄
    assert.strictEqual(lines.length, 6, `note 없을 때 라인 수 오류: ${lines.length}`);
  });
});

// ── updateProgress ─────────────────────────────────────────────────────────────

describe("updateProgress", () => {
  test("slackClient.chat.update가 channel, ts, text 인자로 호출됨", async () => {
    const { slackClient, sendAlert, calls } = makeFakeDeps();
    const { updateProgress } = createProgress({ slackClient, sendAlert });

    await updateProgress("C123", "1234567890.000001", 2, "진행 중");

    assert.strictEqual(calls.update.length, 1, "update 1회 호출 기대");
    const arg = calls.update[0];
    assert.strictEqual(arg.channel, "C123");
    assert.strictEqual(arg.ts, "1234567890.000001");
    assert.ok(arg.text.includes("▣ AI 분석"), `step 2 표시 없음: ${arg.text}`);
  });
});

// ── alertOnError ───────────────────────────────────────────────────────────────

describe("alertOnError", () => {
  test("fn 성공 시 반환값 그대로 반환, sendAlert 호출 없음", async () => {
    const { slackClient, sendAlert, calls } = makeFakeDeps();
    const { alertOnError } = createProgress({ slackClient, sendAlert });

    const result = await alertOnError("테스트", async () => "성공값");

    assert.strictEqual(result, "성공값");
    assert.strictEqual(calls.sendAlert.length, 0, "sendAlert 미호출 기대");
  });

  test("fn이 throw → sendAlert 호출 + 에러 다시 throw", async () => {
    const { slackClient, sendAlert, calls } = makeFakeDeps();
    const { alertOnError } = createProgress({ slackClient, sendAlert });

    await assert.rejects(
      () => alertOnError("테스트라벨", async () => { throw new Error("테스트오류"); }),
      (err) => {
        assert.strictEqual(err.message, "테스트오류");
        return true;
      }
    );

    assert.strictEqual(calls.sendAlert.length, 1, "sendAlert 1회 호출 기대");
    assert.ok(calls.sendAlert[0].includes("테스트라벨"), `alert 메시지에 라벨 없음: ${calls.sendAlert[0]}`);
    assert.ok(calls.sendAlert[0].includes("테스트오류"), `alert 메시지에 오류 내용 없음: ${calls.sendAlert[0]}`);
  });
});

// ── withTimeout ────────────────────────────────────────────────────────────────

describe("withTimeout", () => {
  test("fn 정상 완료 시 결과 반환, sendAlert 미호출", async () => {
    const { slackClient, sendAlert, calls } = makeFakeDeps();
    const { withTimeout } = createProgress({ slackClient, sendAlert });

    const result = await withTimeout(async () => "정상결과");

    assert.strictEqual(result, "정상결과");
    assert.strictEqual(calls.sendAlert.length, 0, "sendAlert 미호출 기대");
  });

  test("TIMEOUT 에러 시 sendAlert 호출 + 에러 다시 throw", async () => {
    const { slackClient, sendAlert, calls } = makeFakeDeps();
    const { withTimeout } = createProgress({ slackClient, sendAlert });

    // 타임아웃을 직접 시뮬레이션: 즉시 TIMEOUT 에러를 throw하는 fn
    const timeoutFn = () => new Promise((_, reject) =>
      setImmediate(() => reject(new Error("TIMEOUT")))
    );

    await assert.rejects(
      () => withTimeout(timeoutFn, { label: "타임아웃테스트" }),
      (err) => {
        assert.strictEqual(err.message, "TIMEOUT");
        return true;
      }
    );

    assert.strictEqual(calls.sendAlert.length, 1, "sendAlert 1회 호출 기대");
    assert.ok(calls.sendAlert[0].includes("타임아웃"), `타임아웃 알럿 메시지 오류: ${calls.sendAlert[0]}`);
  });

  test("TIMEOUT 외 일반 오류 시 sendAlert 호출 + 에러 다시 throw", async () => {
    const { slackClient, sendAlert, calls } = makeFakeDeps();
    const { withTimeout } = createProgress({ slackClient, sendAlert });

    await assert.rejects(
      () => withTimeout(async () => { throw new Error("일반오류"); }, { label: "일반오류테스트" }),
      (err) => {
        assert.strictEqual(err.message, "일반오류");
        return true;
      }
    );

    assert.strictEqual(calls.sendAlert.length, 1, "sendAlert 1회 호출 기대 (일반 오류)");
    assert.ok(calls.sendAlert[0].includes("일반오류"), `일반 오류 alert 메시지 오류: ${calls.sendAlert[0]}`);
  });

  test("TIMEOUT 시 dmChannel+client 있으면 postMessage 호출", async () => {
    const { slackClient, sendAlert, calls } = makeFakeDeps();
    const { withTimeout } = createProgress({ slackClient, sendAlert });

    const timeoutFn = () => new Promise((_, reject) =>
      setImmediate(() => reject(new Error("TIMEOUT")))
    );

    await assert.rejects(
      () => withTimeout(timeoutFn, { dmChannel: "DM_CHANNEL", client: slackClient, label: "DM테스트" })
    );

    const postMessageCalls = calls.update.filter(c => c._postMessage);
    assert.strictEqual(postMessageCalls.length, 1, "postMessage 1회 호출 기대");
    assert.strictEqual(postMessageCalls[0]._postMessage.channel, "DM_CHANNEL");
  });
});
