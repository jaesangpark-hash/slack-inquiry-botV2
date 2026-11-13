"use strict";
/**
 * E2 회귀 — 납품일 변경 요청이 확정 작품 언어를 잃는 문제 (AIA 5차 리뷰, 2026-10-30)
 *
 * 목적지·수신 PM 은 langOf = delivery.lang → matchedTitle.lang → lang → langPair 순으로 정한다.
 * 그런데 초안·pending 에 matchedTitle 이나 그 언어를 남기지 않아 두 번째 단계가 항상 비었다.
 * 한일 납품 탭에 그 회차 행이 없어 delivery=null 이면 langPair 만 남는데, 주 경로
 * (inquiry-router·multipleInquiryFlow·direct-input-actions)는 parsed.langPair 를 넘기지 않는다.
 * ⇒ 한일로 확정된 작품도 공통(중일) 스케줄 채널·공통 PM 으로 갔다.
 *
 * 그래서 여기서는 **parsed 에 langPair 를 넣지 않고**(실제 주 경로 모양) delivery=null 로 시작해,
 * app.view 에 등록된 schext_pm_modal_submit 핸들러를 실제로 불러 나간 메시지의 채널·멘션을 본다.
 *   ① 단건  ② 대조군(중일)  ③ 재진입(일수 모달)  ④ 묶음(handleScheduleExtGrouped)
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const registerScheduleExtFlow = require("../../scheduleExtFlow");
const { createLangRouting } = require("../../config/lang-routing");

const langRouting = createLangRouting({
  base: { target: "C", pmRequest: "C", schedule: "C_SCHED_ZH", mentionUserIds: ["U_ZH"], pmSlackId: "U_ZH_PM" },
  overrides: { "ko-ja": { schedule: "C_SCHED_KO", pmSlackId: "U_KO_PM" } },
});

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

// view 핸들러를 잡아 둘 수 있는 app. fetchDeliveryDate 는 시험마다 바꾼다(기본 = 납품 탭에 행 없음).
function register({ fetchDeliveryDate = async () => null } = {}) {
  const views = new Map();
  const app = { action() {}, view(id, fn) { views.set(id, fn); }, client: { users: { info: async () => ({}) } } };
  const draftStore = new Map();
  let seq = 0;
  const api = registerScheduleExtFlow(app, {
    ai: { models: { generateContent: async () => ({ text: "{}" }) } },
    GEMINI_MODEL: "fake",
    matchWorkTitleFromSheet: async () => null,
    generateDraftId: () => `draft-${++seq}`,
    draftStore,
    fetchDeliveryDate,
    sheetsClient: { getValues: async () => [] },
    langRouting,
  });
  return { api, views, draftStore };
}

async function withTotus(fn) {
  const restore = stubTotus();
  const prevUrl = process.env.PLATFORM_API_URL;
  process.env.PLATFORM_API_URL = "https://totus.test";
  try { await fn(); } finally {
    restore();
    if (prevUrl === undefined) delete process.env.PLATFORM_API_URL; else process.env.PLATFORM_API_URL = prevUrl;
  }
}

// 「PM 납품일 변경 요청」 모달 제출 → 나간 PM 요청 메시지(채널·첫 줄 멘션)
async function submitPmRequest(views, draftStore, client) {
  const draftId = [...draftStore.entries()].find(([, d]) => d.type === "schext")?.[0];
  assert.ok(draftId, "schext 초안이 저장되지 않았다 — 중간에 멈췄다");
  client.sent.length = 0;
  await views.get("schext_pm_modal_submit")({
    ack: async () => {},
    body: { user: { id: "U_APM" } },
    view: {
      private_metadata: JSON.stringify({ draftId }),
      state: { values: { pm_desired_date_block: { value: { value: "2026-07-20" } } } },
    },
    client,
  });
  const req = client.sent.find((m) => String(m.text).includes("납품일 변경이 가능할지"));
  assert.ok(req, "PM 요청 메시지가 나가지 않았다");
  return { channel: req.channel, mention: String(req.text).split("\n")[0] };
}

// 주 경로가 넘기는 모양: langPair 없음
const parsedNoLangPair = (extra = {}) => ({ episode: "1", extend_days: "3", ownerUserId: "U1", ...extra });
const koJaTitle = { pivoId: 123456, koreanProjectName: "테스트 작품", lang: "ko-ja" };

describe("E2 — 확정 작품 언어(matchedTitle.lang)가 납품일 변경 요청의 목적지·PM 을 정한다", () => {
  test("① 단건 — 한일 확정 작품 · delivery=null · parsed.langPair 없음 → 한일 채널·PM", async () => {
    await withTotus(async () => {
      const { api, views, draftStore } = register();
      const client = makeClient();
      await api.handleScheduleExt(client, "D1", parsedNoLangPair(), koJaTitle, null, "");

      const draft = [...draftStore.values()].find((d) => d.type === "schext");
      assert.equal(draft?.lang, "ko-ja", "초안에 확정 작품 언어가 남지 않았다");
      const { channel, mention } = await submitPmRequest(views, draftStore, client);
      assert.equal(channel, "C_SCHED_KO");
      assert.equal(mention, "<@U_KO_PM>");
    });
  });

  test("② 대조군 — 중일 확정 작품 · delivery=null → 공통 채널·PM (기존 동작 유지)", async () => {
    await withTotus(async () => {
      const { api, views, draftStore } = register();
      const client = makeClient();
      await api.handleScheduleExt(client, "D1", parsedNoLangPair(),
        { pivoId: 123456, koreanProjectName: "테스트 작품", lang: "zh-ja" }, null, "");

      const { channel, mention } = await submitPmRequest(views, draftStore, client);
      assert.equal(channel, "C_SCHED_ZH");
      assert.equal(mention, "<@U_ZH_PM>");
    });
  });

  test("③ 재진입 — 연장 일수 미상 pending → 일수 모달 제출 → 초안 → 한일 채널·PM", async () => {
    await withTotus(async () => {
      const { api, views, draftStore } = register();
      const client = makeClient();
      // extend_days 없음 → handleScheduleExt 가 schext_pending 을 저장하고 멈춘다
      await api.handleScheduleExt(client, "D1", parsedNoLangPair({ extend_days: undefined }), koJaTitle, null, "");

      const pendingEntry = [...draftStore.entries()].find(([, d]) => d.type === "schext_pending");
      assert.ok(pendingEntry, "schext_pending 이 저장되지 않았다");
      assert.equal(pendingEntry[1].lang, "ko-ja", "pending 에 확정 작품 언어가 남지 않았다");

      await views.get("schext_days_modal_submit")({
        ack: async () => {},
        view: {
          private_metadata: JSON.stringify({ pendingId: pendingEntry[0] }),
          state: { values: { ext_days_block: { value: { value: "3" } } } },
        },
        client,
      });

      const { channel, mention } = await submitPmRequest(views, draftStore, client);
      assert.equal(channel, "C_SCHED_KO");
      assert.equal(mention, "<@U_KO_PM>");
    });
  });

  test("④ 묶음 — 같은 작품(한일) 2회차 · 묶음 납품일 없음 → 한일 채널·PM", async () => {
    await withTotus(async () => {
      // 회차별 조회(「1」「2」)는 같은 납품일을 줘 두 회차가 한 묶음이 되게 하고,
      // 묶음 범위 조회(「1-2」)는 null — 묶음 초안의 delivery 가 비는 경우.
      const fetchDeliveryDate = async (_title, ep) =>
        String(ep).includes("-") ? null : { deliveryDate: "2026-07-30" };
      const { api, views, draftStore } = register({ fetchDeliveryDate });
      const client = makeClient();
      const item = (ep) => ({
        episode: String(ep),
        parsed: parsedNoLangPair({ episode: String(ep) }),
        matchedTitle: koJaTitle,
        delivery: null,
        sourceLink: "",
      });
      await api.handleScheduleExtGrouped(client, "D1", [item(1), item(2)]);

      const draft = [...draftStore.values()].find((d) => d.type === "schext");
      assert.deepEqual(draft?.episodes, [1, 2], "묶음 경로(2회차 한 초안)를 타지 않았다");
      assert.equal(draft.lang, "ko-ja", "묶음 초안에 확정 작품 언어가 남지 않았다");
      const { channel, mention } = await submitPmRequest(views, draftStore, client);
      assert.equal(channel, "C_SCHED_KO");
      assert.equal(mention, "<@U_KO_PM>");
    });
  });
});
