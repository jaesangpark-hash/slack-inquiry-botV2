"use strict";
/**
 * apiLogger.js — Totus API 호출 로깅 + 분석 리포트 알럿
 *
 * Totus API 호출을 래핑해 성공/실패/소요시간을 jsonl로 기록하고,
 * 일일 분석 리포트를 PM에게 DM으로 발송한다.
 *
 * Export:
 *   loggedCall(fn, meta)     — Totus API 호출 래퍼 (성공/실패/elapsed 기록)
 *   cleanOldLogs()           — 30일 이상 jsonl 자동 삭제
 *   initAlertClient(client, userId) — PM DM 알럿 클라이언트 초기화
 *   sendAlert(msg)           — PM DM 알럿 발송
 *   LOG_DIR                  — 로그 디렉토리 경로 (app.js sendApiAnalysisReport 에서 사용)
 *
 * 적재 형식 (스펙 §9 명시):
 *   logs/api-YYYY-MM-DD.jsonl — 1줄 1 JSON record
 *   { ts, endpoint, bot, params, expectedCount, returnedCount, elapsedMs, success }
 */

const fs = require("fs");
const path = require("path");

/** 로그 디렉토리 — app.js sendApiAnalysisReport 에서 import 후 사용 */
const LOG_DIR = path.join(process.cwd(), "logs");

/** 알럿 클라이언트 싱글턴 (mutable — initAlertClient 후 사용) */
let _alertClient = null;
let _alertUserId = null;

/**
 * PM DM 알럿 클라이언트 초기화.
 * app.js startup 시 1회 호출.
 * @param {import("@slack/web-api").WebClient} client
 * @param {string} userId — DM 수신 Slack User ID
 */
function initAlertClient(client, userId) {
  _alertClient = client;
  _alertUserId = userId;
}

/**
 * PM DM 알럿 발송.
 * alertOnError / withTimeout 래퍼가 catch 시 호출.
 * @param {string} msg
 */
async function sendAlert(msg) {
  if (!_alertClient || !_alertUserId) return;
  try {
    await _alertClient.chat.postMessage({
      channel: _alertUserId,
      text: msg,
    });
  } catch (e) {
    console.error("[apiLogger] sendAlert 실패:", e.message);
  }
}

/**
 * 오늘 날짜 기준 로그 파일 경로 반환.
 * @returns {string}
 */
function _logFilePath() {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `api-${today}.jsonl`);
}

/**
 * 로그 레코드 1건을 jsonl에 append.
 * @param {object} record
 */
function _appendLog(record) {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    fs.appendFileSync(_logFilePath(), JSON.stringify(record) + "\n", "utf8");
  } catch (e) {
    console.error("[apiLogger] 로그 기록 실패:", e.message);
  }
}

/**
 * Totus API 호출 래퍼.
 * 성공/실패 여부, elapsed ms, expectedCount/returnedCount 를 jsonl에 기록.
 *
 * @template T
 * @param {() => Promise<T>} fn — 실제 API 호출 함수
 * @param {{ bot: string, endpoint: string, params?: object, expectedCount?: number, returnedCount?: number }} meta
 * @returns {Promise<T>}
 */
async function loggedCall(fn, meta) {
  const start = Date.now();
  let success = false;
  try {
    const result = await fn();
    success = true;
    return result;
  } finally {
    const elapsedMs = Date.now() - start;
    _appendLog({
      ts: new Date().toISOString(),
      endpoint: meta.endpoint ?? "",
      bot: meta.bot ?? "",
      params: meta.params ?? {},
      expectedCount: meta.expectedCount ?? null,
      returnedCount: meta.returnedCount ?? null,
      elapsedMs,
      success,
    });
  }
}

/**
 * 30일 이상 오래된 jsonl 파일 자동 삭제.
 * app.js startup 시 1회 호출 (스펙 §9 명시).
 */
function cleanOldLogs() {
  if (!fs.existsSync(LOG_DIR)) return;
  const now = Date.now();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  try {
    const files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      const filePath = path.join(LOG_DIR, file);
      const { mtime } = fs.statSync(filePath);
      if (now - mtime.getTime() > THIRTY_DAYS_MS) {
        fs.unlinkSync(filePath);
        console.info(`[apiLogger] 오래된 로그 삭제: ${file}`);
      }
    }
  } catch (e) {
    console.error("[apiLogger] cleanOldLogs 실패:", e.message);
  }
}

/**
 * 완료 이벤트 단건 기록.
 * TOTUS API 래퍼 없이 Slack 발송 등 최종 액션을 로깅할 때 사용.
 * @param {string} bot
 * @param {string} endpoint
 * @param {number} elapsedMs
 * @param {boolean} success
 */
function logEvent(bot, endpoint, elapsedMs = 0, success = true) {
  _appendLog({
    ts: new Date().toISOString(),
    endpoint,
    bot,
    params: {},
    expectedCount: null,
    returnedCount: null,
    elapsedMs,
    success,
  });
}

module.exports = {
  loggedCall,
  logEvent,
  cleanOldLogs,
  initAlertClient,
  sendAlert,
  LOG_DIR,
};
