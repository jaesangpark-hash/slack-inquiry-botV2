require("dotenv").config();

const { App } = require("@slack/bolt");
const { GoogleGenAI } = require("@google/genai");
const { google } = require("googleapis");
const cron = require("node-cron");
const fs   = require("fs");
const path = require("path");
const { loggedCall, cleanOldLogs, initAlertClient, sendAlert } = require("./apiLogger");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const GEMINI_MODEL          = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const SHEET_RANGE           = process.env.GOOGLE_SHEET_RANGE || "시트1!C:D";
const TARGET_CHANNEL_ID      = process.env.TARGET_CHANNEL_ID      || "C09B8QHP7D4";
const REPORT_CHANNEL_ID      = process.env.REPORT_CHANNEL_ID      || TARGET_CHANNEL_ID;
const PM_SLACK_ID            = process.env.PM_SLACK_ID            || "U04463JR4HH";
const PM_REQUEST_CHANNEL_ID  = process.env.PM_REQUEST_CHANNEL_ID  || "C06SUD5AFE1";  // 재수급 전용
const SCHEDULE_CHANNEL_ID    = process.env.SCHEDULE_CHANNEL_ID    || "C09G5LF1KRV";  // 납품일 변경 요청
const FIXED_MENTION_USER_IDS = (process.env.FORWARD_MENTION_USER_ID || "").split(",").filter(Boolean);

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

const titleCache         = { loadedAt: 0, rows: [] };
const processedMessageTs = new Set();
const draftStore         = new Map();

function getGoogleAuth(scopes) {
  return new google.auth.GoogleAuth({ keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_FILE, scopes });
}

// ── 유틸 ──────────────────────────────────────────────────
function extractSlackPermalink(text = "") {
  const match = text.match(/https:\/\/[^|\s>]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10,})/i);
  if (!match) return null;
  return { channelId: match[1], ts: match[2].slice(0, -6) + "." + match[2].slice(-6), url: match[0] };
}

function cleanSlackText(text = "") {
  return text
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2").replace(/<([^>]+)>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
}

function normalizeTitle(value = "") {
  return value.normalize("NFKC")
    .replace(/\s+/g, "").replace(/[「」『』【】\[\]\(\)（）]/g, "")
    .replace(/[~～〜〰\-‐-‒–—―_·•・:：!！?？"'`´""'']/g, "")
    .replace(/[、，。…]/g, "")
    .replace(/\.{2,}/g, "")
    .replace(/第?\d+話/g, "").replace(/仮$/i, "").toLowerCase().trim();
}

function normalizeTitleKo(value = "") {
  return value.normalize("NFKC")
    .replace(/\s+/g, "").replace(/[（）()\[\]【】「」『』<>《》]/g, "")
    .replace(/[~～〜〰\-‐-―_]/g, "")
    .replace(/（仮）|（仮$/g, "").toLowerCase().trim();
}

function stripKariSuffix(v = "") {
  return v.normalize("NFKC").replace(/\s*[\(（]仮[\)）]\s*$/u, "").trim();
}

function buildProgressText(step, note = "") {
  const steps = ["링크 확인", "메시지 조회", "AI 분석", "시트 매칭", "초안 작성"];
  const lines = ["*실행 중...*"];
  steps.forEach((label, i) => lines.push(i < step ? "■ " + label : i === step ? "▣ " + label : "□ " + label));
  if (note) lines.push("", note);
  return lines.join("\n");
}

async function updateProgress(channel, ts, step, note = "") {
  await app.client.chat.update({ channel, ts, text: buildProgressText(step, note) });
}

async function fetchSingleLinkedMessage(client, channelId, ts) {
  const res = await client.conversations.history({ channel: channelId, oldest: ts, inclusive: true, limit: 1 });
  return res.messages?.[0] || null;
}

// ── 처리 완료 이모지 ────────────────────────────────────────
// 한 번 분기 처리까지 끝낸 원본 메시지에 부착해서, 같은 스레드에서 다른 댓글로 재소환되어도 재분석되지 않게 함.
const PROCESSED_REACTION = "대응완료";

async function markInquiryProcessed(client, channelId, ts) {
  try {
    await client.reactions.add({ channel: channelId, name: PROCESSED_REACTION, timestamp: ts });
  } catch (e) {
    const code = e?.data?.error || e.message;
    if (code === "already_reacted") return;
    console.error("[markInquiryProcessed]", code);
  }
}

// ── 스레드 전체 맥락 조회 (엄마 스레드 ~ 소환 메시지) ────────
async function fetchThreadContext(client, channelId, targetTs, threadTs) {
  try {
    // threadTs가 없으면 단일 메시지 (스레드 아님)
    if (!threadTs) {
      const msg = await fetchSingleLinkedMessage(client, channelId, targetTs);
      return msg ? [msg] : [];
    }

    // 스레드 전체 조회
    const res = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 100 });
    if (!res.messages || !res.messages.length) return [];

    // 1. 소환된 메시지(targetTs) 이전 메시지만 필터 (이후 메시지 제외)
    // 2. 봇 메시지(bot_id 있는 것) 제외
    // 3. 자기 자신(targetTs)이 아닌 메시지 중 `대응완료` 이모지가 붙은 건 제외 (이미 처리된 문의)
    const targetTime = parseFloat(targetTs);
    const filtered = res.messages.filter(m => {
      if (parseFloat(m.ts) > targetTime) return false;
      if (m.bot_id) return false;
      if (m.ts !== targetTs && m.reactions?.some(r => r.name === PROCESSED_REACTION)) return false;
      return true;
    });

    return filtered;
  } catch (e) {
    console.error("[fetchThreadContext] 오류:", e.message);
    return [];
  }
}

// ── 스레드 메시지들을 분석용 텍스트로 결합 ──────────────────
function buildThreadContextText(messages) {
  if (!messages || !messages.length) return "";
  
  const parts = messages.map((msg, idx) => {
    const text = cleanSlackText(msg.text || "");
    if (!text) return null;
    
    // 엄마 스레드 / 댓글 구분
    const label = idx === 0 ? "[엄마 스레드]" : `[답변 ${idx}]`;
    return `${label}\n${text}`;
  }).filter(Boolean);

  return parts.join("\n\n");
}

// ── AI 분석 ───────────────────────────────────────────────
// ── 외부 API 오류 알럿 래퍼 ──────────────────────────────────────
// Gemini / Google Sheets 호출 실패 시 PM에게 즉시 알럿
async function alertOnError(label, fn) {
  try {
    return await fn();
  } catch (e) {
    console.error(`[${label}] 오류:`, e.message);
    await sendAlert(`*${label} 오류*\n${e.message}`).catch(() => {});
    throw e;
  }
}

// ── 타임아웃 래퍼 ────────────────────────────────────────────────
// 30초 초과 시 dmChannel에 안내 + 나한테 알럿
async function withTimeout(fn, { dmChannel, client, label = "봇 처리" } = {}) {
  const TIMEOUT_MS = 30000;
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("TIMEOUT")), TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([fn(), timeoutPromise]);
    clearTimeout(timer);
    return result;
  } catch (e) {
    clearTimeout(timer);
    if (e.message === "TIMEOUT") {
      console.error(`[timeout] ${label} 30초 초과`);
      if (dmChannel && client) {
        await client.chat.postMessage({
          channel: dmChannel,
          text: `⏱ 처리 시간이 초과됐어. 다시 소환해줘.\n문제가 반복되면 담당자에게 문의해줘.`,
        }).catch(() => {});
      }
      await sendAlert(`*타임아웃*\n• 위치: \`${label}\`\n• 30초 초과로 처리가 중단됐어.`).catch(() => {});
    } else {
      // 타임아웃 외 일반 오류도 알럿
      await sendAlert(`*${label} 오류*\n${e.message}`).catch(() => {});
    }
    throw e;
  }
}

async function analyzeInquiryWithAI(sourceText, isThreadContext = false) {
  const prompt = `
너는 웹툰/만화 로컬라이징 전문 문의 분석 AI다.

${isThreadContext ? `
[스레드 맥락 분석 모드]
아래 문의는 Slack 스레드의 전체 맥락이야. [엄마 스레드]부터 [답변 N]까지의 흐름을 종합해서 분석해줘.

**분석 우선순위:**
1) 작품명·회차 → 엄마 스레드에서 우선 추출 (없으면 댓글에서)
2) 문의 유형·액션 → 가장 마지막 [답변 N] (소환된 메시지) 기준으로 판단
3) 상세 내용 → 전체 흐름 종합

**예시:**
[엄마 스레드]에 "『작품명』 99화에서..." 있으면 → title_ja는 이걸로 추출
마지막 [답변 3]에 "이미지 공유합니다" → action_required는 이 메시지의 의도 파악
` : ''}

[규칙]
1) translated_ko
   - 원문이 일본어 또는 중국어: 전체를 자연스러운 한국어로 번역 (요약 금지, 구조 유지)
   - 원문이 한국어: 원문 그대로 반환 (번역하지 말 것)
   - 고유명사는 일본어 원문 유지. 인용문은 원문 그대로.
2) source_lang — "ja" | "zh" | "ko" | "other"
3) summary_ko — 1~2문장 핵심 요약. 작품명이 포함될 경우 반드시 원문(일본어·중국어) 그대로 사용할 것 (번역 금지)
4) action_required — 담당자가 취해야 할 다음 액션 1문장. 작품명이 포함될 경우 반드시 원문(일본어·중국어) 그대로 사용할 것 (번역 금지)
5) title_ja — 일본어·중국어 작품명 원문 그대로 추출. 절대 번역하지 말 것. 괄호(「」『』<>《》【】 등)·(仮) 제거. 없으면 null
6) title_ko — 한국어 작품명 원문 그대로 추출. 절대 번역하지 말 것. 괄호·(仮) 제거. 없으면 null
7) inquiry_type — 아래 중 가장 적합한 하나만 선택. 판단 순서대로 적용할 것:
   - "스케줄 문의"     : 납품일·작업 일정 연장/변경 요청
   - "원본 파일 순서"  : 파일 순서·페이지 배열이 잘못됐다는 문의 (파일 자체는 존재하나 순서 오류)
   - "원본 파일 확인"  : 파일 자체의 물리적 결함으로 인해 작업이 불가능하여 파일 재전송이 필요한 경우. 해당: 파일 누락·손상·레이어 미분리·프리뷰와 작화 상이. 미해당(→작업 관련 문의): 대사 내용 확인, 말풍선 내용 질문, 원문 대사 검수, "이 대사가 맞나요" 류의 내용 판단 요청 — 이미지 공유 요청이 포함되어 있어도 목적이 대사 확인이면 "작업 관련 문의"로 분류.
   - "번역문 누락" : ★최우선 판단★ 번역문을 받지 못했거나 전달되지 않아 작업이 지연·불가한 경우. "번역문 못 받았어요", "번역문 안 왔어요", "번역문 누락", "번역문 받지 못하여 제출 지연", "번역문 전달 받는 대로 작업" 등 번역문 미수신이 원인인 경우. 제출 지연·작업 완료 언급이 있어도 번역문 미수신이 원인이면 반드시 "번역문 누락"으로 분류.
   - "번역문 확인" : 번역문 내용 이슈 — 오탈자·대사 불일치·내용 확인 요청 (예: "번역문 확인 부탁드려요", "대사가 다른 것 같아요")
   - "번역문 수정" : ★우선 판단★ 번역문 내용(오역·오탈자·표현 변경 등)을 수정하여 재전달하는 경우. 발신자가 번역가이거나, 번역문 수정본을 식자 작업자에게 전달하는 상황. 영어·일본어로 작성된 문의도 해당. "change translation", "翻訳を変更", "번역 수정", 수정 전/후 대사가 명시된 경우 모두 해당. 미해당(→수정&리테이크): 식자 완료 후 재작업, Totus 태스크 재오픈
   - "작업 관련 문의"  : 번역·식자 작업 내용 관련 질문. 대사 확인·내용 문의·원문 검수·작업 가능 여부 판단이 필요한 경우. 파일을 요청하더라도 목적이 내용 확인이면 여기에 해당. 단, 번역문 미수신이 원인인 경우는 "번역문 누락"으로 분류.
   - "수정&리테이크"   : 식자·식자검수 완료 후 재작업 요청, 또는 Totus 태스크 재오픈 요청 (예: "다시 열어주세요", "에디터 돌려주세요", "리테이크"). 식자 관련 수정에 한정. 미해당(→번역문 수정): 번역문 내용 수정 요청, 수정 전/후 대사가 명시된 경우
   - "복수 문의"       : 아래 중 하나라도 해당하면 복수 문의로 분류
       · 위 유형 중 2가지 이상이 혼재하는 경우
       · 동일 유형이라도 작품명이 2개 이상 언급된 경우 (예: A작품 130화 + B작품 60화 일정 조정 요청)
       · 단, 동일 작품의 연속/복수 화수(예: 130-132화, 130화·131화)는 유형에 따라 처리 방식이 다름:
         - 문의·재수급 유형: 단건으로 묶어서 처리 (화수별 분리 불필요)
         - 스케줄·파일순서·리테이크 유형: 화수별로 별도 항목으로 분리 (화수마다 독립적으로 처리해야 함)
   - "기타"            : 위 어느 유형에도 해당하지 않는 경우
8) priority — "높음" | "보통" | "낮음"
9) episode — 문의에서 언급된 화수(숫자만). 여러 화차면 첫 번째만. 없으면 null

JSON만 출력. 코드블록 금지.
{"translated_ko":"string","source_lang":"string","summary_ko":"string","action_required":"string","title_ja":"string|null","title_ko":"string|null","inquiry_type":"string","priority":"string","episode":"string|null","multi_items":"array|null"}

multi_items: inquiry_type이 "복수 문의"인 경우에만 항목 배열 반환, 그 외 null
각 항목 형식:
{"type":"스케줄|재수급|파일순서|리테이크|문의|불명","work_title_ja":"string|null","work_title_ko":"string|null","episode":"string|null","extend_days":"number|null","requested_date":"string|null","reason":"string|null","content":"string|null","file_numbers":"array"}

문의 메시지:
${sourceText}`.trim();

  const response = await alertOnError("Gemini(analyzeInquiry)", () =>
    ai.models.generateContent({ model: GEMINI_MODEL, contents: prompt })
  );
  const cleaned  = (response.text || "").trim().replace(/```json|```/g, "").trim();
  const parsed   = JSON.parse(cleaned);
  return {
    translated_ko:   parsed.translated_ko   || "",
    source_lang:     parsed.source_lang     || "ja",
    summary_ko:      parsed.summary_ko      || "",
    action_required: parsed.action_required || "내용 확인 후 회신 필요",
    title_ja:        parsed.title_ja        || null,
    title_ko:        parsed.title_ko        || null,
    inquiry_type:    parsed.inquiry_type    || "기타",
    priority:        parsed.priority        || "보통",
    episode:         parsed.episode         || null,
    multi_items:     Array.isArray(parsed.multi_items) ? parsed.multi_items : null,
  };
}

// ── 작품명 매칭 ───────────────────────────────────────────
// 새 시트 구조 (한일/중일 공통):
//   A=공통번호, B=pivo_id, C=론칭일, D=JP_title, E=가제(일본어), F=원제(중국어), G=프로젝트명(한국어표시용)
// 반환값: { ko, jaDisplay, jaNorm, koNorm, projectName, pivoId }
//   projectName = G열 한국어 프로젝트명 (APM 표시용)
//   pivoId      = B열 (Totus API 매핑용, 결과물 미노출)

const MASTER_SHEET_ID  = process.env.MASTER_SHEET_ID || "1413O605lx7KtSuVq9a0VxgCr4fG4WOySPfgdA1eFBAA";
const ZHJA_SHEET_RANGE = "'중일_master'!A:G";
const HAJA_SHEET_RANGE = "'한일_master'!A:G";

async function _loadMasterRows(range) {
  const sheets = google.sheets({ version: "v4", auth: getGoogleAuth(["https://www.googleapis.com/auth/spreadsheets.readonly"]) });
  const res = await alertOnError("GoogleSheets(masterRows)", () =>
    sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range })
  );
  const rows = (res.data.values || []).slice(1); // 헤더 제외
  return rows.map(row => {
    const pivoId      = (row[1] || "").trim();                        // B열
    const jpTitle     = (row[3] || "").trim();                        // D열 JP_title(일본어 타이틀)
    const jaDisplay   = stripKariSuffix((row[4] || "").trim());       // E열 가제
    const ko          = (row[5] || "").trim();                        // F열 원제(중국어) — 매칭에 미사용
    const projectName = (row[6] || "").trim();                        // G열 프로젝트명(한국어)
    return { ko, jaDisplay, jpTitle, jaNorm: normalizeTitle(jaDisplay), koNorm: normalizeTitleKo(ko), projectName, pivoId };
  }).filter(r => r.ko || r.jaDisplay);
}

async function loadTitleRowsFromSheet() {
  if (Date.now() - titleCache.loadedAt < 300000 && titleCache.rows.length) return titleCache.rows;
  titleCache.rows = await _loadMasterRows(ZHJA_SHEET_RANGE);
  titleCache.loadedAt = Date.now();
  console.log("[DEBUG-SHEET] 중일_master 로드:", titleCache.rows.length, "건, 마지막 3행:", JSON.stringify(titleCache.rows.slice(-3)));
  return titleCache.rows;
}

