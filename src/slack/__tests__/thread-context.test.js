"use strict";
/**
 * slack/thread-context.js 단위 테스트
 *
 * node:test + node:assert 빌트인 사용.
 * 가짜 slackClient 주입으로 외부 Slack API 의존 격리.
 *
 * 검증 항목:
 *   PROCESSED_REACTION:
 *     - "대응완료" 상수 값 확인
 *   fetchSingleLinkedMessage:
 *     - conversations.history 결과의 첫 번째 메시지 반환
 *     - messages 없으면 null 반환
 *   markInquiryProcessed:
 *     - client.reactions.add 호출 인자 검증
 *     - already_reacted 오류 → 무시 (throw X)
 *     - 다른 오류 → console.error (throw X)
 *   fetchThreadContext:
 *     - threadTs 없으면 fetchSingleLinkedMessage 경로 사용
 *     - targetTs 이후 메시지 제외
 *     - bot_id 있는 메시지 제외
 *     - 자기 자신이 아닌 메시지 중 PROCESSED_REACTION 붙은 메시지 제외
 *     - 오류 시 빈 배열 반환
 *   buildThreadContextText:
 *     - 빈 배열 → 빈 문자열
 *     - 첫 메시지 → [엄마 스레드] 라벨
 *     - 두 번째 메시지 → [답변 1] 라벨
 *     - text 없는 메시지 → 필터링
 *     - cleanSlackText 주입 반영 (마크업 정제)
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const createThreadContext = require("../thread-context");

// ── fake cleanSlackText ──────────────────────────────────────────────────────
// 순수 함수 — 실제 구현 사용 or 간단한 stub
function cleanSlackText(text = "") {
  return text
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2").replace(/<([^>]+)>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
}

const {
  PROCESSED_REACTION,
  fetchSingleLinkedMessage,
  markInquiryProcessed,
  fetchThreadContext,
  buildThreadContextText,
} = createThreadContext({ cleanSlackText });

// ── fake client builder ───────────────────────────────────────────────────────
function makeFakeClient({ historyMessages = [], repliesMessages = [], reactionsAddError = null } = {}) {
  const calls = { historyArgs: [], repliesArgs: [], reactionsAddArgs: [] };
  const client = {
    conversations: {
      history: async (args) => {
        calls.historyArgs.push(args);
        return { messages: historyMessages };
      },
      replies: async (args) => {
        calls.repliesArgs.push(args);
        return { messages: repliesMessages };
      },
    },
    reactions: {
      add: async (args) => {
        calls.reactionsAddArgs.push(args);
        if (reactionsAddError) throw reactionsAddError;
      },
    },
  };
  return { client, calls };
}

// ── PROCESSED_REACTION ────────────────────────────────────────────────────────
describe("PROCESSED_REACTION", () => {
  test("상수값이 '대응완료'", () => {
    assert.strictEqual(PROCESSED_REACTION, "대응완료");
  });
});

// ── fetchSingleLinkedMessage ──────────────────────────────────────────────────
describe("fetchSingleLinkedMessage", () => {
  test("conversations.history 첫 번째 메시지 반환", async () => {
    const msg = { ts: "123.456", text: "테스트" };
    const { client } = makeFakeClient({ historyMessages: [msg] });
    const result = await fetchSingleLinkedMessage(client, "C123", "123.456");
    assert.deepStrictEqual(result, msg);
  });

  test("messages 빈 배열 → null", async () => {
    const { client } = makeFakeClient({ historyMessages: [] });
    const result = await fetchSingleLinkedMessage(client, "C123", "123.456");
    assert.strictEqual(result, null);
  });

  test("conversations.history 호출 인자 검증", async () => {
    const { client, calls } = makeFakeClient({ historyMessages: [] });
    await fetchSingleLinkedMessage(client, "C_TEST", "1234567890.123456");
    assert.strictEqual(calls.historyArgs.length, 1);
    assert.strictEqual(calls.historyArgs[0].channel, "C_TEST");
    assert.strictEqual(calls.historyArgs[0].oldest, "1234567890.123456");
    assert.strictEqual(calls.historyArgs[0].inclusive, true);
    assert.strictEqual(calls.historyArgs[0].limit, 1);
  });
});

// ── markInquiryProcessed ─────────────────────────────────────────────────────
describe("markInquiryProcessed", () => {
  test("reactions.add 정상 호출 — channel, name, timestamp 인자", async () => {
    const { client, calls } = makeFakeClient();
    await markInquiryProcessed(client, "C123", "1234567890.123456");
    assert.strictEqual(calls.reactionsAddArgs.length, 1);
    assert.strictEqual(calls.reactionsAddArgs[0].channel, "C123");
    assert.strictEqual(calls.reactionsAddArgs[0].name, PROCESSED_REACTION);
    assert.strictEqual(calls.reactionsAddArgs[0].timestamp, "1234567890.123456");
  });

  test("already_reacted 오류 → 무시 (throw X)", async () => {
    const alreadyReactedError = Object.assign(new Error("already_reacted"), {
      data: { error: "already_reacted" },
    });
    const { client } = makeFakeClient({ reactionsAddError: alreadyReactedError });
    // throw하지 않아야 함
    await assert.doesNotReject(() => markInquiryProcessed(client, "C123", "123.456"));
  });

  test("기타 오류 → console.error 출력 후 무시 (throw X)", async () => {
    const otherError = Object.assign(new Error("some_error"), {
      data: { error: "some_error" },
    });
    const { client } = makeFakeClient({ reactionsAddError: otherError });
    await assert.doesNotReject(() => markInquiryProcessed(client, "C123", "123.456"));
  });
});

// ── fetchThreadContext ────────────────────────────────────────────────────────
describe("fetchThreadContext", () => {
  test("threadTs 없으면 fetchSingleLinkedMessage 경로 (단일 메시지) 사용", async () => {
    const msg = { ts: "100.000", text: "원본" };
    const { client } = makeFakeClient({ historyMessages: [msg] });
    const result = await fetchThreadContext(client, "C123", "100.000", null);
    assert.deepStrictEqual(result, [msg]);
  });

  test("threadTs 없고 메시지 없으면 빈 배열", async () => {
    const { client } = makeFakeClient({ historyMessages: [] });
    const result = await fetchThreadContext(client, "C123", "100.000", null);
    assert.deepStrictEqual(result, []);
  });

  test("targetTs 이후 메시지 제외", async () => {
    const targetTs = "100.000";
    const msgs = [
      { ts: "90.000", text: "이전" },
      { ts: "100.000", text: "타겟" },
      { ts: "110.000", text: "이후 — 제외" },
    ];
    const { client } = makeFakeClient({ repliesMessages: msgs });
    const result = await fetchThreadContext(client, "C123", targetTs, "80.000");
    const tss = result.map(m => m.ts);
    assert.ok(tss.includes("90.000"), "이전 메시지 포함돼야 함");
    assert.ok(tss.includes("100.000"), "타겟 메시지 포함돼야 함");
    assert.ok(!tss.includes("110.000"), "이후 메시지 제외돼야 함");
  });

  test("bot_id 있는 메시지 제외", async () => {
    const msgs = [
      { ts: "90.000", text: "사람" },
      { ts: "95.000", text: "봇", bot_id: "B123" },
      { ts: "100.000", text: "타겟" },
    ];
    const { client } = makeFakeClient({ repliesMessages: msgs });
    const result = await fetchThreadContext(client, "C123", "100.000", "80.000");
    const tss = result.map(m => m.ts);
    assert.ok(!tss.includes("95.000"), "봇 메시지 제외돼야 함");
  });

  test("자기 자신 아닌 메시지에 PROCESSED_REACTION 붙으면 제외", async () => {
    const msgs = [
      { ts: "90.000", text: "처리된 문의", reactions: [{ name: PROCESSED_REACTION }] },
      { ts: "100.000", text: "타겟 자신" },
    ];
    const { client } = makeFakeClient({ repliesMessages: msgs });
    const result = await fetchThreadContext(client, "C123", "100.000", "80.000");
    const tss = result.map(m => m.ts);
    assert.ok(!tss.includes("90.000"), "처리된 문의 메시지 제외돼야 함");
    assert.ok(tss.includes("100.000"), "타겟 자신은 포함돼야 함");
  });

  test("타겟 자신에 PROCESSED_REACTION 붙어있어도 포함", async () => {
    const msgs = [
      { ts: "100.000", text: "타겟", reactions: [{ name: PROCESSED_REACTION }] },
    ];
    const { client } = makeFakeClient({ repliesMessages: msgs });
    const result = await fetchThreadContext(client, "C123", "100.000", "80.000");
    assert.ok(result.some(m => m.ts === "100.000"), "타겟 자신은 포함돼야 함");
  });

  test("오류 발생 시 빈 배열 반환 (throw X)", async () => {
    const client = {
      conversations: {
        replies: async () => { throw new Error("API 오류"); },
        history: async () => { throw new Error("API 오류"); },
      },
    };
    const result = await fetchThreadContext(client, "C123", "100.000", "80.000");
    assert.deepStrictEqual(result, []);
  });
});

// ── buildThreadContextText ────────────────────────────────────────────────────
describe("buildThreadContextText", () => {
  test("빈 배열 → 빈 문자열", () => {
    assert.strictEqual(buildThreadContextText([]), "");
  });

  test("null/undefined → 빈 문자열", () => {
    assert.strictEqual(buildThreadContextText(null), "");
    assert.strictEqual(buildThreadContextText(undefined), "");
  });

  test("첫 메시지 → [엄마 스레드] 라벨", () => {
    const result = buildThreadContextText([{ text: "원본 문의" }]);
    assert.ok(result.includes("[엄마 스레드]"), `[엄마 스레드] 라벨 없음: ${result}`);
    assert.ok(result.includes("원본 문의"), `본문 누락: ${result}`);
  });

  test("두 번째 메시지 → [답변 1] 라벨", () => {
    const result = buildThreadContextText([
      { text: "원본" },
      { text: "답변입니다" },
    ]);
    assert.ok(result.includes("[답변 1]"), `[답변 1] 라벨 없음: ${result}`);
    assert.ok(result.includes("답변입니다"), `답변 본문 누락: ${result}`);
  });

  test("세 번째 메시지 → [답변 2] 라벨", () => {
    const result = buildThreadContextText([
      { text: "원본" },
      { text: "답변1" },
      { text: "답변2" },
    ]);
    assert.ok(result.includes("[답변 2]"), `[답변 2] 라벨 없음: ${result}`);
  });

  test("text 없거나 빈 메시지 → 필터링", () => {
    const result = buildThreadContextText([
      { text: "원본" },
      { text: "" },
      { text: "유효한 답변" },
    ]);
    assert.ok(result.includes("[엄마 스레드]"), "엄마 스레드 라벨 있어야 함");
    assert.ok(result.includes("[답변 2]"), "빈 메시지 건너뛰어 [답변 2] 있어야 함");
    assert.ok(!result.includes("[답변 1]"), "빈 메시지는 필터링돼 [답변 1] 없어야 함");
  });

  test("cleanSlackText 주입 반영 — Slack 마크업 정제", () => {
    const result = buildThreadContextText([{ text: "<https://example.com|링크>" }]);
    assert.ok(result.includes("링크"), `마크업 정제 안 됨: ${result}`);
    assert.ok(!result.includes("<https"), `마크업 미제거: ${result}`);
  });
});
