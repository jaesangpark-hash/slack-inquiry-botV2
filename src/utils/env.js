"use strict";
/**
 * slack-inquiry-bot 환경변수 fail-fast guard
 *
 * 헬퍼 6종(isUnset / coalesceNonEmpty / parseIntEnv / parseBoolEnv / requireEnv / assertRequired)은
 * 인라인 정의 (CJS 이식 — self-contained 상태).
 *
 * 3종 guard (비즈니스 로직 — inquiry-bot 전용):
 *   assertSecretsBase  — Slack BOT/APP + Gemini API Key + Gemini Model + Totus 게이트웨이 + Google Credentials (7종)
 *   assertGoogleSheets — 시트 ID 8종 + GOOGLE_SHEET_RANGE (9종)
 *   assertChannels     — 채널/유저 ID 6종
 *   assertTriggerEmoji — 트리거 이모지 (1종)
 *
 * 미래 확장:
 *   assertKpiSheets    — INQUIRY_HISTORY_SHEET_ID/RANGE (향후 KPI 기능용, 현재 미사용)
 */

// ---------------------------------------------------------------------------
// 헬퍼 6종 인라인 정의 (CJS — self-contained)
// ---------------------------------------------------------------------------

/**
 * 환경변수가 "미설정(undefined 또는 빈 문자열)"인지 판단
 * @param {string | undefined} raw
 * @returns {boolean}
 */
function isUnset(raw) {
  return raw === undefined || raw === "";
}

/**
 * 환경변수 alias OR-gate 헬퍼.
 * undefined 또는 "" 을 모두 skip하여 첫 비-빈-문자열(trim 후) 값을 반환.
 * 모두 미설정 시 "" 반환.
 * @param {...(string | undefined)} values
 * @returns {string}
 */
function coalesceNonEmpty(...values) {
  for (const v of values) {
    if (v !== undefined && v.trim() !== "") return v.trim();
  }
  return "";
}

/**
 * 정수 환경변수 파싱 (음수 허용, 외곽 공백 trim 허용).
 * 미설정 또는 파싱 실패 시 undefined 반환.
 * @param {string} name - 환경변수 이름 (에러 메시지용)
 * @param {string | undefined} raw - process.env[name] 값
 * @returns {number | undefined}
 */
function parseIntEnv(name, raw) {
  if (isUnset(raw)) return undefined;
  const trimmed = raw.trim();
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || String(n) !== trimmed) return undefined;
  return n;
}

/**
 * bool 환경변수 파싱 (대소문자 무시, 외곽 공백 trim 허용).
 * 허용: "true"/"1" → true, "false"/"0" → false, 그 외 → undefined.
 * @param {string} name - 환경변수 이름 (에러 메시지용)
 * @param {string | undefined} raw - process.env[name] 값
 * @returns {boolean | undefined}
 */
function parseBoolEnv(name, raw) {
  if (isUnset(raw)) return undefined;
  const lower = raw.trim().toLowerCase();
  if (lower === "true" || lower === "1") return true;
  if (lower === "false" || lower === "0") return false;
  return undefined;
}

/**
 * guard가 throw를 보장한 후 호출되는 string helper.
 * guard 없이 호출 시 명시적 Error throw.
 * @param {string} name - 환경변수 이름 (process.env의 키)
 * @returns {string}
 */
function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `[requireEnv] ${name} is undefined — guard(assert* 함수)가 먼저 호출되어야 합니다.`
    );
  }
  return value;
}

/**
 * 환경변수 목록이 모두 설정되어 있는지 검증하는 범용 fail-fast helper.
 * 누락된 변수가 있으면 Error를 throw.
 * @param {Record<string, string | undefined>} env
 * @param {readonly string[]} names
 * @param {string} context - 에러 메시지에 포함될 guard 컨텍스트 이름
 * @throws {Error} 누락된 환경변수가 1건 이상인 경우
 */