async function matchWorkTitleFromSheet(titleJa, titleKo = null) {
  if (!titleJa && !titleKo) return null;
  const rows = await loadTitleRowsFromSheet();

  // 1순위: 한국어 — G열(projectName) 완전 일치
  if (titleKo) {
    const needle = normalizeTitleKo(titleKo);
    const exact  = rows.find(r => r.projectName && normalizeTitleKo(r.projectName) === needle);
    if (exact) { console.log("[match] 한국어 G열 완전일치:", exact.projectName); return exact; }
  }
  // 2순위: 한국어 — G열(projectName) 부분 일치
  if (titleKo) {
    const needle = normalizeTitleKo(titleKo);
    const partial = rows.find(r => r.projectName && (
      normalizeTitleKo(r.projectName).includes(needle) ||
      needle.includes(normalizeTitleKo(r.projectName))
    ));
    if (partial) { console.log("[match] 한국어 G열 부분일치:", partial.projectName); return partial; }
  }
  // 3순위: 일본어 — E열(jaDisplay) 완전 일치 (仮 제거 후)
  if (titleJa) {
    const needle = normalizeTitle(titleJa);
    const exact  = rows.find(r => r.jaNorm === needle);
    if (exact) { console.log("[match] 일본어 E열 완전일치:", exact.jaDisplay, "| pivoId:", exact.pivoId, "| projectName:", exact.projectName); return exact; }
  }
  // 4순위: 일본어 — E열(jaDisplay) 부분 일치 (仮 제거 후)
  if (titleJa) {
    const needle = normalizeTitle(titleJa);
    const partial = rows.find(r => r.jaNorm && (r.jaNorm.includes(needle) || needle.includes(r.jaNorm)));
    if (partial) { console.log("[match] 일본어 E열 부분일치:", partial.jaDisplay); return partial; }
  }

  console.log("[match] 매칭 실패 — ja:", titleJa, "ko:", titleKo);
  return null;
}

// ── 토큰 매칭 전용 (1~4순위 실패 후 호출) ────────────────
// 반환: { single: row } | { multiple: [row, ...] } | null
async function matchWorkTitleByTokens(titleKo, titleJa = null) {
  if (!titleKo && !titleJa) return null;
  const rows = await loadTitleRowsFromSheet();

  // 한국어 토큰 매칭 (G열 projectName)
  if (titleKo) {
    const tokens = titleKo.split(/\s+/).map(t => normalizeTitleKo(t)).filter(t => t.length >= 2);
    if (tokens.length) {
      const matched = rows.filter(r =>
        r.projectName && tokens.every(token => normalizeTitleKo(r.projectName).includes(token))
      );
      console.log(`[match-token] 한국어 토큰:${JSON.stringify(tokens)} → ${matched.length}건`);
      if (matched.length === 1) return { single: matched[0] };
      if (matched.length > 1)  return { multiple: matched };
    }
  }

  // 일본어 토큰 매칭 (E열 jaNorm)
  if (titleJa) {
    const tokens = normalizeTitle(titleJa).split(/\s+/).filter(t => t.length >= 2);
    if (tokens.length) {
      const matched = rows.filter(r =>
        r.jaNorm && tokens.every(token => r.jaNorm.includes(token))
      );
      console.log(`[match-token] 일본어 토큰:${JSON.stringify(tokens)} → ${matched.length}건`);
      if (matched.length === 1) return { single: matched[0] };
      if (matched.length > 1)  return { multiple: matched };
    }
  }

  return null;
}

// ── 부분일치 복수 후보 감지 (2·4순위 보완) ───────────────
// 반환: { single: row } | { multiple: [row, ...] } | { tooMany: true } | null
// 1·3순위(완전일치)는 단건 확정이므로 제외, 2·4순위 부분일치에서만 복수 체크
const CANDIDATE_MAX = 5;
async function matchWorkTitleWithCandidates(titleJa, titleKo = null) {
  if (!titleJa && !titleKo) return null;
  const rows = await loadTitleRowsFromSheet();

  // 1순위: 한국어 완전일치 → 단건 확정
  if (titleKo) {
    const needle = normalizeTitleKo(titleKo);
    const exact  = rows.find(r => r.projectName && normalizeTitleKo(r.projectName) === needle);
    if (exact) return { single: exact };
  }
  // 2순위: 한국어 부분일치 → 복수 체크
  if (titleKo) {
    const needle  = normalizeTitleKo(titleKo);
    const matched = rows.filter(r => r.projectName && (
      normalizeTitleKo(r.projectName).includes(needle) ||
      needle.includes(normalizeTitleKo(r.projectName))
    ));
    if (matched.length === 1) return { single: matched[0] };
    if (matched.length > 1 && matched.length <= CANDIDATE_MAX) return { multiple: matched };
    if (matched.length > CANDIDATE_MAX) return { tooMany: true };
  }
  // 3순위: 일본어 완전일치 → 단건 확정
  if (titleJa) {
    const needle = normalizeTitle(titleJa);
    const exact  = rows.find(r => r.jaNorm === needle);
    if (exact) return { single: exact };
  }
  // 4순위: 일본어 부분일치 → 복수 체크
  if (titleJa) {
    const needle  = normalizeTitle(titleJa);
    const matched = rows.filter(r => r.jaNorm && (r.jaNorm.includes(needle) || needle.includes(r.jaNorm)));
    if (matched.length === 1) return { single: matched[0] };
    if (matched.length > 1 && matched.length <= CANDIDATE_MAX) return { multiple: matched };
    if (matched.length > CANDIDATE_MAX) return { tooMany: true };
  }

  return null;
}

// ── 이력 기록 ─────────────────────────────────────────────
async function appendInquiryHistory(draft, submitterId) {
  // 문의 이력 시트 미지정 — INQUIRY_HISTORY_SHEET_ID / INQUIRY_HISTORY_SHEET_RANGE 환경변수 추가 후 활성화
  const sheetId    = process.env.INQUIRY_HISTORY_SHEET_ID;
  const sheetRange = process.env.INQUIRY_HISTORY_SHEET_RANGE;
  if (!sheetId || !sheetRange) return;
  try {
    const sheets = google.sheets({ version: "v4", auth: getGoogleAuth(["https://www.googleapis.com/auth/spreadsheets"]) });
    const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId, range: sheetRange, valueInputOption: "USER_ENTERED",
      requestBody: { values: [[now, draft.workName||"", draft.workNameKo||"", draft.inquiryType||"", draft.summary||"", draft.actionRequired||"", draft.sourceLink||"", submitterId||""]] },
    });
  } catch (e) { console.error("이력 기록 실패:", e.message); }
}

// resupply-sheet-start
const RESUPPLY_SHEET_ID    = process.env.RESUPPLY_SHEET_ID    || "1_ytcJGNcLjcmmED8_zLXpWj7BEpqMthdGn12zOKDWUA";
const RESUPPLY_SHEET_RANGE = process.env.RESUPPLY_SHEET_RANGE || "재수급봇!A:H";

async function appendResupplyRecord(draft, submitterId, client) {
  try {
    let requesterName = submitterId;
    try {
      const userInfo = await client.users.info({ user: submitterId });
      requesterName = userInfo.user?.profile?.display_name || userInfo.user?.real_name || submitterId;
    } catch (_) {}

    const apmName = requesterName;
    const fileNums = draft.fileNumbers?.length ? draft.fileNumbers.join(", ") : "-";
    const episodeAndFiles = [
      draft.episode ? `${draft.episode}화` : null,
      fileNums !== "-" ? fileNums : null,
    ].filter(Boolean).join(" / ");

    const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    const sourceLink = draft.sourceLink || "-";

    const sheets = google.sheets({
      version: "v4",
      auth: getGoogleAuth(["https://www.googleapis.com/auth/spreadsheets"]),
    });

    const appendRes = await sheets.spreadsheets.values.append({
      spreadsheetId: RESUPPLY_SHEET_ID,
      range: RESUPPLY_SHEET_RANGE,
      valueInputOption: "USER_ENTERED",
      includeValuesInResponse: false,
      responseValueRenderOption: "UNFORMATTED_VALUE",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[
          requesterName,
          apmName,
          draft.workName || "-",
          episodeAndFiles || "-",
          draft.reason || "-",
          now,
          sourceLink,
          draft.jpTitle || "-",
        ]],
      },
    });

    // 기록된 행 번호 추출 (취소선 처리용)
    const updatedRange = appendRes.data.updates?.updatedRange || "";
    const rowMatch = updatedRange.match(/(\d+)$/);
    const rowIndex = rowMatch ? parseInt(rowMatch[1]) : null;
    console.log("[resupply-sheet] 완료 —", draft.workName, episodeAndFiles, "| row:", rowIndex);
    return rowIndex;
  } catch (e) {
    console.error("[resupply-sheet] 실패:", e.message);
    return null;
  }
}
async function strikethroughResupplyRow(rowIndex) {
  if (!rowIndex) return;
  try {
    const sheets = google.sheets({
      version: "v4",
      auth: getGoogleAuth(["https://www.googleapis.com/auth/spreadsheets"]),
    });
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: RESUPPLY_SHEET_ID,
      requestBody: {
        requests: [{
          repeatCell: {
            range: {
              sheetId: 511152201,
              startRowIndex: rowIndex - 1,
              endRowIndex: rowIndex,
              startColumnIndex: 0,
              endColumnIndex: 8,
            },
            cell: { userEnteredFormat: { textFormat: { strikethrough: true } } },
            fields: "userEnteredFormat.textFormat.strikethrough",
          },
        }],
      },
    });
    console.log("[resupply-sheet] 취소선 처리 완료 — row:", rowIndex);
  } catch (e) {
    console.error("[resupply-sheet] 취소선 실패:", e.message);
  }
}
// resupply-sheet-end

// ── 납품 시트 조회 ────────────────────────────────────────
function parseEpisodeNumbers(ep) {
  if (!ep && ep !== 0) return [];
  const str = String(ep).replace(/話|화|제|\s/g, "");
  const rangeMatch = str.match(/^(\d+)[~\-–](\d+)$/);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1]), end = parseInt(rangeMatch[2]);
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  }
  const single = parseInt(str);
  return isNaN(single) ? [] : [single];
}

async function fetchDeliveryDate(workNameKo, episode, lang = "zh-ja", projectName = null) {
  const sheets  = google.sheets({ version: "v4", auth: getGoogleAuth(["https://www.googleapis.com/auth/spreadsheets.readonly"]) });
  const rawRange = lang === "ko-ja" ? process.env.DELIVERY_SHEET_KO_JA : process.env.DELIVERY_SHEET_ZH_JA;
  const clean   = rawRange.replace(/^'+|'+$/g, "");
  const bangIdx = clean.indexOf("!");
  const range   = bangIdx === -1 ? clean : `'${clean.slice(0, bangIdx)}'${clean.slice(bangIdx)}`;
  const res  = await alertOnError("GoogleSheets(deliveryDate)", () =>
    sheets.spreadsheets.values.get({ spreadsheetId: process.env.DELIVERY_SHEET_ID, range })
  );
  const rows = res.data.values || [];
  const needle      = normalizeTitleKo(workNameKo);
  const episodeNums = parseEpisodeNumbers(episode);
  // projectName(한국어)도 함께 needle로 사용 — ko 필드가 중국어 원제일 수 있음
  const needleAlt = projectName ? normalizeTitleKo(projectName) : null;
  console.log(`[fetchDelivery] workNameKo: "${workNameKo}" | needle: "${needle}" | projectName: "${projectName}" | episode: ${episode} | lang: ${lang} | rows: ${rows.length}`);
  const results = [];
  for (const epNum of episodeNums) {
    const matched = rows.find(row => {
      const bVal = normalizeTitleKo(row[1] || "");
      if (!bVal) return false;
      const matchMain = bVal === needle || bVal.includes(needle) || needle.includes(bVal);
      const matchAlt  = needleAlt && (bVal === needleAlt || bVal.includes(needleAlt) || needleAlt.includes(bVal));
      if (!matchMain && !matchAlt) return false;
      return !isNaN(parseInt(row[4])) && parseInt(row[4]) === epNum;
    });
    if (!matched) {
      const sample = rows.filter(r => r[1]).slice(0, 3).map(r => normalizeTitleKo(r[1]));
      const fuzzy  = rows.filter(r => {
        const v = normalizeTitleKo(r[1] || "");
        return v.includes("똥") || v.includes("검사") || v.includes("살아남");
      }).slice(0, 5).map(r => `"${r[1]}"(E열:${r[4]})`);
      console.log(`[fetchDelivery] ${epNum}화 매칭 실패 — needle: "${needle}" / needleAlt: "${needleAlt}"`);
      console.log(`[fetchDelivery] 시트 앞 샘플:`, sample);
      console.log(`[fetchDelivery] 유사 작품명 검색:`, fuzzy.length ? fuzzy : "없음");
    }
    results.push({ episode: epNum, deliveryDate: matched?.[6] || "확인 불가", workName: matched?.[1] || workNameKo, pm: matched?.[2] || "", apm: matched?.[3] || "" });
  }
  if (!results.length) return null;
  const dates   = results.map(r => r.deliveryDate);
  const allSame = dates.every(d => d === dates[0]);
  const first   = results[0];
  return {
    workName: first.workName, pm: first.pm, apm: first.apm, allSame,
    deliveryDate: allSame ? dates[0] : null,
    episodes: results,
    episodeLabel: allSame
      ? (results.length > 1 ? `${results[0].episode}-${results[results.length-1].episode}화` : `${results[0].episode}화`)
      : results.map(r => r.episode + "화").join(", "),
  };
}

// ── AI 파서 ───────────────────────────────────────────────
async function parseScheduleInquiry(text, msgDate = null) {
  const dateContext = msgDate ? `문의 작성일(KST): ${msgDate}\n` : "";
  const prompt = `${dateContext}아래 문의에서 정보를 추출해줘.
1) work_title_ja: 일본어 작품명. 원문에서 한 글자도 바꾸지 말고 그대로 추출. <>꺾쇠만 제거. (없으면 null)
2) work_title_ko: 한국어 작품명. 원문에서 한 글자도 바꾸지 말고 그대로 추출. <>꺾쇠만 제거. (없으면 null)
3) episode: 회차 표현 그대로 (예: "236-238話"→"236-238", "49화"→"49", 없으면 null)
4) requested_date: 요청 마감 희망일 YYYY-MM-DD. "N월N일까지", "28일까지" 등 달력 날짜 표현이 있으면 문의 작성일 기준으로 YYYY-MM-DD로 변환. (없으면 null)
5) extend_days: 연장 일수 숫자. 아래 중 하나라도 해당되면 숫자로 변환.
   - "N일 연장", "N일 늘려" 등 일수 직접 명시
   - "내일/明日"=1, "모레/明後日"=2, "이틀"=2, "사흘"=3 등 상대적 표현
   - "N일까지" 처럼 날짜가 아닌 일수로 해석 가능한 경우
   판단 불가하면 null
6) worker_type: "번역" | "식자" | "불명"
JSON만 출력. 코드블록 금지.
문의: ${text}`.trim();
  const res = await alertOnError("Gemini(parseSchedule)", () =>
    ai.models.generateContent({ model: GEMINI_MODEL, contents: prompt })
  );
  const parsed = JSON.parse((res.text || "").replace(/```json|```/g, "").trim());
  console.log("[parseSchedule] 파싱 결과:", JSON.stringify(parsed));
  return parsed;
}

async function parseFileInquiry(text) {
  const prompt = `
아래 문의에서 정보를 추출해줘.
1) work_title_ja: 일본어 또는 중국어 작품명. 괄호(「」『』<>《》【】 등) 제거 후 반환 (없으면 null)
2) work_title_ko: 한국어 작품명. 괄호 제거 후 반환 (없으면 null)
3) episode: 회차 숫자만 (예: "49화"→"49", 없으면 null)
4) file_numbers: 파일/페이지 번호 배열 (예: [5,6,7], 없으면 [])
5) reason_raw: 재수급 사유만 1문장. 작품명·회차·파일번호는 절대 포함하지 말 것. (없으면 null)
   - 원문이 일본어 또는 중국어인 경우: 자연스러운 한국어로 번역. 이때 작품명 등 고유명사는 번역하지 말고 완전히 제거할 것
   - 원문이 한국어인 경우: 원문 그대로 반환. 단 작품명이 포함되어 있으면 제거할 것
JSON만 출력. 코드블록 금지.
문의: ${text}`.trim();
  const res = await alertOnError("Gemini(parseFileInquiry)", () =>
    ai.models.generateContent({ model: GEMINI_MODEL, contents: prompt })
  );
  return JSON.parse((res.text || "").replace(/```json|```/g, "").trim());
}

// ── 재수급 reason 조립 ────────────────────────────────────
// matchedTitle: 시트 매칭 결과 { ko, jaDisplay } | null
// fileParsed: parseFileInquiry 결과
function buildFileInquiryReason(fileParsed, matchedTitle) {
  const workName = matchedTitle?.projectName || fileParsed.work_title_ko || fileParsed.work_title_ja || null;
  const episode  = fileParsed.episode ? `${fileParsed.episode}화` : null;
  const rawReason = fileParsed.reason_raw || null;

  // 작품명+화수+사유 조합, 없는 항목은 생략
  const parts = [];
  if (workName) parts.push(workName);
  if (episode)  parts.push(episode);
  const prefix = parts.length ? parts.join(" ") + " " : "";

  return rawReason ? `${prefix}${rawReason}` : (prefix ? `${prefix}원본 재수급 요청` : "원본 재수급 요청");
}

// ── 원본 파일 재수급 UI ───────────────────────────────────
function buildFileInquiryBlocks(draft) {
  const fileNums = draft.fileNumbers?.length ? draft.fileNumbers.join(", ") : "-";
  const apmDisplay = draft.apmUserId
    ? `<@${draft.apmUserId}>`
    : draft.apmName
      ? `${draft.apmName} ⚠️ Slack ID 미매핑`
      : "-";
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: "*📦 원본 재수급 요청 초안*" }},
    { type: "section", text: { type: "mrkdwn", text:
      `*작품명:* ${draft.workName||"-"}\n*회차:* ${draft.episode ? draft.episode+"화" : "-"}\n*납품일:* ${draft.deliveryDate||"-"}\n*파일/페이지 번호:* ${fileNums}\n*재수급 사유:* ${draft.reason||"-"}\n*APM:* ${apmDisplay}` }},
    { type: "context", elements: [
      { type: "mrkdwn", text: "💬 내용 확인이 필요한 문의라면 `문의봇` 이라고 입력해줘." },
    ]},
  ];
  // APM 미매핑 시 직접 입력 안내 추가
  if (!draft.apmUserId) {
    blocks.push({ type: "context", elements: [
      { type: "mrkdwn", text: `⚠️ APM *${draft.apmName || "미확인"}* 의 Slack ID를 찾지 못했어. 수정 버튼에서 직접 입력하거나 담당자를 확인해줘.` },
    ]});
  }
  blocks.push({ type: "actions", block_id: "file_inquiry_actions", elements: [
    { type: "button", action_id: "open_file_inquiry_modal", text: { type: "plain_text", text: "수정" }, style: "primary", value: draft.draftId },
    { type: "button", action_id: "send_file_inquiry_now", text: { type: "plain_text", text: "전송" }, style: "danger", value: draft.draftId,
      confirm: { title: { type: "plain_text", text: "전송할까?" }, text: { type: "mrkdwn", text: "PM 채널에 재수급 요청을 전송해." }, confirm: { type: "plain_text", text: "전송" }, deny: { type: "plain_text", text: "취소" } }},
  ]});
  return blocks;
}

