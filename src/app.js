require("dotenv").config();

// ── 1.guard / 2.클라이언트 / 3.모듈 / 4.flow / 5.핸들러 / 6.종료 ──

// fail-fast guard 호출: Bolt App init 직전에 필수 env를 검증 → 누락 시 startup throw
// (잘못된 기본값이 조용히 채워지는 것을 방지)
const { assertSecretsBase, assertGoogleSheets, assertChannels, assertTriggerEmoji, requireEnv } = require("./utils/env");
assertSecretsBase();
assertGoogleSheets();
assertChannels();
assertTriggerEmoji();

const { App } = require("@slack/bolt");
const { GoogleGenAI } = require("@google/genai");
const { google } = require("googleapis");
const cron = require("node-cron");
const fs   = require("fs");
const path = require("path");
const { loggedCall, cleanOldLogs, initAlertClient, sendAlert } = require("./apiLogger");
const { checkPermission } = require("./auth/permission-gate");
const { isTriggerReaction } = require("./utils/trigger");
const createSheetsClient = require("./clients/sheets-client");
const createTitleMatcher = require("./sheets/title-matcher");
const createDeliveryDateService = require("./sheets/delivery-date");
const createInquiryHistory = require("./sheets/inquiry-history");
const createResupplyRecord = require("./sheets/resupply-record");
const createProgress = require("./slack/progress");
const createInquiryAnalyzer = require("./ai/inquiry-analyzer");

// ── 트리거 이모지 (guard 통과 후 requireEnv — 코드 리터럴 fallback 금지) ──
const triggerEmoji = requireEnv("TRIGGER_EMOJI");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// ── progress 모듈 wiring (app.client + sendAlert 주입) ──────────────────────
const { buildProgressText, updateProgress, alertOnError, withTimeout } = createProgress({ slackClient: app.client, sendAlert });

// ── sheets transport client (R4-a) — sheets 모듈/flow 보다 먼저 ──
const sheetsClient = createSheetsClient({ google, getGoogleAuth });

// ── sheets 모듈 wiring (guard 통과 후, flow require 전 — 부팅 순서 의무) ────
// app.js가 process.env 직접 읽어 값으로 전달 (assertGoogleSheets() 선행 fail-fast 보증. 모듈 내부 process.env 직접 read 금지 — R3)
const titleMatcher = createTitleMatcher({
  google,
  getGoogleAuth,
  masterSheetId: process.env.MASTER_SHEET_ID,
  alertOnError,
  sheetsClient,
});
const { matchWorkTitleFromSheet, matchWorkTitleByTokens, matchWorkTitleWithCandidates, loadTitleRowsFromSheet } = titleMatcher;

const deliveryDateService = createDeliveryDateService({
  google,
  getGoogleAuth,
  deliverySheetId: process.env.DELIVERY_SHEET_ID,
  deliverySheetZhJa: process.env.DELIVERY_SHEET_ZH_JA,
  deliverySheetKoJa: process.env.DELIVERY_SHEET_KO_JA,
  alertOnError,
  sheetsClient,
});
const { parseEpisodeNumbers, fetchDeliveryDate } = deliveryDateService;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const GEMINI_MODEL          = process.env.GEMINI_MODEL;

// ── AI 분석 모듈 wiring (ai/GEMINI_MODEL 선언 후, flow require 전 — 부팅 순서 의무) ──
// analyzeInquiryWithAI / parseScheduleInquiry / parseFileInquiry → src/ai/inquiry-analyzer.js
const { analyzeInquiryWithAI, parseScheduleInquiry, parseFileInquiry } = createInquiryAnalyzer({ ai, GEMINI_MODEL, alertOnError });

// ── 환경 상수 (guard 통과 후) ──────────────────────────────────────
const SHEET_RANGE           = process.env.GOOGLE_SHEET_RANGE;
const TARGET_CHANNEL_ID      = process.env.TARGET_CHANNEL_ID;
const PM_SLACK_ID            = process.env.PM_SLACK_ID;
const PM_REQUEST_CHANNEL_ID  = process.env.PM_REQUEST_CHANNEL_ID;  // 재수급 전용
const SCHEDULE_CHANNEL_ID    = process.env.SCHEDULE_CHANNEL_ID;  // 납품일 변경 요청
const FIXED_MENTION_USER_IDS = (process.env.FORWARD_MENTION_USER_ID || "").split(",").filter(Boolean);
const RESUPPLY_SHEET_ID    = process.env.RESUPPLY_SHEET_ID;
const RESUPPLY_SHEET_RANGE = process.env.RESUPPLY_SHEET_RANGE;
const RETAKE_CHANNELS      = new Set(
  (process.env.RETAKE_CHANNELS || "").split(",").map(s => s.trim()).filter(Boolean)
);

