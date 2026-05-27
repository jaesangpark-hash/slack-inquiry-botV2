// ══════════════════════════════════════════════════════════════════
// apiLogger.js — API 호출 로깅 미들웨어
// app.js에서 require('./apiLogger') 로 호출
// ══════════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');

const LOG_DIR      = path.join(__dirname, 'logs');
const KEEP_DAYS    = 30;

// logs 디렉토리 없으면 생성
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function todayFile() {
  const d = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `api-${d}.jsonl`);
}

function appendLog(entry) {
  try {
    fs.appendFileSync(todayFile(), JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    console.error('[apiLogger] 로그 기록 실패:', e.message);
  }
}

// 30일 이상 된 로그 자동 삭제
function cleanOldLogs() {
  try {
    const files = fs.readdirSync(LOG_DIR).filter(f => f.startsWith('api-') && f.endsWith('.jsonl'));
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    for (const f of files) {
      const full = path.join(LOG_DIR, f);
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.unlinkSync(full);
        console.log(`[apiLogger] 오래된 로그 삭제: ${f}`);
      }
    }
  } catch (e) {
    console.error('[apiLogger] 로그 정리 실패:', e.message);
  }
}

// ── Slack 알럿 ────────────────────────────────────────────────────
// app.js에서 initAlertClient(client, userId)로 초기화
let _alertClient = null;
let _alertUserId = null;

function initAlertClient(client, userId) {
  _alertClient = client;
  _alertUserId = userId;
}

async function sendAlert(message) {
  if (!_alertClient || !_alertUserId) return;
  try {
    const dm = await _alertClient.conversations.open({ users: _alertUserId });
    await _alertClient.chat.postMessage({
      channel: dm.channel.id,
      text: `⚠️ *봇 오류 알럿*\n${message}\n_${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}_`,
    });
  } catch (e) {
    console.error('[apiLogger] 알럿 전송 실패:', e.message);
  }
}

/**
 * API 호출 래퍼
 * @param {Function} axiosFn  - axios 호출 함수 (async)
 * @param {object}   meta     - { bot, endpoint, params, expectedCount }
 *   bot           : 호출한 봇 이름 (예: 'retake', 'fileOrder')
 *   endpoint      : 엔드포인트 패턴 (예: '/projects/{uuid}/jobs')
 *   params        : 실제 쿼리 파라미터 객체 (예: { episode: 21 })
 *   expectedCount : 실제로 사용할 건수 (예: 1) — 없으면 null
 */
async function loggedCall(axiosFn, meta = {}) {
  const startedAt = Date.now();
  let returnedCount = null;
  let success = true;
  let errorMsg = null;

  try {
    const res = await axiosFn();
    // 응답에서 건수 추출 시도
    const data = res?.data?.data ?? res?.data;
    if (Array.isArray(data))            returnedCount = data.length;
    else if (data?.JOB목록)             returnedCount = data.JOB목록.length;
    else if (typeof data === 'object' && data !== null) returnedCount = 1;
    return res;
  } catch (e) {
    success  = false;
    errorMsg = e.message;
    // Totus API 오류 → 즉시 알럿
    await sendAlert(
      `*Totus API 오류*\n• 봇: \`${meta.bot ?? 'unknown'}\`\n• 엔드포인트: \`${meta.endpoint ?? 'unknown'}\`\n• 오류: ${e.message}`
    );
    throw e;
  } finally {
    appendLog({
      ts            : new Date().toISOString(),
      bot           : meta.bot           ?? 'unknown',
      endpoint      : meta.endpoint      ?? 'unknown',
      params        : meta.params        ?? {},
      expectedCount : meta.expectedCount ?? null,
      returnedCount,
      elapsedMs     : Date.now() - startedAt,
      success,
      errorMsg,
    });
  }
}

module.exports = { loggedCall, cleanOldLogs, LOG_DIR, initAlertClient, sendAlert };