function buildFileInquiryMessage(draft, submitterId) {

  const fileNums = draft.fileNumbers?.length
    ? draft.fileNumbers.join(", ")
    : "-";

  // APM 표시 — apmUserId 있으면 멘션, 없으면 이름 텍스트, 둘 다 없으면 봇 실행자
  const apmText = draft.apmUserId
    ? `<@${draft.apmUserId}>`
    : draft.apmName || `<@${submitterId}>`;

  const meta = JSON.stringify({
    originalChannelId: draft.originalChannelId || null,
    originalTs: draft.originalTs || null,
    // 미매핑 시 null — 완료 처리 시 APM DM 전송 생략
    apmUserId: draft.apmUserId || null,
    workName: draft.workName || "-",
    episode: draft.episode || "-",
    resupplyRowIndex: draft.resupplyRowIndex || null,
  });

  const msgText = [
    `<@${PM_SLACK_ID}>`,
    `안녕하세요.`,
    `아래 작품 원본 파일 재수급을 요청 드립니다.`,
    `- 담당자 : <@${submitterId}>`,
    `- APM : ${apmText}`,
    `- 작품명 : ${draft.workName || "-"}`,
    `- 회차 : ${draft.episode ? draft.episode + "화" : "-"}`,
    `- 파일/페이지 번호 : ${fileNums}`,
    `- 납품일 : ${draft.deliveryDate || "-"}`,
    `- 재수급 사유 : ${draft.reason || "-"}`,
  ].join("\n");

  return {
    text: msgText,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: msgText
        }
      },
      {
        type: "actions",
        block_id: "resupply_actions",
        elements: [
          {
            type: "button",
            action_id: "file_resupply_done",
            text: {
              type: "plain_text",
              text: "✅ 재수급 완료"
            },
            style: "primary",
            value: meta,
            confirm: {
              title: {
                type: "plain_text",
                text: "재수급 완료 처리할까요?"
              },
              text: {
                type: "mrkdwn",
                text: "원문 스레드에 완료 댓글을 달고 담당자를 멘션합니다."
              },
              confirm: {
                type: "plain_text",
                text: "완료 처리"
              },
              deny: {
                type: "plain_text",
                text: "취소"
              }
            }
          }
        ]
      }
    ]
  };
}

app.action("open_file_inquiry_modal", async ({ ack, body, client }) => {
  await ack();
  const draft = draftStore.get(body.actions[0].value);
  if (!draft) return;
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal", callback_id: "submit_file_inquiry_modal",
      private_metadata: JSON.stringify({ draftId: body.actions[0].value }),
      title: { type: "plain_text", text: "재수급 요청 수정" },
      submit: { type: "plain_text", text: "전송" },
      close:  { type: "plain_text", text: "취소" },
      blocks: [
        { type: "input", block_id: "fi_work_block", label: { type: "plain_text", text: "작품명" },
          element: { type: "plain_text_input", action_id: "value", initial_value: draft.workName||"" }},
        { type: "input", block_id: "fi_episode_block", label: { type: "plain_text", text: "회차" },
          element: { type: "plain_text_input", action_id: "value", initial_value: draft.episode ? String(draft.episode) : "" }},
        { type: "input", block_id: "fi_files_block", label: { type: "plain_text", text: "파일/페이지 번호 (쉼표로 구분)" },
          element: { type: "plain_text_input", action_id: "value", initial_value: draft.fileNumbers?.join(", ")||"", placeholder: { type: "plain_text", text: "예: 5, 6, 7" } }},
        { type: "input", block_id: "fi_reason_block", label: { type: "plain_text", text: "재수급 사유" },
          element: { type: "plain_text_input", action_id: "value", initial_value: draft.reason||"", placeholder: { type: "plain_text", text: "예: 파일 손상" } }},
      ],
    },
  });
});

app.view("submit_file_inquiry_modal", async ({ ack, body, view, client }) => {
  await ack();
  const { draftId } = JSON.parse(view.private_metadata || "{}");
  const draft = draftStore.get(draftId);
  if (!draft) return;
  const v = view.state.values;
  draft.workName    = v.fi_work_block?.value?.value?.trim()    || draft.workName;
  draft.episode     = v.fi_episode_block?.value?.value?.trim() || draft.episode;
  draft.fileNumbers = (v.fi_files_block?.value?.value || "").split(",").map(s => s.trim()).filter(Boolean);
  draft.reason      = v.fi_reason_block?.value?.value?.trim()  || draft.reason;
  draftStore.set(draftId, draft);
  const rowIndex = await appendResupplyRecord(draft, body.user.id, client);
  draft.resupplyRowIndex = rowIndex;
  draftStore.set(draftId, draft);
  const msg = buildFileInquiryMessage(draft, body.user.id);
  const pmPost = await client.chat.postMessage({ channel: PM_REQUEST_CHANNEL_ID, ...msg });
  if (draft.sourceLink && draft.sourceLink !== "-") {
    await client.chat.postMessage({ channel: PM_REQUEST_CHANNEL_ID, thread_ts: pmPost.ts, text: `🔗 원본 링크: ${draft.sourceLink}` });
  }
  await client.chat.postMessage({ channel: draft.dmChannelId, text: `✅ <#${PM_REQUEST_CHANNEL_ID}> 채널에 재수급 요청을 전송했어.` });
});

app.action("send_file_inquiry_now", async ({ ack, body, client }) => {
  await ack();
  const draft = draftStore.get(body.actions[0].value);
  if (!draft) return;
  const rowIndex2 = await appendResupplyRecord(draft, body.user.id, client);
  draft.resupplyRowIndex = rowIndex2;
  draftStore.set(body.actions[0].value, draft);
  const msg = buildFileInquiryMessage(draft, body.user.id);
  const pmPost2 = await client.chat.postMessage({ channel: PM_REQUEST_CHANNEL_ID, ...msg });
  if (draft.sourceLink && draft.sourceLink !== "-") {
    await client.chat.postMessage({ channel: PM_REQUEST_CHANNEL_ID, thread_ts: pmPost2.ts, text: `🔗 원본 링크: ${draft.sourceLink}` });
  }
  await client.chat.postMessage({ channel: draft.dmChannelId || body.user.id, text: `✅ <#${PM_REQUEST_CHANNEL_ID}> 채널에 재수급 요청을 전송했어.` });
});

// ── 재수급 완료 버튼 ──────────────────────────────────────
app.action("file_resupply_done", async ({ ack, body, client }) => {
  await ack();
  try {
    const meta = JSON.parse(body.actions[0].value || "{}");
    const { originalChannelId, originalTs, apmUserId, workName, episode } = meta;

    // ① PM 채널 메시지 완료 처리 (버튼 제거 + context 추가)
    await client.chat.update({
      channel: body.channel.id, ts: body.message.ts,
      text: body.message.text,
      blocks: [
        ...body.message.blocks.filter(b => b.type === "section"),
        { type: "context", elements: [
          { type: "mrkdwn", text: `✅ *재수급 완료 처리됨* — <@${body.user.id}> · ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}` },
        ]},
      ],
    });

    // ② PM 채널 메시지 스레드에 APM 멘션 + 작업자 완료 안내 버튼
    if (apmUserId) {
      const workerNotifyMeta = JSON.stringify({
        originalChannelId, originalTs, apmUserId, workName, episode,
      });
      await client.chat.postMessage({
        channel: body.channel.id,
        thread_ts: body.message.ts,
        text: `<@${apmUserId}> 원본 수급이 완료되었습니다. 파일 교체 후 아래 버튼으로 작업자에게 안내해줘.`,
        blocks: [
          { type: "section", text: { type: "mrkdwn",
            text: `<@${apmUserId}> 원본 수급이 완료되었습니다.\n파일 교체 완료 후 아래 버튼으로 작업자에게 안내해줘.` } },
          { type: "actions", elements: [
            { type: "button", action_id: "resupply_notify_worker",
              text: { type: "plain_text", text: "📢 작업자에게 완료 안내" },
              style: "primary", value: workerNotifyMeta },
          ]},
        ],
      });
    }

    // ③ 시트 취소선 처리
    if (meta.resupplyRowIndex) {
      await strikethroughResupplyRow(meta.resupplyRowIndex);
    }
  } catch (e) { console.error("file_resupply_done 오류:", e.message); }
});

// ── 작업자에게 완료 안내 버튼 ─────────────────────────────
app.action("resupply_notify_worker", async ({ ack, body, client }) => {
  await ack();
  try {
    const meta = JSON.parse(body.actions[0].value || "{}");
    const { originalChannelId, originalTs, apmUserId } = meta;

    if (!originalChannelId || !originalTs) {
      await client.chat.postMessage({ channel: body.user.id,
        text: "⚠️ 원본 문의 스레드 정보가 없어. 직접 안내해줘." });
      return;
    }

    // 원본 문의 스레드에 완료 안내 (작업자 멘션)
    let mentionText = "";
    try {
      const msgRes = await client.conversations.history({
        channel: originalChannelId, oldest: originalTs, latest: originalTs, inclusive: true, limit: 1,
      });
      const originalUser = msgRes.messages?.find(m => m.ts === originalTs)?.user || null;
      if (originalUser) mentionText = `<@${originalUser}> `;
    } catch (_) {}

    await client.chat.postMessage({
      channel: originalChannelId,
      thread_ts: originalTs,
      text: `${mentionText}✅ 원본 파일 교체가 완료되었습니다. 확인 부탁드립니다.`,
    });

    // 버튼 메시지 업데이트 (버튼 제거 → 완료 context)
    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: body.message.text,
      blocks: [
        ...body.message.blocks.filter(b => b.type === "section"),
        { type: "context", elements: [
          { type: "mrkdwn", text: `📢 *작업자 안내 완료* — <@${body.user.id}> · ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}` },
        ]},
      ],
    });
  } catch (e) { console.error("resupply_notify_worker 오류:", e.message); }
});


// ── 스케줄 선택지 DM ──────────────────────────────────────
async function sendScheduleChoiceToAPM(client, dmChannelId, info) {
  const { parsed, delivery, sourceLink } = info;
  const requestedDate = parsed.requested_date || `${parsed.extend_days || "?"}일 연장 요청`;
  const workerType    = parsed.worker_type !== "불명" ? parsed.worker_type : "번역/식자 확인 필요";
  const workName      = delivery?.workName || parsed.work_title_ja || parsed.work_title_ko || "-";
  const episodeLabel  = delivery?.episodeLabel || (parsed.episode ? `${parsed.episode}화` : "-");
  let deliveryDateText;
  if (!delivery) deliveryDateText = "확인 불가";
  else if (delivery.allSame) deliveryDateText = delivery.deliveryDate;
  else deliveryDateText = "\n" + delivery.episodes.map(e => `  • ${e.episode}화 : ${e.deliveryDate}`).join("\n");

  const draftId = generateDraftId();
  draftStore.set(draftId, { type: "schedule", parsed, delivery, sourceLink });

  await client.chat.postMessage({
    channel: dmChannelId,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text:
        `*📅 스케줄 조율 문의 접수*\n\n*작품명:* ${workName}\n*회차:* ${episodeLabel}\n*작업 유형:* ${workerType}\n*현재 납품일:* ${deliveryDateText}\n*연장 요청:* ${requestedDate}\n*원문 링크:* ${sourceLink||"-"}\n\nTMS에서 작업 일정 직접 확인해줘.\n_작업자 답변 자동화는 추후 추가 예정_` }},
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: "*PM에게 납품일 변경 요청이 필요한가요?*" }},
      { type: "actions", elements: [
        { type: "button", action_id: "schedule_ask_pm", text: { type: "plain_text", text: "YES — PM에게 요청" }, style: "primary", value: draftId },
        { type: "button", action_id: "schedule_pm_no", text: { type: "plain_text", text: "NO — 직접 처리" }, value: draftId },
      ]},
    ],
    text: "스케줄 조율 문의 — 납품일 확인 후 PM 요청 여부를 선택해줘.",
  });
}

app.action("schedule_ask_pm", async ({ ack, body, client }) => {
  await ack();
  const data = draftStore.get(body.actions[0].value);
  if (!data) return;
  const workName     = data.delivery?.workName     || "-";
  const episodeLabel = data.delivery?.episodeLabel || "-";
  const deliveryDate = data.delivery?.allSame
    ? data.delivery.deliveryDate
    : (data.delivery?.episodes?.map(e => `${e.episode}화: ${e.deliveryDate}`).join(", ") || "-");
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal", callback_id: "schedule_pm_request_modal",
      private_metadata: JSON.stringify({ draftId: body.actions[0].value }),
      title: { type: "plain_text", text: "PM 납품일 변경 요청" },
      submit: { type: "plain_text", text: "PM 채널에 전송" },
      close:  { type: "plain_text", text: "취소" },
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*작품명:* ${workName}　*회차:* ${episodeLabel}\n*기존 납품일:* ${deliveryDate}` }},
        { type: "input", block_id: "desired_date_block", label: { type: "plain_text", text: "희망 납품일" },
          element: { type: "datepicker", action_id: "desired_date_input", placeholder: { type: "plain_text", text: "날짜 선택" } }},
        { type: "input", block_id: "extra_note_block", label: { type: "plain_text", text: "추가 메모 (선택)" }, optional: true,
          element: { type: "plain_text_input", action_id: "extra_note_input", multiline: true, placeholder: { type: "plain_text", text: "전달할 내용이 있으면 입력해줘" } }},
      ],
    },
  });
});

app.view("schedule_pm_request_modal", async ({ ack, body, view, client }) => {
  await ack();
  const { draftId } = JSON.parse(view.private_metadata || "{}");
  const data = draftStore.get(draftId);
  if (!data) { await client.chat.postMessage({ channel: body.user.id, text: "초안 정보를 찾지 못했어. 링크를 다시 보내줘." }); return; }
  const workName     = data.delivery?.workName     || "-";
  const episodeLabel = data.delivery?.episodeLabel || "-";
  const deliveryDate = data.delivery?.allSame ? data.delivery.deliveryDate : (data.delivery?.episodes?.map(e => `${e.episode}화: ${e.deliveryDate}`).join(", ") || "-");
  const desiredDate  = view.state.values.desired_date_block?.desired_date_input?.selected_date || "-";
  const extraNote    = view.state.values.extra_note_block?.extra_note_input?.value?.trim() || "";
  const lines = [
    `<@${PM_SLACK_ID}>`, `안녕하세요.`, `아래 작품 납품일 변경이 가능할지 문의 드립니다.`,
    `- 담당자 : <@${body.user.id}>`, `- 작품명 : ${workName}`, `- 회차 : ${episodeLabel}`,
    `- 기존 납품일 : ${deliveryDate}`, `- 희망 납품일 : ${desiredDate}`,
  ];
  if (extraNote) { lines.push(""); lines.push(extraNote); }
  await client.chat.postMessage({ channel: SCHEDULE_CHANNEL_ID, text: lines.join("\n") });
  await client.chat.postMessage({ channel: body.user.id, text: `🔄 <#${SCHEDULE_CHANNEL_ID}> 채널에 납품일 변경 요청을 전송했어.\n희망 납품일: ${desiredDate}` });
});

app.action("schedule_pm_no", async ({ ack, body, client }) => {
  await ack();
  await client.chat.postMessage({ channel: body.user.id, text: "확인했어. TMS에서 직접 처리해줘." });
});

// ── 스케줄 작품명 직접 입력 ───────────────────────────────
app.action("open_schedule_title_modal", async ({ ack, body, client }) => {
  await ack();
  const pending = draftStore.get(body.actions[0].value);
  if (!pending) return;
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal", callback_id: "schedule_title_modal",
      private_metadata: JSON.stringify({ pendingId: body.actions[0].value }),
      title: { type: "plain_text", text: "작품명 직접 입력" },
      submit: { type: "plain_text", text: "납품일 다시 조회" },
      close:  { type: "plain_text", text: "취소" },
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `AI 추출값: \`${pending.parsed?.work_title_ja || pending.parsed?.work_title_ko || "없음"}\`` }},
        { type: "input", block_id: "title_ja_block", label: { type: "plain_text", text: "작품명 (원문 그대로)" },
          element: { type: "plain_text_input", action_id: "title_ja_input",
            initial_value: pending.parsed?.work_title_ja || pending.parsed?.work_title_ko || "",
            placeholder: { type: "plain_text", text: "예: 本当は転生したくない 또는 미러월드" } }},
      ],
    },
  });
});

app.view("schedule_title_modal", async ({ ack, body, view, client }) => {
  await ack();
  const { pendingId } = JSON.parse(view.private_metadata || "{}");
  const pending = draftStore.get(pendingId);
  if (!pending) return;
  const titleInput   = view.state.values.title_ja_block?.title_ja_input?.value?.trim() || "";
  const matchedTitle = await matchWorkTitleFromSheet(titleInput, titleInput).catch(() => null);
  const workNameKo   = matchedTitle?.projectName || titleInput;
  const delivery     = pending.parsed?.episode
    ? await fetchDeliveryDate(workNameKo, pending.parsed.episode, "zh-ja", matchedTitle?.projectName || null).catch(() => null)
    : null;
  if (delivery) {
    await client.chat.postMessage({ channel: body.user.id, text: `*${delivery.workName} ${delivery.episodeLabel}* 납품일: *${delivery.allSame ? delivery.deliveryDate : delivery.episodes?.map(e=>`${e.episode}화:${e.deliveryDate}`).join(", ")}*` });
  } else {
    await client.chat.postMessage({ channel: body.user.id, text: `납품 시트에서 *${workNameKo}* 를 찾지 못했어. 직접 확인해줘.` });
  }
  await handleScheduleExt(client, body.user.id, { ...pending.parsed, work_title_ko: workNameKo }, matchedTitle, delivery, pending.sourceLink || "");
  draftStore.delete(pendingId);
});