// ── APM 이름 → Slack ID 매핑 ─────────────────────────────────────
// 납품 시트 D열 텍스트 기준. 추가 시 여기에 등록.
// 장기적으로는 Totus 프로젝트 APM 값으로 대체 예정.
const APM_SLACK_ID_MAP = {
  "서주원": "U07E0QPL8MV",
  "정태영": "U05CE8HFA6B",
};

function resolveApmUserId(apmName) {
  if (!apmName) return null;
  // 정확히 일치하는 이름 우선
  if (APM_SLACK_ID_MAP[apmName]) return APM_SLACK_ID_MAP[apmName];
  // 부분 일치 (예: "서주원(mona)" 같은 형태 대응)
  const found = Object.keys(APM_SLACK_ID_MAP).find(k => apmName.includes(k) || k.includes(apmName));
  return found ? APM_SLACK_ID_MAP[found] : null;
}

const processedMessageTs = new Set();
const draftStore         = new Map();

// ── 시트 write 모듈 wiring (T3 — R4 수렴 완료, sheetsClient 경유) ──────────────
const { appendInquiryHistory } = createInquiryHistory({
  sheetsClient,
  historySheetId: process.env.INQUIRY_HISTORY_SHEET_ID,
  historySheetRange: process.env.INQUIRY_HISTORY_SHEET_RANGE,
});
const { appendResupplyRecord, strikethroughResupplyRow } = createResupplyRecord({
  sheetsClient,
  resupplySheetId: RESUPPLY_SHEET_ID,
  resupplySheetRange: RESUPPLY_SHEET_RANGE,
  resupplyGridSheetId: 511152201,
});

// ── flow wiring (모듈 factory 직후, 핸들러 등록 전) ─────────────────
const { handleFileOrderInquiry } = require("./fileOrderFlow")(app, {
  ai, GEMINI_MODEL, matchWorkTitleFromSheet, matchWorkTitleWithCandidates, generateDraftId, draftStore,
});

const { handleRetakeInquiry } = require("./retakeFlow")(app, {
  ai, GEMINI_MODEL, matchWorkTitleFromSheet, matchWorkTitleByTokens, matchWorkTitleWithCandidates, generateDraftId, draftStore, sheetsClient,
});

const { handleScheduleExt, handleScheduleExtGrouped } = require("./scheduleExtFlow")(app, {
  ai, GEMINI_MODEL, matchWorkTitleFromSheet, generateDraftId, draftStore,
  fetchDeliveryDate, sheetsClient,
});

const { handleMultipleInquiry } = require("./multipleInquiryFlow")(app, {
  ai, GEMINI_MODEL,
  matchWorkTitleFromSheet, matchWorkTitleByTokens,
  generateDraftId, draftStore, fetchDeliveryDate,
  handleFileOrderInquiry, handleRetakeInquiry, handleScheduleExt, handleScheduleExtGrouped,
});

const { handleWorkerRelay } = require("./workerRelayFlow")(app, {
  ai, GEMINI_MODEL,
  matchWorkTitleFromSheet, generateDraftId, draftStore, sheetsClient,
});

// 인증 방식: service account JSON 파일 대신 GOOGLE_CREDENTIALS env에 JSON 문자열을 직접 저장.
// 형식: GOOGLE_CREDENTIALS='{"type":"service_account","project_id":"...","private_key":"...","client_email":"..."}'
// .env 파일에 한 줄로 넣으면 되고, 별도 service-account.json 파일을 둘 필요가 없다.
function getGoogleAuth(scopes) {
  const credentialsJson = process.env.GOOGLE_CREDENTIALS;
  let credentials;
  try {
    credentials = JSON.parse(credentialsJson);
  } catch (_e) {
    // H-6 fix: e.message에 raw JSON 일부(private_key 포함)가 노출될 수 있으므로 메시지만 고정 라벨로 출력
    throw new Error(
      `[getGoogleAuth] GOOGLE_CREDENTIALS JSON 파싱 실패 (형식 오류). process.env 값을 직접 검증 필요.\n` +
        `형식: '{"type":"service_account","project_id":"...","private_key":"...","client_email":"..."}'`
    );
  }
  return new google.auth.GoogleAuth({ credentials, scopes });
}