function assertRequired(env, names, context) {
  const missing = [];
  for (const name of names) {
    if (isUnset(env[name])) {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    throw new Error(`[${context}] 필수 환경변수 누락: ${missing.join(", ")}`);
  }
}

/**
 * Guard: Slack BOT/APP 토큰 + Gemini API Key + Gemini Model + Totus 게이트웨이 + Google Credentials (7종)
 * app.js 부팅 첫 라인에서 호출 (Bolt App init 직전).
 *
 * N-1 fix: assertRequired(process.env, names, context) 위임 (인라인 SSOT).
 * 이전 패턴 required.filter(isUnset)은 env 이름 문자열을 isUnset에 전달하는 버그.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env=process.env]
 * @throws {Error} 누락 env 목록과 함께 throw
 */
function assertSecretsBase(env = process.env) {
  assertRequired(env, [
    "SLACK_BOT_TOKEN",
    "SLACK_APP_TOKEN",
    "GEMINI_API_KEY",
    "GEMINI_MODEL",
    "PLATFORM_API_URL",
    "PLATFORM_API_TOKEN",
    "GOOGLE_CREDENTIALS",
  ], "assertSecretsBase");
}

/**
 * Guard: Google Sheets 시트 ID 8종 + GOOGLE_SHEET_RANGE (9종)
 * assertSecretsBase 직후 호출.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env=process.env]
 * @throws {Error} 누락 env 목록과 함께 throw
 */
function assertGoogleSheets(env = process.env) {
  assertRequired(env, [
    "MASTER_SHEET_ID",
    "DELIVERY_SHEET_ID",
    "DELIVERY_SHEET_KO_JA",
    "DELIVERY_SHEET_ZH_JA",
    "RESUPPLY_SHEET_ID",
    "RESUPPLY_SHEET_RANGE",
    "WORKER_SHEET_ID",
    "WORKER_SHEET_RANGE",
    "GOOGLE_SHEET_RANGE",
  ], "assertGoogleSheets");
}

/**
 * Guard: 채널/유저 ID 6종
 * assertGoogleSheets 직후 호출.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env=process.env]
 * @throws {Error} 누락 env 목록과 함께 throw
 */
function assertChannels(env = process.env) {
  assertRequired(env, [
    "PM_SLACK_ID",
    "TARGET_CHANNEL_ID",
    "PM_REQUEST_CHANNEL_ID",
    "SCHEDULE_CHANNEL_ID",
    "FORWARD_MENTION_USER_ID",
    "RETAKE_CHANNELS",
  ], "assertChannels");
}

/**
 * Guard: KPI 시트 (향후 KPI 기능용, 현재 미사용)
 * INQUIRY_HISTORY_SHEET_ID / INQUIRY_HISTORY_SHEET_RANGE
 * 현재는 정의만 해 둠 — KPI 기능 도입 시 app.js에서 명시 호출.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env=process.env]
 * @throws {Error} 누락 env 목록과 함께 throw
 */
function assertKpiSheets(env = process.env) {
  assertRequired(env, [
    "INQUIRY_HISTORY_SHEET_ID",
    "INQUIRY_HISTORY_SHEET_RANGE",
  ], "assertKpiSheets");
}

/**
 * Guard: 트리거 이모지 (reaction_added 핸들러 활성 조건)
 * TRIGGER_EMOJI (Variable)
 * app.js boot에서 assertChannels() 직후 호출.
 *
 * 설계 원칙:
 *   - 모듈별 guard 분리 — assertSecretsBase에 욱여넣지 않는다
 *   - 코드 리터럴 fallback(`process.env.X || "기본값"`) 금지 — guard 통과 후 requireEnv 사용
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env=process.env]
 * @throws {Error} 누락 env 목록과 함께 throw
 */
function assertTriggerEmoji(env = process.env) {
  assertRequired(env, [
    "TRIGGER_EMOJI",
  ], "assertTriggerEmoji");
}

module.exports = {
  isUnset,
  coalesceNonEmpty,
  parseIntEnv,
  parseBoolEnv,
  requireEnv,
  assertRequired,
  assertSecretsBase,
  assertGoogleSheets,
  assertChannels,
  assertKpiSheets,
  assertTriggerEmoji,
};
