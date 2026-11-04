"use strict";
/**
 * retake-thread-attach.test.js — 리테이크 이미지 썸네일 스레드 첨부 회귀 가드 (aabd60b9a)
 *
 * 배경: 작업자 메시지 모달 제출(submit_retake_worker_msg_modal) 시 이미지 URL이 있으면
 *   메인 메시지(mainMsg) 전송 후 썸네일을 files.uploadV2로 업로드한다. thread_ts가 없어
 *   부모 메시지 스레드가 아닌 채널 신규 메시지로 올라가던 결함을 mainMsg.ts로 고정한다(aabd60b9a).
 *
 * 검증: 이미지 첨부 경로를 실제로 태워 files.uploadV2 호출 인자에
 *   thread_ts(=mainMsg.ts) + channel_id가 실리는지 — mainMsg.ts는 매 실행 난수라
 *   하드코딩 문자열이 우연히 일치할 수 없다(배선 증명).
 *
 * mock 경계: client.chat.postMessage(스파이 — 난수 ts 발급) / client.files.info(F-ID → download url) /
 *   axios.get(실 모듈 require 캐시 monkeypatch — arraybuffer 응답을 실 PNG 버퍼로 대체) /
 *   sharp(무접촉 — 실 리사이즈·PNG 인코딩·임시파일 기록까지 실 경로).
 * 감지 못하는 회귀: 실 Slack files.uploadV2 API의 스레드 렌더 자체(mock 고정) — prod dogfood 위임.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const registerRetakeFlow = require("../retakeFlow");
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

/** axios.get을 실 PNG 버퍼 응답으로 monkeypatch. require 캐시가 공유되므로 프로덕션 코드의
 *  `require("axios")`도 동일 객체를 참조 — get만 교체해도 실 코드 경로에 반영된다. */