// ── 유틸 ──────────────────────────────────────────────────
// normalizeTitle / normalizeTitleKo / stripKariSuffix → src/sheets/normalize.js
// buildProgressText / updateProgress / alertOnError / withTimeout → src/slack/progress.js
// extractSlackPermalink / cleanSlackText → src/slack/text.js
// PROCESSED_REACTION / fetchSingleLinkedMessage / markInquiryProcessed / fetchThreadContext / buildThreadContextText → src/slack/thread-context.js

const { extractSlackPermalink, cleanSlackText } = require("./slack/text")();
const { PROCESSED_REACTION, fetchSingleLinkedMessage, markInquiryProcessed, fetchThreadContext, buildThreadContextText } = require("./slack/thread-context")({ cleanSlackText });

// ── 문의 블록/포매터 모듈 wiring ─────────────────────────────────────────
// buildFileInquiryReason / buildFileInquiryBlocks / buildFileInquiryMessage
// buildDraftPreviewBlocks / buildDraftPreviewText / buildFinalMainMessage / buildThreadMessage
// buildInquirySummaryMessage / buildMultipleInquirySummary / buildOtherInquirySummary
// PRIORITY_EMOJI → src/slack/inquiry-blocks.js (PM_SLACK_ID / FIXED_MENTION_USER_IDS 주입 — R3)
const createInquiryBlocks = require("./slack/inquiry-blocks");
const {
  PRIORITY_EMOJI,
  buildFileInquiryReason,
  buildFileInquiryBlocks,
  buildFileInquiryMessage,
  buildDraftPreviewBlocks,
  buildDraftPreviewText,
  buildFinalMainMessage,
  buildThreadMessage,
  buildInquirySummaryMessage,
  buildMultipleInquirySummary,
  buildOtherInquirySummary,
} = createInquiryBlocks({ pmSlackId: PM_SLACK_ID, fixedMentionUserIds: FIXED_MENTION_USER_IDS });

// ── AI 분석 ───────────────────────────────────────────────
// analyzeInquiryWithAI → src/ai/inquiry-analyzer.js

// ── 작품명 매칭 ───────────────────────────────────────────
// matchWorkTitleFromSheet / matchWorkTitleByTokens / matchWorkTitleWithCandidates → src/sheets/title-matcher.js

// ── 이력 기록 / 재수급 시트 write → src/sheets/inquiry-history.js + src/sheets/resupply-record.js ──
// appendInquiryHistory / appendResupplyRecord / strikethroughResupplyRow (R4 수렴 완료 — sheetsClient 경유)

// ── 납품 시트 조회 ────────────────────────────────────────
// parseEpisodeNumbers / fetchDeliveryDate → src/sheets/delivery-date.js

// ── AI 파서 ───────────────────────────────────────────────
// parseScheduleInquiry / parseFileInquiry → src/ai/inquiry-analyzer.js

// buildFileInquiryReason / buildFileInquiryBlocks / buildFileInquiryMessage → src/slack/inquiry-blocks.js

// ── T5 핸들러 register (재수급 / 스케줄 / 직접입력·문의완료·드래프트편집) ─────
require("./handlers/resupply-actions")(app, {
  draftStore,
  buildFileInquiryBlocks,
  buildFileInquiryMessage,
  appendResupplyRecord,
  strikethroughResupplyRow,
  PM_REQUEST_CHANNEL_ID,
});

require("./handlers/schedule-actions")(app, {
  draftStore,
  loadTitleRowsFromSheet,
  matchWorkTitleFromSheet,
  fetchDeliveryDate,
  handleScheduleExt,
  PM_SLACK_ID,
  SCHEDULE_CHANNEL_ID,
});