// ── 토큰 매칭 후보 선택 버튼 ─────────────────────────────
app.action(/^schedule_token_pick_\d+$/, async ({ ack, body, client }) => {
  await ack();
  const { pendingId, pivoId, projectName } = JSON.parse(body.actions[0].value || "{}");
  const pending = draftStore.get(pendingId);
  if (!pending) return;

  const rows         = await loadTitleRowsFromSheet();
  const matchedTitle = rows.find(r => r.pivoId === pivoId) || { projectName, pivoId };
  const workNameKo   = matchedTitle.projectName || projectName;
  const delivery     = pending.parsed?.episode
    ? await fetchDeliveryDate(workNameKo, pending.parsed.episode, "zh-ja", workNameKo).catch(() => null)
    : null;

  if (delivery) {
    await client.chat.postMessage({ channel: body.user.id,
      text: `납품 시트 확인 완료 — *${delivery.episodeLabel}* 납품일: *${delivery.allSame ? delivery.deliveryDate : delivery.episodes?.map(e=>`${e.episode}화:${e.deliveryDate}`).join(", ")}*` });
  } else {
    await client.chat.postMessage({ channel: body.user.id, text: `납품 시트에서 *${workNameKo}* 를 찾지 못했어. 직접 확인해줘.` });
  }
  await handleScheduleExt(client, body.user.id, { ...pending.parsed, work_title_ko: workNameKo }, matchedTitle, delivery, pending.sourceLink || "");
  draftStore.delete(pendingId);
});

// ── 드래프트 UI ───────────────────────────────────────────
function generateDraftId() { return `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }
const PRIORITY_EMOJI = { 높음: "🔴", 보통: "🟡", 낮음: "🟢" };

function buildDraftPreviewBlocks(draft) {
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: `*문의 초안*` }},
    { type: "section", text: { type: "mrkdwn", text: `*작품명:* ${draft.workName||"-"}${draft.workNameKo && draft.workNameKo !== draft.workName ? `　(${draft.workNameKo})` : ""}\n*회차:* ${draft.episode ? draft.episode+"화" : "-"}\n*납품일:* ${draft.deliveryDate||"-"}\n*문의 유형:* ${draft.inquiryType||"-"}` }},
  ];

  // 스레드 맥락이 있으면 요약만, 없으면 전체 내용 표시
  if (draft.hasThreadContext) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*요약:*\n${draft.summary||"-"}` }});
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*필요 액션:*\n${draft.actionRequired||"-"}` }});
    blocks.push({ type: "context", elements: [
      { type: "mrkdwn", text: "💬 스레드 전체 맥락을 분석했어. 상세 내용은 원문 링크에서 확인해줘." },
    ]});
  } else {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${draft.sourceLang === "ko" ? "문의 내용" : "번역 내용"}:*\n${draft.inquiryContent||"-"}` }});
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*요약:*\n${draft.summary||"-"}` }});
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*필요 액션:*\n${draft.actionRequired||"-"}` }});
  }

  blocks.push({ type: "section", text: { type: "mrkdwn", text: `*원문 링크:*\n${draft.sourceLink||"-"}` }});

  // 작업 관련 문의일 경우 재수급봇 유도 문구 추가
  if (draft.inquiryType === "작업 관련 문의") {
    blocks.push({ type: "context", elements: [
      { type: "mrkdwn", text: "📦 원본 재수급이 필요하다고 판단되면 `재수급봇` 이라고 입력해줘." },
    ]});
  }

  blocks.push({ type: "actions", block_id: "draft_actions", elements: [
    { type: "button", action_id: "open_inquiry_modal", text: { type: "plain_text", text: "수정" }, style: "primary", value: draft.draftId },
    { type: "button", action_id: "send_inquiry_now", text: { type: "plain_text", text: "바로 전송" }, style: "danger", value: draft.draftId,
      confirm: { title: { type: "plain_text", text: "전송할까?" }, text: { type: "mrkdwn", text: "현재 초안을 지정 채널에 전송해." }, confirm: { type: "plain_text", text: "전송" }, deny: { type: "plain_text", text: "취소" } }},
  ]});

  return blocks;
}

function buildDraftPreviewText(draft) {
  return [`*문의 초안*`, "", `• 작품명: ${draft.workName||"-"}${draft.workNameKo && draft.workNameKo !== draft.workName ? `  (${draft.workNameKo})` : ""}`, `• 회차: ${draft.episode ? draft.episode+"화" : "-"}`, `• 문의 유형: ${draft.inquiryType||"-"}`, `• 요약: ${draft.summary||"-"}`, `• 필요 액션: ${draft.actionRequired||"-"}`, `• 원문 링크: ${draft.sourceLink||"-"}`].join("\n");
}

function buildFinalMainMessage({ submitterId, workName, workNameKo, episode, inquiryType, inquiryContent, actionRequired, draftId }) {
  const mentions = FIXED_MENTION_USER_IDS.map(id => `<@${id}>`).join(" ");
  const fallbackText = `${workName||"-"} | ${inquiryType||"-"} | <@${submitterId}>`;
  const meta = JSON.stringify({ submitterId, draftId: draftId || null });
  return {
    text: fallbackText,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `${mentions}` }},
      { type: "divider" },
      { type: "section", fields: [
        { type: "mrkdwn", text: `*작품명*\n${workName||"-"}` },
        { type: "mrkdwn", text: `*회차*\n${episode ? episode+"화" : "-"}` },
        { type: "mrkdwn", text: `*문의 유형*\n${inquiryType||"-"}` },
        { type: "mrkdwn", text: `*담당자*\n<@${submitterId}>` },
      ]},
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: `*문의 내용*\n${inquiryContent||"-"}` }},
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: `⚡ *필요 액션*\n${actionRequired||"-"}` }},
      { type: "divider" },
      { type: "actions", elements: [
        { type: "button", action_id: "inquiry_done", text: { type: "plain_text", text: "✅ 완료" }, style: "primary", value: meta,
          confirm: { title: { type: "plain_text", text: "완료 처리할까요?" }, text: { type: "mrkdwn", text: "APM에게 답변 작성 버튼이 전달됩니다." }, confirm: { type: "plain_text", text: "완료" }, deny: { type: "plain_text", text: "취소" } }},
      ]},
    ],
  };
}

function buildThreadMessage({ summary, sourceLink }) {
  return `📋 *요약*\n${summary||"-"}\n\n🔗 *원문 링크*\n${sourceLink||"-"}`;
}

async function postInquiryToTargetChannel(client, draft, submitterId) {
  const msg = buildFinalMainMessage({ submitterId, workName: draft.workName, workNameKo: draft.workNameKo, episode: draft.episode, inquiryType: draft.inquiryType, inquiryContent: draft.inquiryContent, actionRequired: draft.actionRequired, draftId: draft.draftId });
  const postRes = await client.chat.postMessage({ channel: TARGET_CHANNEL_ID, ...msg });
  await client.chat.postMessage({ channel: TARGET_CHANNEL_ID, thread_ts: postRes.ts, text: buildThreadMessage({ summary: draft.summary, sourceLink: draft.sourceLink }) });
  await appendInquiryHistory(draft, submitterId);
  return postRes;
}

// ── 복수 문의 요약 메시지 ────────────────────────────────
function buildInquirySummaryMessage(analysis, { icon, label, guide }, titleInfo = {}) {
  const workLine    = titleInfo.workName ? `*작품명:* ${titleInfo.workName}` : null;
  const episodeLine = titleInfo.episode  ? `*회차:* ${titleInfo.episode}화`  : null;
  const infoLines   = [workLine, episodeLine].filter(Boolean);
  return [
    `*${icon} ${label}*`,
    ``,
    ...(infoLines.length ? [...infoLines, ``] : []),
    `*번역 내용:*\n${analysis.translated_ko || "-"}`,
    ``,
    `*요약:* ${analysis.summary_ko || "-"}`,
    `*필요 액션:* ${analysis.action_required || "-"}`,
    ``,
    guide,
    `→ \`재수급봇\` / \`스케줄봇\` / \`문의봇\` / \`파일순서봇\` / \`태스크생성봇\``,
  ].join("\n");
}

function buildMultipleInquirySummary(analysis, titleInfo = {}) {
  return buildInquirySummaryMessage(analysis, {
    icon:  "⚠️",
    label: "복수 문의 감지",
    guide: "복수 문의가 감지됐어. 필요한 봇을 직접 소환해줘.",
  }, titleInfo);
}

function buildOtherInquirySummary(analysis, titleInfo = {}) {
  return buildInquirySummaryMessage(analysis, {
    icon:  "❓",
    label: "유형 미분류 문의",
    guide: "유형을 특정할 수 없어. 필요한 봇을 직접 소환해줘.",
  }, titleInfo);
}

// ── 문의봇 완료 버튼 ─────────────────────────────────────
app.action("inquiry_done", async ({ ack, body, client }) => {
  await ack();
  try {
    const meta = JSON.parse(body.actions[0].value || "{}");
    const { submitterId, draftId } = meta;
    const draft = draftId ? draftStore.get(draftId) : null;

    // PM 채널 메시지 완료 처리 (버튼 제거 + 완료 context 추가)
    await client.chat.update({
      channel: body.channel.id, ts: body.message.ts,
      text: body.message.text,
      blocks: [
        ...body.message.blocks.filter(b => b.type !== "actions"),
        { type: "context", elements: [
          { type: "mrkdwn", text: `✅ *완료 처리됨* — <@${body.user.id}> · ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}` },
        ]},
      ],
    });

    // PM 채널 메시지 스레드에 답변 작성 버튼 댓글 추가
    if (submitterId) {
      const replyMeta = JSON.stringify({
        originalChannelId: draft?.originalChannelId || null,
        originalTs:        draft?.originalTs        || null,
        sourceLink:        draft?.sourceLink        || null,
        submitterId:       submitterId,
      });
      await client.chat.postMessage({
        channel: body.channel.id,
        thread_ts: body.message.ts,
        text: `<@${submitterId}> 답변 작성 버튼입니다.`,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `<@${submitterId}> 원문 스레드에 답변을 남겨줘.` }},
          { type: "actions", elements: [
            { type: "button", action_id: "open_inquiry_reply_modal", text: { type: "plain_text", text: "✏️ 답변 작성" }, style: "primary", value: replyMeta },
          ]},
        ],
      });
    }
  } catch (e) { console.error("inquiry_done 오류:", e.message); }
});

// ── 문의봇 답변 작성 모달 ────────────────────────────────
app.action("open_inquiry_reply_modal", async ({ ack, body, client }) => {
  await ack();
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal", callback_id: "submit_inquiry_reply_modal",
      private_metadata: body.actions[0].value,
      title:  { type: "plain_text", text: "원문 스레드 답변" },
      submit: { type: "plain_text", text: "답변 전송" },
      close:  { type: "plain_text", text: "취소" },
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "원문 스레드에 남길 답변을 작성해줘." }},
        { type: "input", block_id: "reply_block", label: { type: "plain_text", text: "답변 내용" },
          element: { type: "plain_text_input", action_id: "reply_input", multiline: true, placeholder: { type: "plain_text", text: "작업자에게 전달할 내용을 입력해줘." } }},
      ],
    },
  });
});

app.view("submit_inquiry_reply_modal", async ({ ack, body, view, client }) => {
  await ack();
  const meta = JSON.parse(view.private_metadata || "{}");
  const { originalChannelId, originalTs } = meta;
  const replyText = view.state.values.reply_block?.reply_input?.value?.trim() || "";
  if (!replyText) return;

  if (originalChannelId && originalTs) {
    // 원문 작성자 자동 멘션: 부모 메시지 fetch → user 꺼내기
    let mentionPrefix = "";
    try {
      const hist = await client.conversations.history({
        channel: originalChannelId,
        oldest: originalTs,
        latest: originalTs,
        inclusive: true,
        limit: 1,
      });
      const originalUserId = hist.messages?.[0]?.user;
      if (originalUserId) mentionPrefix = `<@${originalUserId}> `;
    } catch (e) {
      console.warn("[reply] 원문 작성자 조회 실패 (멘션 없이 전송):", e.message);
    }

    await client.chat.postMessage({
      channel: originalChannelId,
      thread_ts: originalTs,
      text: `${mentionPrefix}${replyText}`,
    });
    await client.chat.postMessage({ channel: body.user.id, text: "✅ 원문 스레드에 답변을 남겼어." });
  } else {
    await client.chat.postMessage({ channel: body.user.id, text: "⚠️ 원문 스레드 정보를 찾을 수 없어. 직접 답변해줘." });
  }
});

// ── DM 직접 소환: 재수급봇 ────────────────────────────────
app.action("direct_resupply_btn", async ({ ack, body, client }) => {
  await ack();
  let btnData = {};
  try { btnData = JSON.parse(body.actions?.[0]?.value || "{}"); } catch {}
  const preWork    = btnData.workName || "";
  const preEpisode = btnData.episode  || "";
  const sourceLink = btnData.sourceLink || body.actions?.[0]?.value || "";
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal", callback_id: "direct_resupply_modal",
      private_metadata: JSON.stringify({ sourceLink }),
      title:  { type: "plain_text", text: "원본 재수급 요청" },
      submit: { type: "plain_text", text: "초안 생성" },
      close:  { type: "plain_text", text: "취소" },
      blocks: [
        { type: "input", block_id: "dr_work_block", label: { type: "plain_text", text: "작품명" },
          element: { type: "plain_text_input", action_id: "value", ...(preWork ? { initial_value: preWork } : { placeholder: { type: "plain_text", text: "예: 祭品新娘拐恶龙 / 서우전" } }) } },
        { type: "input", block_id: "dr_episode_block", label: { type: "plain_text", text: "회차 (숫자만)" },
          element: { type: "plain_text_input", action_id: "value", ...(preEpisode ? { initial_value: preEpisode } : { placeholder: { type: "plain_text", text: "예: 39" } }) } },
        { type: "input", block_id: "dr_files_block", label: { type: "plain_text", text: "파일/페이지 번호 (쉼표로 구분, 없으면 공백)" }, optional: true,
          element: { type: "plain_text_input", action_id: "value", placeholder: { type: "plain_text", text: "예: 5, 6, 7" } } },
        { type: "input", block_id: "dr_reason_block", label: { type: "plain_text", text: "재수급 사유" }, optional: true,
          element: { type: "plain_text_input", action_id: "value", placeholder: { type: "plain_text", text: "예: 파일 손상" } } },
        { type: "input", block_id: "dr_link_block", label: { type: "plain_text", text: "원문 링크" }, optional: true,
          element: { type: "plain_text_input", action_id: "value", ...(sourceLink ? { initial_value: sourceLink } : { placeholder: { type: "plain_text", text: "https://slack.com/archives/..." } }) } },
      ],
    },
  });
});

app.view("direct_resupply_modal", async ({ ack, body, view, client }) => {
  await ack();
  const { sourceLink: _preLink } = JSON.parse(view.private_metadata || "{}");
  const v        = view.state.values;
  const workName = v.dr_work_block?.value?.value?.trim() || "";
  const episode  = v.dr_episode_block?.value?.value?.trim() || "-";
  const fileNums = (v.dr_files_block?.value?.value || "").split(",").map(s => s.trim()).filter(Boolean);
  const reason   = v.dr_reason_block?.value?.value?.trim() || "원본 재수급 요청";
  const sourceLink = v.dr_link_block?.value?.value?.trim() || _preLink || "";

  const matchedTitle = await matchWorkTitleFromSheet(workName, workName).catch(() => null);
  const workNameKoRes = matchedTitle?.projectName || workName;
  const deliveryQueryName = matchedTitle?.projectName || workName;
  console.log("[resupply-manual] matchedTitle:", JSON.stringify({ ko: matchedTitle?.ko, projectName: matchedTitle?.projectName }), "| episode:", episode);
  const deliveryRes   = deliveryQueryName && episode && episode !== "-"
    ? await fetchDeliveryDate(deliveryQueryName, episode, "zh-ja", matchedTitle?.projectName || null).catch((e) => { console.error("[resupply-manual] fetchDelivery 오류:", e.message); return null; })
    : null;
  console.log("[resupply-manual] deliveryRes:", JSON.stringify(deliveryRes));
  const deliveryDateRes = deliveryRes
    ? (deliveryRes.allSame ? deliveryRes.deliveryDate : deliveryRes.episodes?.map(e=>`${e.episode}화:${e.deliveryDate}`).join(", "))
    : "-";
  const draftId = generateDraftId();
  const draft = {
    draftId, dmChannelId: body.user.id,
    originalChannelId: null, originalTs: null,
    sourceLink: sourceLink || "",
    workName:    workNameKoRes,
    episode,
    fileNumbers: fileNums,
    reason:      reason,
    deliveryDate: deliveryDateRes,

  // ✅ 추가
  apmName: deliveryRes?.apm || null,
  apmUserId: resolveApmUserId(deliveryRes?.apm || null),
};

  draftStore.set(draftId, draft);
  await client.chat.postMessage({ channel: body.user.id, text: "원본 재수급 요청 초안", blocks: buildFileInquiryBlocks(draft) });
});

