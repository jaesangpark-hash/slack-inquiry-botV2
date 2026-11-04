"use strict";
/**
 * worker-relay-thread-attach.test.js — 작업자 릴레이 이미지 썸네일 스레드 첨부 회귀 가드 (aabd60b9a)
 *
 * 배경: wr_send → _sendToWorkerChannel이 메인 메시지(sent) 전송 후 첨부 이미지(data.imageUrls)를
 *   files.uploadV2로 업로드한다. thread_ts가 없어 부모 메시지 스레드가 아닌 채널 신규 메시지로
 *   올라가던 결함을 sent.ts로 고정한다(aabd60b9a).
 *
 * 검증: wr_send 액션을 실제로 태워(worker-relay-target-and-dispatch.test.js 하니스 재사용)
 *   files.uploadV2 호출 인자에 thread_ts(=메인 메시지 sent.ts) + channel_id가 실리는지 확인한다.
 *
 * mock 경계: client.chat.postMessage(스파이 — 메인 메시지 ts 고정 반환) / client.files.info
 *   (F-ID → download url) / axios.get(실 모듈 require 캐시 monkeypatch — arraybuffer 응답을
 *   실 PNG 버퍼로 대체) / sharp(무접촉 — 실 리사이즈·PNG 인코딩·임시파일 기록까지 실 경로) /
 *   sheetsClient.getValues(작업자 시트 고정 row — 채널 해소용).
 * 감지 못하는 회귀: 실 Slack files.uploadV2 API의 스레드 렌더 자체(mock 고정) — prod dogfood 위임.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const registerWorkerRelayFlow = require("../workerRelayFlow");
const sharp = require("sharp");
const axios = require("axios");

const IMG_URL = "https://mock.slack.com/files/U0123/F0B04ENE8LB/thumb.png";

/** 토큰을 보내면 안 되는 사례: [이름, 입력 주소, files.info 동작]. */
const fileNotFound = async () => { throw new Error("file_not_found"); };
const EXTERNAL_URLS = [
  ["파일 ID 없는 외부 주소", "https://attacker.example/thumb.png", fileNotFound],
  ["files.info 실패 뒤 남은 외부 주소", "https://attacker.example/files/U0/F0B04ENE8LB/thumb.png", fileNotFound],
  ["Slack API 주소", "https://slack.com/api/auth.revoke", fileNotFound],
  ["files.info가 돌려준 외부 주소", IMG_URL, async () => ({ file: { url_private: "https://attacker.example/thumb.png" } })],
];
const axiosGetUrls = [];

async function withStubbedAxiosGet(run) {
  const original = axios.get;
  const pngBuffer = await sharp({
    create: { width: 4, height: 4, channels: 4, background: { r: 0, g: 0, b: 200, alpha: 1 } },
  }).png().toBuffer();
  axiosGetUrls.length = 0;
  axios.get = async (url) => {
    axiosGetUrls.push(url);
    return { data: pngBuffer };
  };
  try {
    return await run();
  } finally {
    axios.get = original;
  }
}

function makeApp() {
  const actionRegistry = [];
  return {
    action: (pattern, handler) => { actionRegistry.push({ pattern, fn: handler }); },
    view: () => {}, message: () => {}, event: () => {},
    _actionRegistry: actionRegistry,
  };
}

async function invokeAction(app, actionId, body, client) {
  const entry = app._actionRegistry.find(({ pattern }) =>
    pattern instanceof RegExp ? pattern.test(actionId) : pattern === actionId);
  if (!entry) throw new Error(`핸들러 미등록: ${actionId}`);
  await entry.fn({ ack: async () => {}, body, client });
}

function spy(impl) {
  const calls = [];
  const fn = async (...args) => { calls.push(args); return impl ? impl(...args) : undefined; };
  fn.calls = calls;
  return fn;
}

function makeAiMock() {
  return { models: { generateContent: async () => ({ text: "translated-body" }) } };
}

function makeFlow({ sheetsRows = [] } = {}) {
  const app = makeApp();
  const draftStore = new Map();
  const flow = registerWorkerRelayFlow(app, {
    ai: makeAiMock(), GEMINI_MODEL: "test-model",
    matchWorkTitleFromSheet: async () => null,
    generateDraftId: () => `draft_${Math.random().toString(36).slice(2, 8)}`,
    draftStore,
    sheetsClient: { getValues: async () => sheetsRows },
  });
  return { app, draftStore, flow };
}

function makeRelayDraft(overrides = {}) {
  return {
    type: "worker_relay",
    relayType: "번역문 누락",
    inquiryDetail: "ep45 sfx translation missing",
    actionRequired: "please send the sfx translation",
    corrections: [], missingItems: [],
    workName: "Starlight Hunter", workNameJa: "Starlight Hunter",
    episode: "45", episodeList: ["45"], episodeLabel: "45화",
    sourceLink: "https://slack.test/link",
    originalChannelId: "C_ORIG", originalTs: "1700.100",
    imageUrls: [], sourceLang: "en",
    requesterName: "Sikja", requesterMention: "<@U_REQ>",
    requesterOpName: "식자", requesterSlackId: "U_REQ", apmUserId: "U_REQ",
    targetWorkerEmail: "jane@ex.com", targetWorkerName: "jane",
    targetOpName: "식자번역검수", targetIsTranslator: true,
    dmChannelId: "D_APM",
    ...overrides,
  };
}