async function withStubbedAxiosGet(run) {
  const original = axios.get;
  const pngBuffer = await sharp({
    create: { width: 4, height: 4, channels: 4, background: { r: 200, g: 0, b: 0, alpha: 1 } },
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

function makeClient() {
  const posts = [];
  const uploads = [];
  let tsSeq = 0;
  return {
    posts, uploads,
    chat: {
      // 매 호출마다 난수 ts 발급 — 고정 문자열 단언으로는 배선을 증명 못 함(하드코딩 우연 일치 방지).
      postMessage: async (args) => {
        const ts = `mainmsg_${Date.now()}_${tsSeq++}_${Math.random().toString(36).slice(2, 8)}`;
        posts.push({ ...args, ts });
        return { ts, channel: args.channel };
      },
      update: async () => ({}),
      postEphemeral: async () => ({}),
    },
    users:         { info: async () => ({ user: { profile: { display_name: "테스터" }, real_name: "테스터" } }) },
    conversations: { open: async () => ({ channel: { id: "DM_CH" } }), join: async () => ({}) },
    views:         { open: async () => ({}) },
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

function makeApp() {
  const actions = new Map();
  const views   = new Map();
  return {
    action(matcher, handler) { actions.set(String(matcher), handler); },
    view(matcher, handler)   { views.set(String(matcher), handler); },
    actions, views,
  };
}

function register(draftStore, app = makeApp()) {
  const api = registerRetakeFlow(app, {
    ai: { models: { generateContent: async () => ({ text: "{}" }) } },
    GEMINI_MODEL: "stub",
    matchWorkTitleFromSheet:      async () => null,
    matchWorkTitleByTokens:       async () => null,
    matchWorkTitleWithCandidates: async () => null,
    generateDraftId: () => "unused",
    draftStore,
    sheetsClient: { getValues: async () => [] },
    fetchDeliveryDate: async () => null,
    resolveApmUserId: () => null,
  });
  return { api, app };
}

/** submit_retake_worker_msg_modal이 소비하는 완성 단계 draft (오퍼레이션 선택 이후 상태). */
function seedWorkerDraft(draftStore, overrides = {}) {
  draftStore.set("rt_done", {
    type: "retake",
    ownerUserId: "U_OWNER",
    requesterUserId: "U_REQUESTER",
    requesterName:   "원문작성자",
    workName: "테스트작품", workNameKo: "테스트작품", episode: "1",
    operationName: "번역", operationCode: "TRANSLATION",
    endDate: "2026-08-10T18:00:00+09:00",
    workerChannelId: "C_WORKER", workerSlackIds: "U_WORKER",
    actualApm: "", actualApmId: null,
    dmChannelId: "DM_CH",
    ...overrides,
  });
  return "rt_done";
}

describe("retakeFlow: 작업자 메시지 모달 이미지 첨부 — 스레드 댓글 배선(aabd60b9a)", () => {
  test("이미지 URL 1건 → files.uploadV2가 thread_ts=mainMsg.ts + channel_id로 호출된다", async () => {
    const draftStore = new Map();
    const { app } = register(draftStore);
    const draftId = seedWorkerDraft(draftStore);
    const client = makeClient();

    const value = (v) => ({ value: { value: v } });
    await withStubbedAxiosGet(() => app.views.get("submit_retake_worker_msg_modal")({
      ack: async () => {},
      body: { user: { id: "U_CLICKER" } },
      view: {
        private_metadata: JSON.stringify({ draftId }),
        state: { values: {
          rt_worker_workname_block: value("테스트작품"),
          rt_worker_apm_block:      value(""),
          rt_worker_msg_block:      value("3페이지 대사 수정"),
          rt_worker_img_block:      value(IMG_URL),
        } },
      },
      client,
    }));

    const mainMsg = client.posts.find(p => p.channel === "C_WORKER");
    assert.ok(mainMsg, "메인 메시지가 전송되지 않으면 이 테스트가 무의미");
    assert.strictEqual(client.uploads.length, 1, "썸네일 업로드(files.uploadV2)가 1회 호출돼야 함");

    const upload = client.uploads[0];
    assert.strictEqual(upload.channel_id, "C_WORKER", "channel_id가 작업자 채널과 일치해야 스레드 업로드로 규정됨");
    assert.strictEqual(upload.thread_ts, mainMsg.ts,
      "thread_ts가 실제 전송된 메인 메시지의 ts와 정확히 일치해야 함(하드코딩 아닌 실배선 증명)");
    assert.notStrictEqual(upload.thread_ts, undefined, "thread_ts 누락(회귀) — 채널 신규 메시지로 올라감");
  });

  for (const [label, externalUrl, filesInfo] of EXTERNAL_URLS) {
    test(`${label} → 요청을 보내지 않고 원본 링크만 스레드에 남긴다`, async () => {
      const draftStore = new Map();
      const { app } = register(draftStore);
      const draftId = seedWorkerDraft(draftStore);
      const client = makeClient();
      client.files.info = filesInfo;

      const value = (v) => ({ value: { value: v } });
      await withStubbedAxiosGet(() => app.views.get("submit_retake_worker_msg_modal")({
        ack: async () => {},
        body: { user: { id: "U_CLICKER" } },
        view: {
          private_metadata: JSON.stringify({ draftId }),
          state: { values: {
            rt_worker_workname_block: value("테스트작품"),
            rt_worker_apm_block:      value(""),
            rt_worker_msg_block:      value("대사 수정"),
            rt_worker_img_block:      value(externalUrl),
          } },
        },
        client,
      }));

      const mainMsg = client.posts.find(p => p.channel === "C_WORKER");
      assert.ok(mainMsg, "메인 메시지가 전송되지 않으면 이 테스트가 무의미");
      assert.deepStrictEqual(axiosGetUrls, [], "외부 주소로 봇 토큰 요청이 나가면 안 됨");
      assert.strictEqual(client.uploads.length, 0, "내려받지 않았으니 썸네일 업로드도 없어야 함");
      assert.ok(
        client.posts.some(p => p.thread_ts === mainMsg.ts && p.text?.includes(`<${externalUrl}|`)),
        "원본 링크 안내가 메인 메시지 스레드에 남아야 함",
      );
    });
  }
});