// ── DM 직접 소환: 스케줄봇 ────────────────────────────────
app.action("direct_schedule_btn", async ({ ack, body, client }) => {
  await ack();
  let btnData = {};
  try { btnData = JSON.parse(body.actions?.[0]?.value || "{}"); } catch {}
  const preWork    = btnData.workName || "";
  const preEpisode = btnData.episode  || "";
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal", callback_id: "direct_schedule_modal",
      title:  { type: "plain_text", text: "스케줄 조회/변경" },
      submit: { type: "plain_text", text: "조회" },
      close:  { type: "plain_text", text: "취소" },
      blocks: [
        { type: "input", block_id: "ds_work_block", label: { type: "plain_text", text: "작품명" },
          element: { type: "plain_text_input", action_id: "value", ...(preWork ? { initial_value: preWork } : { placeholder: { type: "plain_text", text: "예: 本当は転生したくない / 미러월드" } }) } },
        { type: "input", block_id: "ds_episode_block", label: { type: "plain_text", text: "회차 (숫자만, 범위는 예: 236-238)" },
          element: { type: "plain_text_input", action_id: "value", ...(preEpisode ? { initial_value: preEpisode } : { placeholder: { type: "plain_text", text: "예: 49 또는 236-238" } }) } },
        { type: "input", block_id: "ds_extdays_block", label: { type: "plain_text", text: "연장 일수 (숫자만)" },
          element: { type: "plain_text_input", action_id: "value", placeholder: { type: "plain_text", text: "예: 3" } } },
      ],
    },
  });
});

app.view("direct_schedule_modal", async ({ ack, body, view, client }) => {
  await ack();
  const v        = view.state.values;
  const workName = v.ds_work_block?.value?.value?.trim() || "";
  const episode  = v.ds_episode_block?.value?.value?.trim() || "";
  const extDays  = parseInt(v.ds_extdays_block?.value?.value?.trim() || "", 10) || null;

  const matchedTitle = await matchWorkTitleFromSheet(workName, workName).catch(() => null);
  const workNameKo   = matchedTitle?.projectName || workName;
  const delivery     = episode
    ? await fetchDeliveryDate(workNameKo, episode, "zh-ja", matchedTitle?.projectName || null).catch(() => null)
    : null;

  if (delivery) {
    await client.chat.postMessage({ channel: body.user.id,
      text: `납품 시트 확인 완료 — *${delivery.episodeLabel}* 납품일: *${delivery.allSame ? delivery.deliveryDate : delivery.episodes.map(e=>`${e.episode}화:${e.deliveryDate}`).join(", ")}*` });
  } else {
    await client.chat.postMessage({ channel: body.user.id, text: `납품 시트에서 *${workNameKo}* ${episode}화를 찾지 못했어. 직접 확인해줘.` });
  }

  const parsed = {
    work_title_ja: workName, work_title_ko: workNameKo,
    episode,
    worker_type: "불명",
    requested_date: null,
    extend_days: extDays,
    isDirectCall: true,
    originalChannelId: null, originalTs: null,
  };
  await handleScheduleExt(client, body.user.id, parsed, matchedTitle, delivery, "");
});

// ── DM 직접 소환: 문의봇 ──────────────────────────────────
app.action("direct_inquiry_btn", async ({ ack, body, client }) => {
  await ack();
  let btnData = {};
  try { btnData = JSON.parse(body.actions?.[0]?.value || "{}"); } catch {}
  const sourceLink = btnData.sourceLink || body.actions?.[0]?.value || "";
  const preWork    = btnData.workName || "";
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal", callback_id: "direct_inquiry_modal",
      private_metadata: JSON.stringify({ sourceLink }),
      title:  { type: "plain_text", text: "일반 문의 초안 작성" },
      submit: { type: "plain_text", text: "초안 생성" },
      close:  { type: "plain_text", text: "취소" },
      blocks: [
        { type: "input", block_id: "di_work_block", label: { type: "plain_text", text: "작품명 (일본어 또는 한국어)" },
          element: { type: "plain_text_input", action_id: "value", ...(preWork ? { initial_value: preWork } : { placeholder: { type: "plain_text", text: "예: 鬼滅の刃 / 귀멸의 칼날" } }) } },
        { type: "input", block_id: "di_episode_block", label: { type: "plain_text", text: "회차 (숫자만)" }, optional: true,
          element: { type: "plain_text_input", action_id: "value", placeholder: { type: "plain_text", text: "예: 118" } } },
        { type: "input", block_id: "di_type_block", label: { type: "plain_text", text: "문의 유형" },
          element: { type: "static_select", action_id: "value",
            initial_option: { text: { type: "plain_text", text: "기타" }, value: "기타" },
            options: ["스케줄 문의","원본 파일 순서","원본 파일 확인","번역문 누락","번역문 확인","번역문 수정","작업 관련 문의","수정&리테이크","복수 문의","기타"]
              .map(v => ({ text: { type: "plain_text", text: v }, value: v })) } },
        { type: "input", block_id: "di_content_block", label: { type: "plain_text", text: "문의 내용" },
          element: { type: "plain_text_input", action_id: "value", multiline: true, placeholder: { type: "plain_text", text: "문의 내용을 입력해줘" } } },
        { type: "input", block_id: "di_summary_block", label: { type: "plain_text", text: "요약 (없으면 공백)" }, optional: true,
          element: { type: "plain_text_input", action_id: "value", multiline: true } },
        { type: "input", block_id: "di_action_block", label: { type: "plain_text", text: "필요 액션 (없으면 공백)" }, optional: true,
          element: { type: "plain_text_input", action_id: "value" } },
        { type: "input", block_id: "di_link_block", label: { type: "plain_text", text: "원문 링크" }, optional: true,
          element: { type: "plain_text_input", action_id: "value", ...(sourceLink ? { initial_value: sourceLink } : { placeholder: { type: "plain_text", text: "https://slack.com/archives/..." } }) } },
      ],
    },
  });
});

app.view("direct_inquiry_modal", async ({ ack, body, view, client }) => {
  await ack();
  const { sourceLink: _preLink2 } = JSON.parse(view.private_metadata || "{}");
  const v          = view.state.values;
  const workName   = v.di_work_block?.value?.value?.trim() || "";
  const workNameKo = workName; // 단일 필드 — 일본어 또는 한국어 입력값 그대로 사용
  const episode        = v.di_episode_block?.value?.value?.trim() || null;
  const inquiryType    = v.di_type_block?.value?.selected_option?.value || "기타";
  const inquiryContent = v.di_content_block?.value?.value?.trim() || "";
  const summary        = v.di_summary_block?.value?.value?.trim() || "";
  const actionRequired = v.di_action_block?.value?.value?.trim() || "내용 확인 후 회신 필요";
  const sourceLink     = v.di_link_block?.value?.value?.trim() || _preLink2 || "";

  const matchedTitle = await matchWorkTitleFromSheet(workName, workNameKo).catch(() => null);
  const draftId = generateDraftId();
  const draft = {
    draftId, userId: body.user.id, dmChannelId: body.user.id,
    progressMessageTs: null,
    sourceLink: sourceLink || "",
    originalText: "",
    workName:      matchedTitle?.projectName || workName,
    workNameKo:    matchedTitle?.ko || workNameKo,
    pivoId:        matchedTitle?.pivoId || null,
    episode:       episode || null,
    inquiryType, inquiryContent, summary, actionRequired, sourceLang: "ko",
    deliveryDate:  episode && matchedTitle?.projectName
      ? await fetchDeliveryDate(matchedTitle.projectName, episode, "zh-ja", matchedTitle.projectName).catch(() => null).then(d => d ? (d.allSame ? d.deliveryDate : d.episodes?.map(e=>`${e.episode}화:${e.deliveryDate}`).join(", ")) : "-")
      : "-",
  };
  draftStore.set(draftId, draft);
  await client.chat.postMessage({ channel: body.user.id, text: buildDraftPreviewText(draft), blocks: buildDraftPreviewBlocks(draft) });
});

// ── DM 직접 소환: 파일순서봇 ─────────────────────────────
app.action("direct_fileorder_btn", async ({ ack, body, client }) => {
  await ack();
  let btnData = {};
  try { btnData = JSON.parse(body.actions?.[0]?.value || "{}"); } catch {}
  const preWork    = btnData.workName || "";
  const preEpisode = btnData.episode  || "";
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal", callback_id: "direct_fileorder_modal",
      private_metadata: JSON.stringify({ dmChannelId: body.user.id }),
      title:  { type: "plain_text", text: "파일 순서 수정" },
      submit: { type: "plain_text", text: "확인" },
      close:  { type: "plain_text", text: "취소" },
      blocks: [
        { type: "input", block_id: "dfo_work_block", label: { type: "plain_text", text: "작품명" },
          element: { type: "plain_text_input", action_id: "value", ...(preWork ? { initial_value: preWork } : { placeholder: { type: "plain_text", text: "예: 祭品新娘拐恶龙 / ゾンビさん" } }) } },
        { type: "input", block_id: "dfo_episode_block", label: { type: "plain_text", text: "화수 (숫자만)" },
          element: { type: "plain_text_input", action_id: "value", ...(preEpisode ? { initial_value: preEpisode } : { placeholder: { type: "plain_text", text: "예: 60" } }) } },
      ],
    },
  });
});

app.view("direct_fileorder_modal", async ({ ack, body, view, client }) => {
  await ack();
  const { dmChannelId } = JSON.parse(view.private_metadata || "{}");
  const v        = view.state.values;
  const workName = v.dfo_work_block?.value?.value?.trim() || "";
  const episode  = v.dfo_episode_block?.value?.value?.trim() || "";
  const dmTarget = dmChannelId || body.user.id;

  if (!workName || !episode) {
    await client.chat.postMessage({ channel: dmTarget, text: "작품명과 화수를 모두 입력해줘." });
    return;
  }

  const matchedTitle       = await matchWorkTitleFromSheet(workName, workName).catch(() => null);
  const resolvedWorkNameKo = matchedTitle?.projectName || workName;

  await handleFileOrderInquiry(
    client, dmTarget,
    { title_ja: workName, title_ko: resolvedWorkNameKo, episode },
    { url: "", channelId: null, ts: null, requesterUserId: null },
    workName,
  );
});

// ── 원본 파일 순서 플로우 등록 ────────────────────────────
const { handleFileOrderInquiry } = require("./fileOrderFlow")(app, {
  ai, GEMINI_MODEL, matchWorkTitleFromSheet, matchWorkTitleByTokens, matchWorkTitleWithCandidates, generateDraftId, draftStore,
});

const { handleRetakeInquiry } = require("./retakeFlow")(app, {
  ai, GEMINI_MODEL, matchWorkTitleFromSheet, matchWorkTitleByTokens, matchWorkTitleWithCandidates, generateDraftId, draftStore, google, getGoogleAuth,
});

const { handleScheduleExt, handleScheduleExtGrouped } = require("./scheduleExtFlow")(app, {
  ai, GEMINI_MODEL, matchWorkTitleFromSheet, generateDraftId, draftStore,
  google, getGoogleAuth, fetchDeliveryDate,
});

const { handleMultipleInquiry } = require("./multipleInquiryFlow")(app, {
  ai, GEMINI_MODEL,
  matchWorkTitleFromSheet, matchWorkTitleByTokens,
  generateDraftId, draftStore, fetchDeliveryDate,
  handleFileOrderInquiry, handleRetakeInquiry, handleScheduleExt, handleScheduleExtGrouped,
});

const { handleWorkerRelay } = require("./workerRelayFlow")(app, {
  ai, GEMINI_MODEL,
  matchWorkTitleFromSheet, generateDraftId, draftStore, google, getGoogleAuth,
});