require("./handlers/direct-input-actions")(app, {
  draftStore,
  buildDraftPreviewBlocks,
  buildDraftPreviewText,
  buildFileInquiryBlocks,
  matchWorkTitleFromSheet,
  fetchDeliveryDate,
  handleFileOrderInquiry,
  handleScheduleExt,
  generateDraftId,
  resolveApmUserId,
  postInquiryToTargetChannel,
  TARGET_CHANNEL_ID,
});

// ── 드래프트 UI ───────────────────────────────────────────
function generateDraftId() { return `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }
// PRIORITY_EMOJI / buildDraftPreviewBlocks / buildDraftPreviewText / buildFinalMainMessage / buildThreadMessage → src/slack/inquiry-blocks.js

async function postInquiryToTargetChannel(client, draft, submitterId) {
  const msg = buildFinalMainMessage({ submitterId, workName: draft.workName, workNameKo: draft.workNameKo, episode: draft.episode, inquiryType: draft.inquiryType, inquiryContent: draft.inquiryContent, actionRequired: draft.actionRequired, draftId: draft.draftId });
  const postRes = await client.chat.postMessage({ channel: TARGET_CHANNEL_ID, ...msg });
  await client.chat.postMessage({ channel: TARGET_CHANNEL_ID, thread_ts: postRes.ts, text: buildThreadMessage({ summary: draft.summary, sourceLink: draft.sourceLink }) });
  await appendInquiryHistory(draft, submitterId);
  return postRes;
}

// buildInquirySummaryMessage / buildMultipleInquirySummary / buildOtherInquirySummary → src/slack/inquiry-blocks.js

// ── T4: inquiry-router + inquiry-entry wiring ─────────────────────
// 분류 로직 1벌: src/slack/inquiry-router.js (routeInquiry)
// 진입 어댑터 2종: src/handlers/inquiry-entry.js (reaction_added + app.message)
const createInquiryRouter = require("./slack/inquiry-router");
const inquiryRouter = createInquiryRouter({
  parseScheduleInquiry,
  parseFileInquiry,
  matchWorkTitleWithCandidates,
  matchWorkTitleFromSheet,
  matchWorkTitleByTokens,
  fetchDeliveryDate,
  generateDraftId,
  draftStore,
  buildFileInquiryBlocks,
  buildFileInquiryReason,
  buildDraftPreviewBlocks,
  buildDraftPreviewText,
  buildOtherInquirySummary,
  buildProgressText,
  flows: {
    handleScheduleExt,
    handleMultipleInquiry,
    handleWorkerRelay,
    handleRetakeInquiry,
    handleFileOrderInquiry,
  },
  retakeChannels: RETAKE_CHANNELS,
  analyzeInquiryWithAI,
});

require("./handlers/inquiry-entry")(app, {
  inquiryRouter,
  cleanSlackText,
  analyzeInquiryWithAI,
  buildProgressText,
  updateProgress,
  withTimeout,
  checkPermission,
  isTriggerReaction,
  triggerEmoji,
  fetchThreadContext,
  buildThreadContextText,
  markInquiryProcessed,
  extractSlackPermalink,
  fetchSingleLinkedMessage,
  processedMessageTs,
  // 결함 B: RETAKE 채널 선행 판정에 필요 (어댑터가 메인 AI 분석 전에 skip 결정)
  retakeChannels: RETAKE_CHANNELS,
});

// ── API 로그 분석 — 매일 15:00 KST ───────────────────────
// sendApiAnalysisReport → src/reports/kpi-report.js (R1 단일 책임 분리)
const { LOG_DIR } = require("./apiLogger");
const createKpiReport = require("./reports/kpi-report");
const kpiReport = createKpiReport({ slackClient: app.client, reportChannelId: PM_SLACK_ID, logDir: LOG_DIR });
cron.schedule("0 15 * * *", () => kpiReport.sendApiAnalysisReport(), { timezone: "Asia/Seoul" });
cleanOldLogs();
console.log("[apiAnalyzer] 일일 분석 스케줄 등록 완료 (매일 15:00 KST)");

// ── 서버 시작 ─────────────────────────────────────────────
(async () => {
  await app.start();
  // 알럿 클라이언트 초기화 (PM_SLACK_ID로 오류 알럿 전송)
  initAlertClient(app.client, PM_SLACK_ID);
  console.log("🚀 시스템 가동! 준비 완료!");
})();