function makeSendClient() {
  const posted = [];
  const uploads = [];
  let tsSeq = 0;
  return {
    posted, uploads,
    chat: {
      update: spy(),
      // 매 호출마다 난수 ts 발급 — 고정 문자열 단언으로는 배선을 증명 못 함(하드코딩 우연 일치 방지).
      postMessage: spy(async (msg) => {
        const ts = `sentmsg_${Date.now()}_${tsSeq++}_${Math.random().toString(36).slice(2, 8)}`;
        posted.push({ ...msg, ts });
        return { ts };
      }),
    },
    users: {
      lookupByEmail: spy(async () => ({ user: { id: "U_JANE", profile: { display_name: "Jane Doe" } } })),
      info: spy(async () => ({ user: {} })),
    },
    conversations: {
      list: spy(async () => ({ channels: [], response_metadata: {} })),
      join: spy(),
    },
    reactions: { add: spy() },
    files: {
      info: async () => ({ file: { url_private_download: "https://files.slack.com/files-pri/T0/F0B04ENE8LB/thumb.png" } }),
      // 실 Slack SDK처럼 file 스트림을 끝까지 소비 — 프로덕션 코드가 uploadV2 직후 fs.unlink로
      // 임시파일을 지우므로, 스트림을 안 비우면 지연 open이 unlink와 경합해 ENOENT가 난다.
      uploadV2: async (args) => {
        uploads.push(args);
        if (args.file && typeof args.file.resume === "function") {
          await new Promise((resolve, reject) => {
            args.file.on("data", () => {});
            args.file.on("end", resolve);
            args.file.on("error", reject);
            args.file.resume();
          });
        }
        return {};
      },
    },
  };
}

describe("workerRelayFlow: wr_send 이미지 첨부 — 스레드 댓글 배선(aabd60b9a)", () => {
  it("이미지 URL 1건 → files.uploadV2가 thread_ts=메인 메시지 ts + channel_id로 호출된다", async () => {
    const sheetsRows = [
      ["이름", "이메일", "SlackID", "채널ID", "Totus이메일"],
      ["jane", "jane@ex.com", "U_JANE", "C_WORKER_JA", "jane@ex.com"],
    ];
    process.env.WORKER_SHEET_ID = "sheet-id";
    process.env.WORKER_SHEET_RANGE = "A:F";
    const { app, draftStore } = makeFlow({ sheetsRows });

    draftStore.set("d3", makeRelayDraft({ sourceLang: "ko", imageUrls: [IMG_URL] }));
    const client = makeSendClient();

    await withStubbedAxiosGet(() =>
      invokeAction(app, "wr_send", { actions: [{ value: "d3" }], channel: { id: "D_APM" }, message: { ts: "1.2" } }, client));

    const mainMsg = client.posted.find(m => m.channel === "C_WORKER_JA");
    assert.ok(mainMsg, "작업자 채널 메인 메시지가 없으면 이 테스트가 무의미");
    assert.strictEqual(client.uploads.length, 1, "썸네일 업로드(files.uploadV2)가 1회 호출돼야 함");

    const upload = client.uploads[0];
    assert.strictEqual(upload.channel_id, "C_WORKER_JA", "channel_id가 작업자 채널과 일치해야 스레드 업로드로 규정됨");
    assert.strictEqual(upload.thread_ts, mainMsg.ts,
      "thread_ts가 실제 전송된 메인 메시지의 ts와 정확히 일치해야 함(하드코딩 아닌 실배선 증명)");
    assert.notStrictEqual(upload.thread_ts, undefined, "thread_ts 누락(회귀) — 채널 신규 메시지로 올라감");
  });

  for (const [label, externalUrl, filesInfo] of EXTERNAL_URLS) {
    it(`${label} → 요청을 보내지 않고 원본 링크만 스레드에 남긴다`, async () => {
      const sheetsRows = [
        ["이름", "이메일", "SlackID", "채널ID", "Totus이메일"],
        ["jane", "jane@ex.com", "U_JANE", "C_WORKER_JA", "jane@ex.com"],
      ];
      process.env.WORKER_SHEET_ID = "sheet-id";
      process.env.WORKER_SHEET_RANGE = "A:F";
      const { app, draftStore } = makeFlow({ sheetsRows });

      draftStore.set("d4", makeRelayDraft({ sourceLang: "ko", imageUrls: [externalUrl] }));
      const client = makeSendClient();
      client.files.info = filesInfo;

      await withStubbedAxiosGet(() =>
        invokeAction(app, "wr_send", { actions: [{ value: "d4" }], channel: { id: "D_APM" }, message: { ts: "1" } }, client));

      const mainMsg = client.posted.find(m => m.channel === "C_WORKER_JA");
      assert.ok(mainMsg, "작업자 채널 메인 메시지가 없으면 이 테스트가 무의미");
      assert.deepStrictEqual(axiosGetUrls, [], "외부 주소로 봇 토큰 요청이 나가면 안 됨");
      assert.strictEqual(client.uploads.length, 0, "내려받지 않았으니 썸네일 업로드도 없어야 함");
      assert.ok(
        client.posted.some(m => m.thread_ts === mainMsg.ts && m.text?.includes(`<${externalUrl}|`)),
        "원본 링크 안내가 메인 메시지 스레드에 남아야 함",
      );
    });
  }
});