// ── 이모지 반응 트리거 ────────────────────────────────────
app.event("reaction_added", async ({ event, client }) => {
  try {
    const emoji = event.reaction;
    if (emoji !== "문의봇소환") return;

    const channelId = event.item.channel;
    const ts        = event.item.ts;
    const userId    = event.user;

    // ── APM 권한 체크 ──────────────────────────────────────
    const ALLOWED_APM_USERS = new Set([
      "UBRE3KL5A",    // APM 1
      "U01GN9Q3WPK",  // APM 2
      "U05CE8HFA6B",  // 정태영 (John)
      "U02BTD7TY48",  // APM 4
      "U07G8KC2EE6",  // APM 5
      "U075B3S7VPD",  // APM 6
      "U02GPTNGZ5W",  // APM 7
      "U07E0QPL8MV",  // APM 8
      "U04463JR4HH",  // APM 9
      "U06MUFY0JH3",  // APM 10
    ]);

    if (!ALLOWED_APM_USERS.has(userId)) {
      // 권한 없는 사용자가 소환 시 → ephemeral 메시지 (본인만 보임)
      try {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: "⚠️ 문의봇은 APM만 사용할 수 있습니다. 문의사항은 담당 APM에게 연락해주세요."
        });
      } catch (_) {}
      return;
    }
    // ────────────────────────────────────────────────────────

    // 채널 히스토리에서 먼저 조회 (최상위 메시지)
    let targetMsg = null;
    try {
      const res = await client.conversations.history({ channel: channelId, oldest: ts, latest: ts, inclusive: true, limit: 1 });
      targetMsg = res.messages?.[0]?.ts === ts ? res.messages[0] : null;
    } catch (_) {}

    // 못 찾으면 스레드 댓글로 간주 → replies API로 조회
    if (!targetMsg) {
      try {
        // thread_ts를 모르므로 채널에서 ts 근처 메시지의 thread_ts를 추정
        // Slack event.item에 thread_ts가 있으면 사용, 없으면 ts 자체를 thread_ts로 시도
        const threadTs = event.item.thread_ts || ts;
        const replyRes = await client.conversations.replies({ channel: channelId, ts: threadTs, oldest: ts, inclusive: true, limit: 20 });
        targetMsg = replyRes.messages?.find(m => m.ts === ts) || null;
      } catch (_) {}
    }
    if (!targetMsg) return;

    // ── 스레드 전체 맥락 조회 ─────────────────────────────
    // event.item.thread_ts가 없어도 targetMsg.thread_ts로 스레드 여부 확인
    const threadTs = targetMsg.thread_ts || event.item.thread_ts || null;
    const threadMessages = await fetchThreadContext(client, channelId, ts, threadTs);
    const hasThreadContext = threadMessages.length > 1;
    const threadContextText = hasThreadContext ? buildThreadContextText(threadMessages) : "";
    
    console.log(`[thread-context] 소환 위치: ${threadTs ? '스레드 댓글' : '단일 메시지'} | 맥락 메시지: ${threadMessages.length}개 | targetMsg.thread_ts: ${targetMsg.thread_ts || 'null'}`);

    const originalText = cleanSlackText(targetMsg.text || "");
    if (!originalText) return;

    const dmRes     = await client.conversations.open({ users: userId });
    const dmChannel = dmRes.channel.id;
    const permalink = `https://slack.com/archives/${channelId}/p${ts.replace(".", "")}`;

// ── 문의봇소환 ────────────────────────────────────────
if (emoji === "문의봇소환") {
  const progressMsg = await client.chat.postMessage({ channel: dmChannel, text: buildProgressText(0, "요청을 받았어.") });
  await withTimeout(async () => {

  // 내부 수정 채널에서 소환 시 → 리테이크 플로우
  const RETAKE_CHANNELS = new Set(["C09B8QLR5FG", "C0ARUR4MHHN"]);
  if (RETAKE_CHANNELS.has(channelId)) {
    await client.chat.update({ channel: dmChannel, ts: progressMsg.ts, text: "🔄 내부 수정 채널 감지 — 태스크생성봇으로 처리 중..." });
    let requesterName = targetMsg.user || "";
    try {
      const userInfo = await client.users.info({ user: targetMsg.user });
      requesterName = userInfo.user?.profile?.display_name || userInfo.user?.real_name || requesterName;
    } catch (_) {}
    
    // 스레드 맥락이 있으면 AI 분석하여 작품명/회차 추출
    let analysis = { title_ja: null, title_ko: null, episode: null };
    if (hasThreadContext) {
      const contextAnalysis = await analyzeInquiryWithAI(threadContextText, true);
      analysis = {
        title_ja: contextAnalysis.title_ja || null,
        title_ko: contextAnalysis.title_ko || null,
        episode: contextAnalysis.episode || null
      };
      console.log(`[retake-context] 스레드에서 추출 — title_ja: ${analysis.title_ja} | title_ko: ${analysis.title_ko} | episode: ${analysis.episode}`);
    }
    
    // 복수 항목 감지: 대괄호 작품명 또는 글머리기호(* ・ •)가 2개 이상 별도 줄에 있으면 복수
    const lines = originalText.split("\n").map(l => l.trim()).filter(l => l);
    const itemLines = lines.filter(l => /^\[.+\]|^\*\s|^・|^•/.test(l));
    if (itemLines.length >= 2) {
      await handleMultipleInquiry(client, dmChannel, originalText, permalink, channelId, ts, requesterName, null, "리테이크", targetMsg.user || null);
    } else {
      await handleRetakeInquiry(client, dmChannel, analysis, { url: permalink }, originalText, requesterName);
    }
    return;
  }

  // ── AI 분석 (스레드 맥락 활용) ─────────────────────────
  const analysisText = hasThreadContext ? threadContextText : originalText;
  const analysis = await analyzeInquiryWithAI(analysisText, hasThreadContext);
  console.log(`[DEBUG] reaction inquiry_type: ${analysis.inquiry_type} | title_ja: ${analysis.title_ja} | title_ko: ${analysis.title_ko} | 스레드맥락: ${hasThreadContext ? 'O' : 'X'}`);

      if (analysis.inquiry_type === "스케줄 문의") {
        let parsed, matchedTitle, workNameKo, delivery;
        try {
          const msgDateEmoji = new Date(parseInt(targetMsg.ts.split('.')[0]) * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 10);
          parsed = await parseScheduleInquiry(originalText, msgDateEmoji);

          // 후보 감지 매칭 (부분일치 복수 체크 포함)
          const candResult = await matchWorkTitleWithCandidates(parsed.work_title_ja, parsed.work_title_ko).catch(() => null);
          if (candResult?.single) {
            matchedTitle = candResult.single;
          } else if (candResult?.multiple) {
            const pendingId = `sched_pending_${Date.now()}`;
            draftStore.set(pendingId, { type: "schedule_pending", parsed, sourceLink: permalink, originalText });
            await client.chat.update({ channel: dmChannel, ts: progressMsg.ts,
              text: `작품명 *${parsed.work_title_ko || parsed.work_title_ja || "-"}* 후보가 여러 개야. 선택해줘.` });
            await client.chat.postMessage({ channel: dmChannel, text: "작품을 선택해줘.",
              blocks: [
                { type: "section", text: { type: "mrkdwn", text: `*작품 후보 ${candResult.multiple.length}건* — 해당하는 작품을 선택해줘.` }},
                { type: "actions", elements: candResult.multiple.map((r, i) => ({
                  type: "button", action_id: `schedule_token_pick_${i}`,
                  text: { type: "plain_text", text: r.projectName || r.jaDisplay || `후보 ${i+1}` },
                  value: JSON.stringify({ pendingId, pivoId: r.pivoId, projectName: r.projectName }),
                }))},
              ],
            });
            return;
          } else if (candResult?.tooMany) {
            // 후보 너무 많음 → 직접 입력 유도
            const pendingId = `sched_pending_${Date.now()}`;
            draftStore.set(pendingId, { type: "schedule_pending", parsed, sourceLink: permalink, originalText });
            await client.chat.update({ channel: dmChannel, ts: progressMsg.ts,
              text: `*${parsed.work_title_ko || parsed.work_title_ja || "-"}* 와 일치하는 작품이 너무 많아. 더 정확한 작품명을 입력해줘.` });
            await client.chat.postMessage({ channel: dmChannel, text: "작품명을 직접 입력해줘.",
              blocks: [
                { type: "section", text: { type: "mrkdwn", text: `AI 추출 작품명: \`${parsed.work_title_ja || parsed.work_title_ko || "없음"}\`` }},
                { type: "actions", elements: [{ type: "button", action_id: "open_schedule_title_modal", text: { type: "plain_text", text: "작품명 직접 입력" }, style: "primary", value: pendingId }]},
              ],
            });
            return;
          } else {
            // null → 토큰 매칭 시도
            const tokenResult = await matchWorkTitleByTokens(parsed.work_title_ko, parsed.work_title_ja).catch(() => null);
            if (tokenResult?.single) {
              matchedTitle = tokenResult.single;
              console.log("[match-token] 단건 자동 선택:", matchedTitle.projectName);
            } else if (tokenResult?.multiple) {
              const pendingId = `sched_pending_${Date.now()}`;
              draftStore.set(pendingId, { type: "schedule_pending", parsed, sourceLink: permalink, originalText });
              await client.chat.update({ channel: dmChannel, ts: progressMsg.ts,
                text: `작품명 *${parsed.work_title_ko || parsed.work_title_ja || "-"}* 후보가 여러 개야. 선택해줘.` });
              await client.chat.postMessage({ channel: dmChannel, text: "작품을 선택해줘.",
                blocks: [
                  { type: "section", text: { type: "mrkdwn", text: `*작품 후보 ${tokenResult.multiple.length}건* — 해당하는 작품을 선택해줘.` }},
                  { type: "actions", elements: tokenResult.multiple.slice(0, 5).map((r, i) => ({
                    type: "button", action_id: `schedule_token_pick_${i}`,
                    text: { type: "plain_text", text: r.projectName || r.jaDisplay || `후보 ${i+1}` },
                    value: JSON.stringify({ pendingId, pivoId: r.pivoId, projectName: r.projectName }),
                  }))},
                ],
              });
              return;
            }
          }

          workNameKo = matchedTitle?.projectName || null;
          delivery   = parsed.episode
            ? await fetchDeliveryDate(workNameKo, parsed.episode, "zh-ja", matchedTitle?.projectName || null).catch(() => null)
            : null;
        } catch (e) {
          await client.chat.update({ channel: dmChannel, ts: progressMsg.ts, text: `오류: ${e.message}` }); return;
        }
        parsed.originalChannelId = channelId;
        parsed.requesterUserId   = targetMsg.user || null;
        parsed.originalTs        = ts;
        await client.chat.update({ channel: dmChannel, ts: progressMsg.ts,
          text: delivery ? `납품 시트 확인 완료 — ${delivery.episodeLabel} 납품일: ${delivery.allSame ? delivery.deliveryDate : "회차별 상이"}` : "납품 시트에서 찾지 못했어. 직접 확인해줘." });
        await handleScheduleExt(client, dmChannel, parsed, matchedTitle, delivery, permalink);
        return;
      }

      if (analysis.inquiry_type === "복수 문의") {
        await client.chat.update({ channel: dmChannel, ts: progressMsg.ts, text: "📋 복수 문의 감지 — 항목별로 분석 중..." });
        let reqName = targetMsg.user || "";
        try {
          const ui = await client.users.info({ user: targetMsg.user });
          reqName = ui.user?.profile?.display_name || ui.user?.real_name || reqName;
        } catch (_) {}
        await handleMultipleInquiry(client, dmChannel, originalText, permalink, channelId, ts, reqName, analysis.multi_items || null, null, targetMsg.user || null);
        return;
      }

      if (analysis.inquiry_type === "기타") {
        const matchedForSummary = await matchWorkTitleFromSheet(analysis.title_ja, analysis.title_ko).catch(() => null);
        const displayName = matchedForSummary?.projectName || analysis.title_ja || analysis.title_ko || "";
        const titleInfo = { workName: displayName, episode: analysis.episode || "" };
        const btnValue  = JSON.stringify({ sourceLink: permalink, workName: displayName, episode: titleInfo.episode });
        await client.chat.update({ channel: dmChannel, ts: progressMsg.ts, text: buildOtherInquirySummary(analysis, titleInfo) });
        await client.chat.postMessage({ channel: dmChannel,
          text: "필요한 봇을 선택해줘.",
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: "필요한 봇을 선택해줘." }},
            { type: "actions", elements: [
              { type: "button", action_id: "direct_inquiry_btn",   text: { type: "plain_text", text: "문의봇" },    value: btnValue },
              { type: "button", action_id: "direct_resupply_btn",  text: { type: "plain_text", text: "재수급봇" },  value: btnValue },
              { type: "button", action_id: "direct_schedule_btn",  text: { type: "plain_text", text: "스케줄봇" },  value: btnValue },
              { type: "button", action_id: "direct_fileorder_btn", text: { type: "plain_text", text: "파일순서봇" }, value: btnValue },
              { type: "button", action_id: "direct_retake_btn",    text: { type: "plain_text", text: "태스크생성봇" }, value: btnValue },
            ]},
          ],
        });
        return;
      }

      if (["번역문 누락", "번역문 확인", "번역문 수정"].includes(analysis.inquiry_type)) {
        await client.chat.update({ channel: dmChannel, ts: progressMsg.ts, text: "📨 작업자 릴레이 처리 중..." });
        const relayImageUrls = (targetMsg.files || [])
          .filter(f => f.mimetype?.startsWith("image/"))
          .map(f => f.url_private || f.permalink || null)
          .filter(Boolean);
        // 스레드 맥락이 있으면 전체 텍스트를, 없으면 단일 메시지를 전달
        const relayText = hasThreadContext ? threadContextText : originalText;
        await handleWorkerRelay(client, dmChannel, analysis, { url: permalink, channelId, ts }, relayText, targetMsg.user || null, relayImageUrls);
        return;
      }

      if (analysis.inquiry_type === "수정&리테이크") {
        await client.chat.update({ channel: dmChannel, ts: progressMsg.ts, text: "🔄 수정·리테이크 요청 처리 중..." });
        // 문의 작성자 이름 조회
        let requesterName = targetMsg.user || "";
        try {
          const userInfo = await client.users.info({ user: targetMsg.user });
          requesterName = userInfo.user?.profile?.display_name || userInfo.user?.real_name || targetMsg.user || "";
        } catch (_) {}
        await handleRetakeInquiry(client, dmChannel, analysis, { url: permalink }, originalText, requesterName);
        return;
      }

      if (analysis.inquiry_type === "원본 파일 순서") {
        await client.chat.update({ channel: dmChannel, ts: progressMsg.ts, text: "📁 파일 순서 문의 처리 중..." });
        await handleFileOrderInquiry(client, dmChannel, analysis, { url: permalink, channelId, ts, requesterUserId: targetMsg.user || null }, originalText);
        return;
      }

      if (analysis.inquiry_type === "원본 파일 확인") {
        let fileParsed;
        try { fileParsed = await parseFileInquiry(originalText); } catch (e) { fileParsed = {}; }
        const matchedTitle = await matchWorkTitleFromSheet(fileParsed.work_title_ja || analysis.title_ja, fileParsed.work_title_ko || analysis.title_ko).catch(() => null);

        // 매칭 실패 시 수동 입력 유도
        if (!matchedTitle) {
          const pendingId = `fi_pending_${Date.now()}`;
          draftStore.set(pendingId, {
            type: "file_inquiry_pending",
            workName:    fileParsed.work_title_ko || fileParsed.work_title_ja || "",
            episode:     fileParsed.episode || "",
            fileNumbers: fileParsed.file_numbers || [],
            reason:      fileParsed.reason_raw || "",
            sourceLink:  permalink,
            dmChannelId: dmChannel,
            originalChannelId: channelId,
            originalTs:  ts,
          });
          await client.chat.update({ channel: dmChannel, ts: progressMsg.ts,
            text: `시트에서 *${fileParsed.work_title_ko || fileParsed.work_title_ja || "작품명"}* 을 찾지 못했어.` });
          await client.chat.postMessage({ channel: dmChannel, text: "작품명을 직접 입력해줘.",
            blocks: [
              { type: "section", text: { type: "mrkdwn",
                text: `*📦 원본 재수급 요청*
⚠️ 작품명을 시트에서 찾지 못했어.
AI 추출값: \`${fileParsed.work_title_ko || fileParsed.work_title_ja || "없음"}\`` }},
              { type: "actions", elements: [
                { type: "button", action_id: "open_file_inquiry_modal",
                  text: { type: "plain_text", text: "정보 직접 입력" },
                  style: "primary", value: pendingId },
              ]},
            ],
          });
          return;
        }

        // 납품일 조회
        const workNameKo = matchedTitle.projectName || matchedTitle.ko;
        const episode = fileParsed.episode || null;
        let deliveryDate = "-";
        if (workNameKo && episode) {
          try {
            const delivery = await fetchDeliveryDate(workNameKo, episode, "zh-ja", matchedTitle.projectName || null);
            deliveryDate = delivery?.allSame ? delivery.deliveryDate : "-";
          } catch (e) {
            console.error("[file-inquiry] 납품일 조회 실패:", e.message);
          }
        }

        const draftId = generateDraftId();
        const draft = {
          draftId, dmChannelId: dmChannel,
          originalChannelId: channelId, originalTs: ts,
          workName:    matchedTitle.projectName || matchedTitle.ko || fileParsed.work_title_ko || fileParsed.work_title_ja || "-",
          jpTitle:     matchedTitle.jpTitle || "-",
          pivoId:      matchedTitle.pivoId || null,
          episode:     fileParsed.episode || "-",
          deliveryDate, // 납품일 추가
          fileNumbers: fileParsed.file_numbers || [],
          reason:      buildFileInquiryReason(fileParsed, matchedTitle),
          sourceLink:  permalink,
        };
        draftStore.set(draftId, draft);
        await client.chat.update({ channel: dmChannel, ts: progressMsg.ts, text: "원본 파일 재수급 요청 초안을 만들었어." });
        await client.chat.postMessage({ channel: dmChannel, text: "원본 재수급 요청 초안", blocks: buildFileInquiryBlocks(draft) });
        return;
      }

      let matchedTitle = null;
      if (analysis.title_ja || analysis.title_ko) {
        const candResult = await matchWorkTitleWithCandidates(analysis.title_ja, analysis.title_ko).catch(() => null);
        if (candResult?.single) {
          matchedTitle = candResult.single;
        } else if (candResult?.multiple || candResult?.tooMany) {
          const pendingId = `pending_${Date.now()}`;
          draftStore.set(pendingId, { isPending: true, userId, dmChannelId: dmChannel, progressTs: progressMsg.ts, sourceLink: permalink, originalText, titleJa: analysis.title_ja, inquiryType: analysis.inquiry_type, inquiryContent: analysis.translated_ko, summary: analysis.summary_ko, actionRequired: analysis.action_required, priority: analysis.priority, sourceLang: analysis.source_lang });
          if (candResult?.multiple) {
            await client.chat.update({ channel: dmChannel, ts: progressMsg.ts,
              text: `작품명 *${analysis.title_ko || analysis.title_ja || "-"}* 후보가 여러 개야. 선택해줘.` });
            await client.chat.postMessage({ channel: dmChannel, text: "작품을 선택해줘.",
              blocks: [
                { type: "section", text: { type: "mrkdwn", text: `*작품 후보 ${candResult.multiple.length}건* — 해당하는 작품을 선택해줘.` }},
                { type: "actions", elements: candResult.multiple.map((r, i) => ({
                  type: "button", action_id: `inquiry_cand_pick_${i}`,
                  text: { type: "plain_text", text: r.projectName || r.jaDisplay || `후보 ${i+1}` },
                  value: JSON.stringify({ pendingId, pivoId: r.pivoId, projectName: r.projectName }),
                }))},
              ],
            });
          } else {
            await client.chat.update({ channel: dmChannel, ts: progressMsg.ts,
              text: `*${analysis.title_ko || analysis.title_ja || "-"}* 와 일치하는 작품이 너무 많아. 더 정확한 작품명을 입력해줘.` });
            await client.chat.postMessage({ channel: dmChannel, text: "작품명을 직접 입력해줘.",
              blocks: [
                { type: "section", text: { type: "mrkdwn", text: `AI 추출 작품명: \`${analysis.title_ja || analysis.title_ko || "없음"}\`` }},
                { type: "actions", elements: [{ type: "button", action_id: "open_manual_title_modal", text: { type: "plain_text", text: "작품명 직접 입력" }, style: "primary", value: pendingId }]},
              ],
            });
          }
          return;
        }
      }
      await client.chat.update({ channel: dmChannel, ts: progressMsg.ts, text: buildProgressText(4, "시트 매칭 완료") });

      if (!matchedTitle) {
        const pendingId = `pending_${Date.now()}`;
        draftStore.set(pendingId, { isPending: true, userId, dmChannelId: dmChannel, progressTs: progressMsg.ts, sourceLink: permalink, originalText, titleJa: analysis.title_ja, inquiryType: analysis.inquiry_type, inquiryContent: analysis.translated_ko, summary: analysis.summary_ko, actionRequired: analysis.action_required, priority: analysis.priority, sourceLang: analysis.source_lang });
        await client.chat.update({ channel: dmChannel, ts: progressMsg.ts, text: `시트에서 *${analysis.title_ja || analysis.title_ko || "작품명"}* 을 찾지 못했어.` });
        await client.chat.postMessage({ channel: dmChannel, text: "작품명을 직접 입력해줘.",
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: `AI 추출 작품명: \`${analysis.title_ja || analysis.title_ko || "없음"}\`` }},
            { type: "actions", elements: [{ type: "button", action_id: "open_manual_title_modal", text: { type: "plain_text", text: "작품명 직접 입력" }, style: "primary", value: pendingId }]},
          ],
        });
        return;
      }

      const draftId = generateDraftId();
      const draft = {
        draftId, userId, dmChannelId: dmChannel, progressMessageTs: progressMsg.ts,
        sourceLink: permalink, originalText,
        originalChannelId: channelId, originalTs: ts,
        workName:      matchedTitle.projectName || matchedTitle.ko || analysis.title_ko || analysis.title_ja || "",
        workNameKo:    matchedTitle.ko || "",
        pivoId:        matchedTitle.pivoId || null,
        episode:       analysis.episode || null,
        inquiryType:   analysis.inquiry_type   || "기타",
        inquiryContent:analysis.translated_ko  || "",
        summary:       analysis.summary_ko     || "",
        actionRequired:analysis.action_required|| "",
        sourceLang:    analysis.source_lang    || "ja",
        hasThreadContext, // 스레드 맥락 여부 플래그
      };
      draftStore.set(draftId, draft);
      await client.chat.update({
        channel: dmChannel,
        ts: progressMsg.ts,
        text: buildDraftPreviewText(draft),
        blocks: buildDraftPreviewBlocks(draft)
      });
  }, { dmChannel, client, label: "이모지 소환" });

  // withTimeout 정상 완료 → 원본 메시지에 대응완료 이모지 부착 (같은 스레드 재소환 시 재분석 방지)
  await markInquiryProcessed(client, channelId, ts);

  } // ✅ 이 줄 추가: if (emoji === "문의봇소환") 닫기

  } catch (error) {
    console.error("reaction_added 오류:", error.message);
  }
});
// ── 메인 이벤트: DM으로 링크 수신 ────────────────────────
app.message(async ({ message, say, client }) => {
  try {
    if (message.subtype || message.bot_id) return;
    if (message.channel_type !== "im") return;
    const key = message.channel + ":" + message.ts;
    if (processedMessageTs.has(key)) return;
    processedMessageTs.add(key);
    if (processedMessageTs.size > 1000) processedMessageTs.clear();

    const progressMsg = await say(buildProgressText(0, "요청을 받았어."));
    const userText    = cleanSlackText(message.text || "");
    const linkInfo    = extractSlackPermalink(userText);

    // ── DM 직접 소환 키워드 감지 ──────────────────────────
    if (!linkInfo) {
const BOT_KEYWORDS = {
  재수급봇:   { label: "원본 재수급 요청",   action: "direct_resupply_btn" },
  스케줄봇:   { label: "스케줄 조회/변경",   action: "direct_schedule_btn" },
  문의봇:     { label: "일반 문의 초안 작성", action: "direct_inquiry_btn" },
  파일순서봇: { label: "파일 순서 수정",      action: "direct_fileorder_btn" },
  태스크생성봇: { label: "태스크 재생성",      action: "direct_retake_btn" },
};
      const matched = Object.entries(BOT_KEYWORDS).find(([kw]) => userText.includes(kw));
      if (matched) {
        const [kw, { label, action }] = matched;
        await app.client.chat.update({ channel: message.channel, ts: progressMsg.ts,
          text: `${kw} 소환됐어. 아래 버튼을 눌러서 정보를 입력해줘.`,
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: `*${kw}* 소환됐어. 버튼을 눌러서 ${label} 정보를 입력해줘.` }},
            { type: "actions", elements: [
              { type: "button", action_id: action, text: { type: "plain_text", text: `${label} 입력하기` }, style: "primary", value: "direct" },
            ]},
          ],
        });
        return;
      }
      await app.client.chat.update({ channel: message.channel, ts: progressMsg.ts, text: "Slack 메시지 링크를 보내줘.\n봇을 직접 소환하려면: `재수급봇` / `스케줄봇` / `문의봇` / `파일순서봇` / `태스크생성봇` 을 입력해줘." });
      return;
    }
    await updateProgress(message.channel, progressMsg.ts, 1, "링크 확인 완료");
    await withTimeout(async () => {

    const linkedMessage = await fetchSingleLinkedMessage(client, linkInfo.channelId, linkInfo.ts);
    if (!linkedMessage) { await app.client.chat.update({ channel: message.channel, ts: progressMsg.ts, text: "링크된 메시지를 찾을 수 없어." }); return; }
    await updateProgress(message.channel, progressMsg.ts, 2, "원문 메시지 조회 완료");

    const originalText = cleanSlackText(linkedMessage.text || "");
    if (!originalText) { await app.client.chat.update({ channel: message.channel, ts: progressMsg.ts, text: "메시지 내용이 비어 있어." }); return; }

    const analysis = await analyzeInquiryWithAI(originalText);
    await updateProgress(message.channel, progressMsg.ts, 3, "AI 분석 완료");
    console.log("[DEBUG] inquiry_type:", analysis.inquiry_type, "| title_ja:", analysis.title_ja, "| title_ko:", analysis.title_ko);

    if (analysis.inquiry_type === "스케줄 문의") {
      let parsed, matchedTitle, workNameKo, delivery;
      try {
        const msgDateLink = new Date(parseInt(linkedMessage.ts.split('.')[0]) * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 10);
        parsed = await parseScheduleInquiry(originalText, msgDateLink);

        // 후보 감지 매칭 (부분일치 복수 체크 포함)
        const candResult = await matchWorkTitleWithCandidates(parsed.work_title_ja, parsed.work_title_ko).catch(() => null);
        if (candResult?.single) {
          matchedTitle = candResult.single;
        } else if (candResult?.multiple) {
          const pendingId = `sched_pending_${Date.now()}`;
          draftStore.set(pendingId, { type: "schedule_pending", parsed, sourceLink: linkInfo.url, originalText });
          await app.client.chat.update({ channel: message.channel, ts: progressMsg.ts,
            text: `작품명 *${parsed.work_title_ko || parsed.work_title_ja || "-"}* 후보가 여러 개야. 선택해줘.` });
          await app.client.chat.postMessage({ channel: message.channel, text: "작품을 선택해줘.",
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: `*작품 후보 ${candResult.multiple.length}건* — 해당하는 작품을 선택해줘.` }},
              { type: "actions", elements: candResult.multiple.map((r, i) => ({
                type: "button", action_id: `schedule_token_pick_${i}`,
                text: { type: "plain_text", text: r.projectName || r.jaDisplay || `후보 ${i+1}` },
                value: JSON.stringify({ pendingId, pivoId: r.pivoId, projectName: r.projectName }),
              }))},
            ],
          });
          return;
        } else if (candResult?.tooMany) {
          const pendingId = `sched_pending_${Date.now()}`;
          draftStore.set(pendingId, { type: "schedule_pending", parsed, sourceLink: linkInfo.url, originalText });
          await app.client.chat.update({ channel: message.channel, ts: progressMsg.ts,
            text: `*${parsed.work_title_ko || parsed.work_title_ja || "-"}* 와 일치하는 작품이 너무 많아. 더 정확한 작품명을 입력해줘.` });
          await app.client.chat.postMessage({ channel: message.channel, text: "작품명을 직접 입력해줘.",
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: `AI 추출 작품명: \`${parsed.work_title_ja || parsed.work_title_ko || "없음"}\`` }},
              { type: "actions", elements: [{ type: "button", action_id: "open_schedule_title_modal", text: { type: "plain_text", text: "작품명 직접 입력" }, style: "primary", value: pendingId }]},
            ],
          });
          return;
        } else {
          // null → 토큰 매칭 시도
          const tokenResult = await matchWorkTitleByTokens(parsed.work_title_ko, parsed.work_title_ja).catch(() => null);
          if (tokenResult?.single) {
            matchedTitle = tokenResult.single;
            console.log("[match-token] 단건 자동 선택:", matchedTitle.projectName);
          } else if (tokenResult?.multiple) {
            const pendingId = `sched_pending_${Date.now()}`;
            draftStore.set(pendingId, { type: "schedule_pending", parsed, sourceLink: linkInfo.url, originalText });
            await app.client.chat.update({ channel: message.channel, ts: progressMsg.ts,
              text: `작품명 *${parsed.work_title_ko || parsed.work_title_ja || "-"}* 후보가 여러 개야. 선택해줘.` });
            await app.client.chat.postMessage({ channel: message.channel, text: "작품을 선택해줘.",
              blocks: [
                { type: "section", text: { type: "mrkdwn", text: `*작품 후보 ${tokenResult.multiple.length}건* — 해당하는 작품을 선택해줘.` }},
                { type: "actions", elements: tokenResult.multiple.slice(0, 5).map((r, i) => ({
                  type: "button", action_id: `schedule_token_pick_${i}`,
                  text: { type: "plain_text", text: r.projectName || r.jaDisplay || `후보 ${i+1}` },
                  value: JSON.stringify({ pendingId, pivoId: r.pivoId, projectName: r.projectName }),
                }))},
              ],
            });
            return;
          }
        }

        workNameKo = matchedTitle?.projectName || null;
        delivery   = workNameKo && parsed.episode
          ? await fetchDeliveryDate(workNameKo, parsed.episode, "zh-ja", matchedTitle?.projectName || null).catch(e => { console.error("[DEBUG] fetchDelivery 오류:", e.message); return null; })
          : null;
        console.log("[DEBUG] delivery:", JSON.stringify(delivery));
      } catch (e) {
        await app.client.chat.update({ channel: message.channel, ts: progressMsg.ts, text: `스케줄 처리 오류: ${e.message}` }); return;
      }
      parsed.originalChannelId = linkInfo.channelId;
      parsed.originalTs        = linkInfo.ts;

      if (!matchedTitle || !delivery) {
        const pendingId = `sched_pending_${Date.now()}`;
        draftStore.set(pendingId, { type: "schedule_pending", parsed, sourceLink: linkInfo.url, originalText });
        await app.client.chat.update({ channel: message.channel, ts: progressMsg.ts,
          text: !matchedTitle ? `작품명 *${parsed.work_title_ja || parsed.work_title_ko || "-"}* 을 시트에서 찾지 못했어.` : `납품 시트에서 찾지 못했어.` });
        await app.client.chat.postMessage({ channel: message.channel, text: "작품명을 직접 입력해줘.",
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: `AI 추출 작품명: \`${parsed.work_title_ja || parsed.work_title_ko || "없음"}\`` }},
            { type: "actions", elements: [{ type: "button", action_id: "open_schedule_title_modal", text: { type: "plain_text", text: "작품명 직접 입력" }, style: "primary", value: pendingId }]},
          ],
        });
        return;
      }
      await app.client.chat.update({ channel: message.channel, ts: progressMsg.ts,
        text: `납품 시트 확인 완료 — *${delivery.episodeLabel}* 납품일: *${delivery.allSame ? delivery.deliveryDate : delivery.episodes.map(e=>`${e.episode}화:${e.deliveryDate}`).join(", ")}*` });
      await handleScheduleExt(client, message.channel, parsed, matchedTitle, delivery, linkInfo.url);
      return;
    }

    if (analysis.inquiry_type === "복수 문의") {
      await app.client.chat.update({ channel: message.channel, ts: progressMsg.ts, text: "📋 복수 문의 감지 — 항목별로 분석 중..." });
      await handleMultipleInquiry(client, message.channel, originalText, linkInfo.url, linkInfo.channelId, linkInfo.ts, "", analysis.multi_items || null);
      return;
    }

    if (analysis.inquiry_type === "기타") {
      const matchedForSummary = await matchWorkTitleFromSheet(analysis.title_ja, analysis.title_ko).catch(() => null);
      const displayName = matchedForSummary?.projectName || analysis.title_ja || analysis.title_ko || "";
      const titleInfo = { workName: displayName, episode: analysis.episode || "" };
      const btnValue  = JSON.stringify({ sourceLink: linkInfo.url, workName: displayName, episode: titleInfo.episode });
      await app.client.chat.update({ channel: message.channel, ts: progressMsg.ts, text: buildOtherInquirySummary(analysis, titleInfo) });
      await app.client.chat.postMessage({ channel: message.channel,
        text: "필요한 봇을 선택해줘.",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "필요한 봇을 선택해줘." }},
          { type: "actions", elements: [
            { type: "button", action_id: "direct_inquiry_btn",   text: { type: "plain_text", text: "문의봇" },    value: btnValue },
            { type: "button", action_id: "direct_resupply_btn",  text: { type: "plain_text", text: "재수급봇" },  value: btnValue },
            { type: "button", action_id: "direct_schedule_btn",  text: { type: "plain_text", text: "스케줄봇" },  value: btnValue },
            { type: "button", action_id: "direct_fileorder_btn", text: { type: "plain_text", text: "파일순서봇" }, value: btnValue },
            { type: "button", action_id: "direct_retake_btn",    text: { type: "plain_text", text: "태스크생성봇" }, value: btnValue },
          ]},
        ],
      });
      return;
    }

    if (["번역문 누락", "번역문 확인", "번역문 수정"].includes(analysis.inquiry_type)) {
      await updateProgress(message.channel, progressMsg.ts, 3, "작업자 릴레이 처리 중");
      const relayImageUrls = (linkedMessage.files || [])
        .filter(f => f.mimetype?.startsWith("image/"))
        .map(f => f.url_private || f.permalink || null)
        .filter(Boolean);
      await handleWorkerRelay(client, message.channel, analysis, { ...linkInfo }, originalText, linkedMessage.user || null, relayImageUrls);
      return;
    }

    if (analysis.inquiry_type === "원본 파일 순서") {
      await updateProgress(message.channel, progressMsg.ts, 3, "파일 순서 문의 처리 중");
      await handleFileOrderInquiry(client, message.channel, analysis, { ...linkInfo, requesterUserId: linkedMessage.user || null }, originalText);
      return;
    }

    if (analysis.inquiry_type === "원본 파일 확인") {
      let fileParsed;
      try { fileParsed = await parseFileInquiry(originalText); } catch (e) { fileParsed = {}; }
      const matchedTitle = await matchWorkTitleFromSheet(fileParsed.work_title_ja || analysis.title_ja, fileParsed.work_title_ko || analysis.title_ko).catch(() => null);
      
      // 납품일 조회
      const workNameKo = matchedTitle?.projectName || matchedTitle?.ko;
      const episode = fileParsed.episode || null;
      let deliveryDate = "-";
      if (workNameKo && episode) {
        try {
          const delivery = await fetchDeliveryDate(workNameKo, episode, "zh-ja", matchedTitle?.projectName || null);
          deliveryDate = delivery?.allSame ? delivery.deliveryDate : "-";
        } catch (e) {
          console.error("[file-inquiry-dm] 납품일 조회 실패:", e.message);
        }
      }
      
      const draftId = generateDraftId();
      const draft = {
        draftId, dmChannelId: message.channel,
        originalChannelId: linkInfo.channelId, originalTs: linkInfo.ts,
        workName:    matchedTitle?.projectName || matchedTitle?.ko || fileParsed.work_title_ko || fileParsed.work_title_ja || "-",
        jpTitle:     matchedTitle?.jpTitle || "-",
        pivoId:      matchedTitle?.pivoId || null,
        episode:     fileParsed.episode || "-",
        deliveryDate, // 납품일 추가
        fileNumbers: fileParsed.file_numbers || [],
        reason:      buildFileInquiryReason(fileParsed, matchedTitle),
        sourceLink:  linkInfo.url,
      };
      draftStore.set(draftId, draft);
      await app.client.chat.update({ channel: message.channel, ts: progressMsg.ts, text: "원본 파일 재수급 요청 초안을 만들었어." });
      await app.client.chat.postMessage({ channel: message.channel, text: "원본 재수급 요청 초안", blocks: buildFileInquiryBlocks(draft) });
      return;
    }

    let matchedTitle = null;
    if (analysis.title_ja || analysis.title_ko) {
      const candResult = await matchWorkTitleWithCandidates(analysis.title_ja, analysis.title_ko).catch(() => null);
      if (candResult?.single) {
        matchedTitle = candResult.single;
      } else if (candResult?.multiple || candResult?.tooMany) {
        const pendingId = `pending_${Date.now()}`;
        draftStore.set(pendingId, { isPending: true, userId: message.user, dmChannelId: message.channel, progressTs: progressMsg.ts, sourceLink: linkInfo.url, originalText, titleJa: analysis.title_ja, inquiryType: analysis.inquiry_type, inquiryContent: analysis.translated_ko, summary: analysis.summary_ko, actionRequired: analysis.action_required, priority: analysis.priority, sourceLang: analysis.source_lang });
        if (candResult?.multiple) {
          await app.client.chat.update({ channel: message.channel, ts: progressMsg.ts,
            text: `작품명 *${analysis.title_ko || analysis.title_ja || "-"}* 후보가 여러 개야. 선택해줘.` });
          await app.client.chat.postMessage({ channel: message.channel, text: "작품을 선택해줘.",
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: `*작품 후보 ${candResult.multiple.length}건* — 해당하는 작품을 선택해줘.` }},
              { type: "actions", elements: candResult.multiple.map((r, i) => ({
                type: "button", action_id: `inquiry_cand_pick_${i}`,
                text: { type: "plain_text", text: r.projectName || r.jaDisplay || `후보 ${i+1}` },
                value: JSON.stringify({ pendingId, pivoId: r.pivoId, projectName: r.projectName }),
              }))},
            ],
          });
        } else {
          await app.client.chat.update({ channel: message.channel, ts: progressMsg.ts,
            text: `*${analysis.title_ko || analysis.title_ja || "-"}* 와 일치하는 작품이 너무 많아. 더 정확한 작품명을 입력해줘.` });
          await app.client.chat.postMessage({ channel: message.channel, text: "작품명을 직접 입력해줘.",
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: `AI 추출 작품명: \`${analysis.title_ja || analysis.title_ko || "없음"}\`` }},
              { type: "actions", elements: [{ type: "button", action_id: "open_manual_title_modal", text: { type: "plain_text", text: "작품명 직접 입력" }, style: "primary", value: pendingId }]},
            ],
          });
        }
        return;
      }
    }
    await updateProgress(message.channel, progressMsg.ts, 4, "시트 매칭 완료");

    if (!matchedTitle) {
      const pendingId = `pending_${Date.now()}`;
      draftStore.set(pendingId, { isPending: true, userId: message.user, dmChannelId: message.channel, progressTs: progressMsg.ts, sourceLink: linkInfo.url, originalText, titleJa: analysis.title_ja, inquiryType: analysis.inquiry_type, inquiryContent: analysis.translated_ko, summary: analysis.summary_ko, actionRequired: analysis.action_required, priority: analysis.priority, sourceLang: analysis.source_lang });
      await app.client.chat.update({ channel: message.channel, ts: progressMsg.ts, text: `시트에서 *${analysis.title_ja || analysis.title_ko || "작품명"}* 을 찾지 못했어.` });
      await app.client.chat.postMessage({ channel: message.channel, text: "작품명을 직접 입력해줘.",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `AI 추출 작품명: \`${analysis.title_ja || analysis.title_ko || "없음"}\`` }},
          { type: "actions", elements: [{ type: "button", action_id: "open_manual_title_modal", text: { type: "plain_text", text: "작품명 직접 입력" }, style: "primary", value: pendingId }]},
        ],
      });
      return;
    }

    const draftId = generateDraftId();
    const draft = { draftId, userId: message.user, dmChannelId: message.channel, progressMessageTs: progressMsg.ts, sourceLink: linkInfo.url, originalText, originalChannelId: linkInfo.channelId || null, originalTs: linkInfo.ts || null, workName: matchedTitle.projectName||matchedTitle.ko||analysis.title_ko||analysis.title_ja||"", workNameKo: matchedTitle.ko||"", pivoId: matchedTitle.pivoId||null, episode: analysis.episode||null, inquiryType: analysis.inquiry_type||"기타", inquiryContent: analysis.translated_ko||"", summary: analysis.summary_ko||"", actionRequired: analysis.action_required||"", sourceLang: analysis.source_lang||"ja" };
    draftStore.set(draftId, draft);
    await app.client.chat.update({ channel: message.channel, ts: progressMsg.ts, text: buildDraftPreviewText(draft), blocks: buildDraftPreviewBlocks(draft) });
    }, { dmChannel: message.channel, client, label: "링크 소환" }).catch(() => {});
  } catch (error) {
    console.error(error);
    await app.client.chat.postMessage({ channel: message.channel, text: "처리 중 오류: " + error.message });
  }
});

