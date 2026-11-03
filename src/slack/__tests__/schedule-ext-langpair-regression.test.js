"use strict";
/**
 * D1 회귀 — scheduleExtFlow 의 langPair ReferenceError (AIA 4차 리뷰 후속, 2026-10-29)
 *
 * 10792f8 은 _proceedScheduleExt 안 네 곳(pending·draft 저장)에 langPair 를 넣으면서
 * 정작 그 함수의 구조분해에는 넣지 않았다. 선언은 handleScheduleExt 안에만 있었으니
 * strict mode 에서 ReferenceError — 중일·한일 가릴 것 없이 연장 요청 전체가 멈춘다.
 *
 * 앞선 D 시험들은 schedule-actions 층에서 멈춰 이 함수까지 들어가지 않아 전부 통과했다.
 * 그래서 여기서는 **handleScheduleExt 를 실제로 불러** _proceedScheduleExt 를 통과시킨다.
 *   ① 회차를 특정 못 한 분기(재입력 pending 저장)
 *   ② 끝까지 가서 schext 초안을 저장하는 정상 분기
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const registerScheduleExtFlow = require("../../scheduleExtFlow");
const { createLangRouting } = require("../../config/lang-routing");

const langRouting = createLangRouting({
  base: { target: "C", pmRequest: "C", schedule: "C_SCHED", mentionUserIds: ["U_ZH"], pmSlackId: "U_ZH_PM" },
  overrides: { "ko-ja": { schedule: "C_SCHED_KO", pmSlackId: "U_KO_PM" } },
});

const makeApp = () => ({ action() {}, view() {}, client: { users: { info: async () => ({}) } } });

const makeClient = () => {
  const sent = [];
  return { sent,
    chat: { postMessage: async (p) => { sent.push(p); return { ts: "1.0" }; }, update: async () => ({}) },
    views: { open: async () => ({}), update: async () => ({}) } };
};

const json = (body) => ({
  status: 200, headers: { get: () => "application/json" },
  json: async () => body, text: async () => JSON.stringify(body),
});

// TOTUS 2콜(프로젝트 조회 → JOB 조회)만 흉내 낸다. 그 외 URL 은 시험을 깨뜨려 알린다.
function stubTotus() {
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/v1/projects?pivoId=")) {
      return json({ success: true, data: [{ uuid: "proj-1", _detail: { 진행상태: "IN_PROGRESS", pivoId: 123456 } }] });
    }
    if (u.includes("/jobs?episode=")) {
      return json({ success: true, data: [{ 오퍼레이션: [{ 태스크: [{
        uuid: "task-1", 오퍼레이션유형: "OTC0012", 오퍼레이션유형명: "번역",
        작업자: { 이메일: "worker@example.com", bid: "W" }, 상태: "IN_PROGRESS",
        시작일원본: "2026-07-01T00:00:00+09:00", 마감일원본: "2026-07-02T23:59:59+09:00",
        시작일: "2026.07.01", 마감일: "2026.07.02",
      }] }] }] });
    }
    throw new Error(`시험이 예상하지 않은 호출: ${u}`);
  };
  return () => { global.fetch = original; };
}

function register() {
  const draftStore = new Map();
  let seq = 0;
  const api = registerScheduleExtFlow(makeApp(), {
    ai: { models: { generateContent: async () => ({ text: "{}" }) } },
    GEMINI_MODEL: "fake",
    matchWorkTitleFromSheet: async () => null,
    generateDraftId: () => `draft-${++seq}`,
    draftStore,
    fetchDeliveryDate: async () => null,
    sheetsClient: { getValues: async () => [] },
    langRouting,
  });
  return { api, draftStore };
}

describe("D1 — handleScheduleExt → _proceedScheduleExt 가 langPair 로 터지지 않는다", () => {
  test("회차를 특정 못 하면 재입력 pending 을 남긴다 (예전엔 ReferenceError)", async () => {
    const { api, draftStore } = register();
    const client = makeClient();

    // episode 는 숫자가 아니라 걸러지고, extend_days 는 있으니 앞단 가드를 통과해
    // _proceedScheduleExt 의 "회차 비어 있음" 분기까지 들어간다.
    await api.handleScheduleExt(client, "D1",
      { episode: "x", extend_days: "3", langPair: "ko-ja", ownerUserId: "U1" }, null, null, "");

    const msg = client.sent.find((m) => String(m.text).includes("회차를 특정할 수 없어"));
    assert.ok(msg, "회차 재입력 안내가 나가지 않았다");
    const pending = [...draftStore.values()].find((d) => d.type === "schext_pending");
    assert.ok(pending, "재입력 pending 이 저장되지 않았다");
    assert.equal(pending.langPair, "ko-ja", "재진입 시 언어를 잃어버린다");
  });

  test("정상 경로 — schext 초안까지 저장하고 langPair 를 물고 간다", async () => {
    const restore = stubTotus();
    const prevUrl = process.env.PLATFORM_API_URL;
    process.env.PLATFORM_API_URL = "https://totus.test";
    try {
      const { api, draftStore } = register();
      const client = makeClient();

      await api.handleScheduleExt(client, "D1",
        { episode: "1", extend_days: "3", langPair: "ko-ja", ownerUserId: "U1" },
        { pivoId: 123456, koreanProjectName: "테스트 작품", lang: "ko-ja" }, null, "");

      const draft = [...draftStore.values()].find((d) => d.type === "schext");
      assert.ok(draft, "schext 초안이 저장되지 않았다 — _proceedScheduleExt 가 중간에 죽었다");
      assert.equal(draft.langPair, "ko-ja");
      assert.equal(draft.extDays, 3);
      assert.deepEqual(draft.episodes, [1]);
      assert.ok(client.sent.some((m) => String(m.text).includes("요청 작업자")), "다음 단계 안내가 안 나갔다");
    } finally {
      restore();
      if (prevUrl === undefined) delete process.env.PLATFORM_API_URL; else process.env.PLATFORM_API_URL = prevUrl;
    }
  });
});