// ── 작품명 직접 입력 (일반 문의) ─────────────────────────
app.action("open_manual_title_modal", async ({ ack, body, client }) => {
  await ack();
  const pending = draftStore.get(body.actions?.[0]?.value);
  if (!pending) return;
  await client.views.open({ trigger_id: body.trigger_id, view: {
    type: "modal", callback_id: "manual_title_modal", private_metadata: JSON.stringify({ pendingId: body.actions[0].value }),
    title: { type: "plain_text", text: "작품명 직접 입력" }, submit: { type: "plain_text", text: "이 이름으로 초안 생성" }, close: { type: "plain_text", text: "취소" },
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*AI 추출 작품명:* \`${pending.titleJa||"없음"}\`` }},
      { type: "input", block_id: "manual_work_name_ja", label: { type: "plain_text", text: "작품명 (일본어)" }, element: { type: "plain_text_input", action_id: "value", initial_value: pending.titleJa||"", placeholder: { type: "plain_text", text: "예: 鬼滅の刃" } }},
      { type: "input", block_id: "manual_work_name_ko", label: { type: "plain_text", text: "작품명 (한국어, 없으면 공백)" }, optional: true, element: { type: "plain_text_input", action_id: "value", placeholder: { type: "plain_text", text: "예: 귀멸의 칼날" } }},
    ],
  }});
});

app.view("manual_title_modal", async ({ ack, body, view, client }) => {
  await ack();
  const { pendingId } = JSON.parse(view.private_metadata || "{}");
  const pending = draftStore.get(pendingId);
  if (!pending) return;
  const vals = view.state.values;
  const workNameJa = vals.manual_work_name_ja?.value?.value?.trim() || pending.titleJa || "";
  const workNameKo = vals.manual_work_name_ko?.value?.value?.trim() || "";
  const matchedManual = await matchWorkTitleFromSheet(workNameJa, workNameKo).catch(() => null);
  const draftId = generateDraftId();
  const draft = { draftId, userId: pending.userId, dmChannelId: pending.dmChannelId, progressMessageTs: pending.progressTs, sourceLink: pending.sourceLink, originalText: pending.originalText, workName: matchedManual?.projectName || workNameJa, workNameKo: matchedManual?.ko || workNameKo, pivoId: matchedManual?.pivoId || null, inquiryType: pending.inquiryType||"기타", inquiryContent: pending.inquiryContent||"", summary: pending.summary||"", actionRequired: pending.actionRequired||"", sourceLang: pending.sourceLang||"ja" };
  draftStore.set(draftId, draft);
  draftStore.delete(pendingId);
  await client.chat.postMessage({ channel: draft.dmChannelId, text: buildDraftPreviewText(draft), blocks: buildDraftPreviewBlocks(draft) });
});

// ── 문의봇 후보 작품 선택 버튼 ───────────────────────────
app.action(/^inquiry_cand_pick_\d+$/, async ({ ack, body, client }) => {
  await ack();
  const { pendingId, pivoId, projectName } = JSON.parse(body.actions[0].value || "{}");
  const pending = draftStore.get(pendingId);
  if (!pending) return;

  const matchedTitle = { projectName, pivoId };
  const draftId = generateDraftId();
  const draft = {
    draftId,
    userId:             pending.userId,
    dmChannelId:        pending.dmChannelId,
    progressMessageTs:  pending.progressTs,
    sourceLink:         pending.sourceLink,
    originalText:       pending.originalText,
    workName:           projectName,
    workNameKo:         projectName,
    pivoId:             pivoId || null,
    inquiryType:        pending.inquiryType    || "기타",
    inquiryContent:     pending.inquiryContent || "",
    summary:            pending.summary        || "",
    actionRequired:     pending.actionRequired || "",
    sourceLang:         pending.sourceLang     || "ja",
  };
  draftStore.set(draftId, draft);
  draftStore.delete(pendingId);
  await client.chat.postMessage({ channel: draft.dmChannelId, text: buildDraftPreviewText(draft), blocks: buildDraftPreviewBlocks(draft) });
});

// ── 수정 모달 ─────────────────────────────────────────────
app.action("open_inquiry_modal", async ({ ack, body, client }) => {
  await ack();
  const draft = draftStore.get(body.actions?.[0]?.value);
  if (!draft) { await client.chat.postMessage({ channel: body.user.id, text: "초안을 찾지 못했어." }); return; }
  await client.views.open({ trigger_id: body.trigger_id, view: {
    type: "modal", callback_id: "submit_inquiry_modal", private_metadata: JSON.stringify({ draftId: body.actions[0].value }),
    title: { type: "plain_text", text: "문의 수정" }, submit: { type: "plain_text", text: "전송" }, close: { type: "plain_text", text: "취소" },
    blocks: [
      { type: "input", block_id: "work_name_block", label: { type: "plain_text", text: "작품명 (일본어)" }, element: { type: "plain_text_input", action_id: "work_name_input", initial_value: draft.workName||"" }},
      { type: "input", block_id: "work_name_ko_block", label: { type: "plain_text", text: "작품명 (한국어)" }, optional: true, element: { type: "plain_text_input", action_id: "work_name_ko_input", initial_value: draft.workNameKo||"" }},
      { type: "input", block_id: "episode_block", label: { type: "plain_text", text: "회차 (숫자만)" }, optional: true, element: { type: "plain_text_input", action_id: "episode_input", initial_value: draft.episode||"" }},
      { type: "input", block_id: "inquiry_type_block", label: { type: "plain_text", text: "문의 유형" }, element: { type: "plain_text_input", action_id: "inquiry_type_input", initial_value: draft.inquiryType||"" }},
      { type: "input", block_id: "inquiry_content_block", label: { type: "plain_text", text: "문의 내용" }, element: { type: "plain_text_input", action_id: "inquiry_content_input", multiline: true, initial_value: draft.inquiryContent||"" }},
      { type: "input", block_id: "summary_block", label: { type: "plain_text", text: "요약" }, element: { type: "plain_text_input", action_id: "summary_input", multiline: true, initial_value: draft.summary||"" }},
      { type: "input", block_id: "action_block", label: { type: "plain_text", text: "필요 액션" }, element: { type: "plain_text_input", action_id: "action_input", initial_value: draft.actionRequired||"" }},
      { type: "input", block_id: "link_block", label: { type: "plain_text", text: "원문 링크" }, element: { type: "plain_text_input", action_id: "link_input", initial_value: draft.sourceLink||"" }},
    ],
  }});
});

app.action("send_inquiry_now", async ({ ack, body, client }) => {
  await ack();
  const draft = draftStore.get(body.actions?.[0]?.value);
  if (!draft) { await client.chat.postMessage({ channel: body.user.id, text: "초안을 찾지 못했어." }); return; }
  await postInquiryToTargetChannel(client, draft, body.user.id);
  await client.chat.postMessage({ channel: body.user.id, text: `<#${TARGET_CHANNEL_ID}> 에 전송 완료!` });
});

app.view("submit_inquiry_modal", async ({ ack, body, view, client }) => {
  await ack();
  const { draftId } = JSON.parse(view.private_metadata || "{}");
  const draft = draftStore.get(draftId);
  if (!draft) { await client.chat.postMessage({ channel: body.user.id, text: "초안을 찾지 못했어." }); return; }
  const v = view.state.values;
  draft.workName       = v.work_name_block?.work_name_input?.value?.trim()             || "";
  draft.workNameKo     = v.work_name_ko_block?.work_name_ko_input?.value?.trim()       || "";
  draft.episode        = v.episode_block?.episode_input?.value?.trim()                 || "";
  draft.inquiryType    = v.inquiry_type_block?.inquiry_type_input?.value?.trim()       || "";
  draft.inquiryContent = v.inquiry_content_block?.inquiry_content_input?.value?.trim() || "";
  draft.summary        = v.summary_block?.summary_input?.value?.trim()                 || "";
  draft.actionRequired = v.action_block?.action_input?.value?.trim()                   || "";
  draft.sourceLink     = v.link_block?.link_input?.value?.trim()                       || "";
  draftStore.set(draftId, draft);
  await postInquiryToTargetChannel(client, draft, body.user.id);
  await app.client.chat.update({ channel: draft.dmChannelId, ts: draft.progressMessageTs, text: buildDraftPreviewText(draft), blocks: buildDraftPreviewBlocks(draft) });
  await client.chat.postMessage({ channel: body.user.id, text: `수정 내용으로 <#${TARGET_CHANNEL_ID}> 에 전송 완료!` });
});

// ── /task 커맨드 ──────────────────────────────────────────
const DAY_NAMES  = ["일", "월", "화", "수", "목", "금", "토"];
const TASKS_FILE = path.join(__dirname, "tasks.json");
function loadTasks() { try { if (fs.existsSync(TASKS_FILE)) return JSON.parse(fs.readFileSync(TASKS_FILE, "utf-8")); } catch (e) { console.error("tasks.json 읽기 실패:", e.message); } return { 일:[], 월:[], 화:[], 수:[], 목:[], 금:[], 토:[] }; }
function saveTasks(store) { try { fs.writeFileSync(TASKS_FILE, JSON.stringify(store, null, 2), "utf-8"); } catch (e) { console.error("tasks.json 저장 실패:", e.message); } }
const taskStore = loadTasks();

app.command("/task", async ({ command, ack, respond }) => {
  await ack();
  const parts = command.text.trim().split(/\s+/);
  const [action, day, ...rest] = parts;
  const task = rest.join(" ");
  if (action === "list") {
    if (day && taskStore[day] !== undefined) {
      const items = taskStore[day];
      await respond(items.length ? `*${day}요일 업무 (${items.length}건)*\n` + items.map((t, i) => `${i+1}. ${t}`).join("\n") : `${day}요일에 등록된 업무가 없어.`);
    } else {
      const lines = ["*요일별 업무 전체 목록*", ""];
      DAY_NAMES.filter(d => d !== "일" && d !== "토").forEach(d => lines.push(`*${d}요일*: ${taskStore[d].length ? taskStore[d].join(" / ") : "없음"}`));
      await respond(lines.join("\n"));
    }
    return;
  }
  if (!DAY_NAMES.includes(day)) { await respond("요일을 올바르게 입력해줘. 예: `/task add 월 미팅 준비`"); return; }
  if (!task) { await respond("업무 내용을 입력해줘."); return; }
  if (action === "add") { taskStore[day].push(task); saveTasks(taskStore); await respond(`✅ *${day}요일* 업무 추가: ${task}`); return; }
  if (action === "remove") {
    const idx = taskStore[day].findIndex(t => t === task);
    if (idx === -1) { await respond(`"${task}" 를 찾지 못했어.`); return; }
    taskStore[day].splice(idx, 1); saveTasks(taskStore);
    await respond(`🗑 *${day}요일* 업무 삭제: ${task}`); return;
  }
  await respond("사용법:\n`/task add 월 미팅 준비`\n`/task remove 월 미팅 준비`\n`/task list`");
});

// ── 데일리 리포트 ─────────────────────────────────────────
async function sendDailyReport() {
  try {
    const now     = new Date();
    const dayName = DAY_NAMES[now.getDay()];
    const dateStr = now.toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" });
    const lines   = [`*📅 데일리 리포트 (${dateStr} ${dayName}요일)*`, "", "*✅ 오늘의 업무*"];
    const todayTasks = taskStore[dayName] || [];
    if (todayTasks.length) todayTasks.forEach((t, i) => lines.push(`  ${i+1}. ${t}`));
    else lines.push(`  등록된 업무 없음 ← \`/task add ${dayName} 업무내용\` 으로 추가해줘`);
    lines.push("", "*🔖 [나중에] 보관 항목*", "  User Token 설정 후 자동화 예정");
    await app.client.chat.postMessage({ channel: REPORT_CHANNEL_ID, text: lines.join("\n") });
  } catch (e) { console.error("데일리 리포트 오류:", e.message); }
}
cron.schedule("0 10 * * 1-5", sendDailyReport, { timezone: "Asia/Seoul" });

// ── API 로그 분석 — 매일 15:00 KST ───────────────────────
async function sendApiAnalysisReport() {
  try {
    const { LOG_DIR } = require("./apiLogger");
    const targetDate  = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const filePath    = path.join(LOG_DIR, `api-${targetDate}.jsonl`);
    if (!fs.existsSync(filePath)) {
      console.log("[apiAnalyzer] 전날 로그 없음 — 알럿 생략");
      return;
    }
    const logs = fs.readFileSync(filePath, "utf8")
      .split("\n").filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    if (!logs.length) return;

    const WASTE_RATIO = 0.2, REPEAT_WIN = 10, REPEAT_MIN = 3, SLOW_MS = 3000;
    const issues = [];
    const epMap  = {};
    for (const log of logs) {
      const k = log.endpoint;
      if (!epMap[k]) epMap[k] = { calls: 0, wastedCalls: 0, slowCalls: 0, totalMs: 0 };
      epMap[k].calls++;
      epMap[k].totalMs += log.elapsedMs ?? 0;
      if (log.elapsedMs >= SLOW_MS) epMap[k].slowCalls++;
      if (log.expectedCount !== null && log.returnedCount > 0 &&
          log.expectedCount / log.returnedCount < WASTE_RATIO) epMap[k].wastedCalls++;
    }
    for (const [ep, s] of Object.entries(epMap)) {
      if (s.wastedCalls > 0) issues.push(`🔴 *과다 조회* \`${ep}\`\n  ${s.calls}회 중 ${s.wastedCalls}회 — 반환 건수 대비 실사용 ${Math.round(WASTE_RATIO*100)}% 미만\n  → 서버 사이드 필터 파라미터 추가 요청 필요`);
      if (s.slowCalls  > 0) issues.push(`🟡 *느린 호출* \`${ep}\`\n  ${s.slowCalls}회가 ${SLOW_MS/1000}초 이상 (평균 ${Math.round(s.totalMs/s.calls)}ms)`);
    }
    const sorted = [...logs].sort((a, b) => new Date(a.ts) - new Date(b.ts));
    const winMap = {};
    for (const log of sorted) {
      const k = `${log.endpoint}|${log.bot}`;
      if (!winMap[k]) winMap[k] = [];
      winMap[k].push(new Date(log.ts).getTime());
    }
    for (const [key, times] of Object.entries(winMap)) {
      let burst = 1, max = 0;
      for (let i = 1; i < times.length; i++) {
        burst = times[i] - times[i-1] <= REPEAT_WIN * 1000 ? burst + 1 : 1;
        max   = Math.max(max, burst);
      }
      if (max >= REPEAT_MIN) {
        const [ep, bot] = key.split("|");
        issues.push(`🟠 *N+1 의심* \`${ep}\` [${bot}]\n  ${REPEAT_WIN}초 이내 최대 ${max}회 반복 → 배치 조회 또는 캐시 검토 필요`);
      }
    }
    const total  = logs.length;
    const fail   = logs.filter(l => !l.success).length;
    const avgMs  = Math.round(logs.reduce((s, l) => s + (l.elapsedMs ?? 0), 0) / total);
    const botMap = {};
    for (const l of logs) botMap[l.bot] = (botMap[l.bot] ?? 0) + 1;
    const botLine = Object.entries(botMap).map(([b, c]) => `${b} ${c}회`).join(" / ");
    const blocks = [
      { type: "header", text: { type: "plain_text", text: `📊 API 호출 분석 리포트 — ${targetDate}` } },
      { type: "section", fields: [
        { type: "mrkdwn", text: `*총 호출*\n${total}회` },
        { type: "mrkdwn", text: `*실패*\n${fail}회` },
        { type: "mrkdwn", text: `*평균 응답*\n${avgMs}ms` },
        { type: "mrkdwn", text: `*봇별*\n${botLine || "-"}` },
      ]},
      { type: "divider" },
      ...(issues.length === 0
        ? [{ type: "section", text: { type: "mrkdwn", text: "✅ 개선 필요 항목 없음" } }]
        : issues.map(i => ({ type: "section", text: { type: "mrkdwn", text: i } }))
      ),
    ];
    await app.client.chat.postMessage({
      channel: PM_SLACK_ID,
      text   : `📊 API 호출 분석 리포트 — ${targetDate}`,
      blocks,
    });
    console.log("[apiAnalyzer] 리포트 전송 완료");
  } catch (e) {
    console.error("[apiAnalyzer] 분석 오류:", e.message);
  }
}
cron.schedule("0 15 * * *", sendApiAnalysisReport, { timezone: "Asia/Seoul" });
cleanOldLogs();
console.log("[apiAnalyzer] 일일 분석 스케줄 등록 완료 (매일 15:00 KST)");

// ── 서버 시작 ─────────────────────────────────────────────
(async () => {
  try {
    // Socket Mode 연결 이벤트 리스너 (app.start() 전에 등록)
    console.log("✅ Socket Mode 리스너 등록 시작");
    if (app.receiver && app.receiver.client) {
      app.receiver.client.on('authenticated', () => {
        console.log('✅ [socket-mode] Socket Mode 인증 성공');
      });

      app.receiver.client.on('connected', () => {
        console.log('✅ [socket-mode] WebSocket 연결 완료');
      });

      app.receiver.client.on('disconnected', async (error) => {
        console.error('⚠️ [socket-mode] WebSocket 연결 끊김:', error?.message || '알 수 없는 오류');
        await sendAlert(`⚠️ Slack 봇 WebSocket 연결 끊김\n${error?.message || ''}`).catch(() => {});
        
        // 5초 후 재연결 시도
        setTimeout(() => {
          console.log('🔄 [socket-mode] 재연결 시도 중...');
          app.receiver.client.start().catch(e => {
            console.error('❌ [socket-mode] 재연결 실패:', e.message);
          });
        }, 5000);
      });

      app.receiver.client.on('unable_to_socket_mode_start', async (error) => {
        console.error('❌ [socket-mode] Socket Mode 시작 실패:', error.message);
        await sendAlert(`❌ Slack 봇 Socket Mode 시작 실패\n${error.message}`).catch(() => {});
      });
    }

    // Pong 타임아웃 에러 핸들링
    app.error(async (error) => {
      console.error('❌ [app-error]:', error);
      if (error.message?.includes('pong')) {
        console.log('🔄 [socket-mode] Pong 타임아웃 감지 - 자동 재연결 대기 중');
      }
    });

    // Socket Mode 시작
    await app.start();
    // 알럿 클라이언트 초기화 (PM_SLACK_ID로 오류 알럿 전송)
    initAlertClient(app.client, process.env.PM_SLACK_ID);
    console.log("🚀 시스템 가동! 준비 완료!");

  } catch (error) {
    console.error('❌ 시스템 시작 실패:', error);
    await sendAlert(`❌ Slack 봇 시작 실패\n${error.message}`).catch(() => {});
    process.exit(1);
  }
})();
