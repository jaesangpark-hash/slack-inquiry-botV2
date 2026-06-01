/**
 * collectWorkers.js
 *
 * 실행: node collectWorkers.js
 * 출력: workers_new.csv (기존 DB에 없는 신규 작업자만)
 *
 * 동작:
 * 1. Totus API → targetLanguageCode=LGC0003 전체 조회 (페이지네이션)
 * 2. 클라이언트에서 포지션별 필터링 (스킬.원본언어 + 스킬.역할 기준)
 * 3. Slack users.list → 이메일 맵 생성 (로컬 매칭)
 * 4. Slack conversations.list → 작업자 채널 후보 수집 후 이름 매칭
 * 5. workers_existing.csv 로드 → 기존 DB 이메일 스킵
 * 6. workers_new.csv 저장
 *
 * 언어코드: LGC0001=한국어 / LGC0003=일본어 / LGC0004=중국어간체
 * CSV 컬럼: 이름(Totus), 이메일, Slack UserID, 채널ID
 */

require('dotenv').config();
const { WebClient } = require('@slack/web-api');
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

// ─── 설정 ─────────────────────────────────────────────────
const SLACK_BOT_TOKEN    = process.env.SLACK_BOT_TOKEN;
const PLATFORM_API_URL   = process.env.PLATFORM_API_URL;
const PLATFORM_API_TOKEN = process.env.PLATFORM_API_TOKEN;

const OUTPUT_PATH   = path.join(__dirname, 'workers_new.csv');
const EXISTING_PATH = path.join(__dirname, 'workers_existing.csv');

const CHANNEL_PREFIXES = [
  'ko2ja_webtoon_tr_',
  'cn2ja_webtoon_tr_',
  'zh-cn2ja_webtoon_tr_',
  'zh-ch2ja_webtoon_tr_',
  '식자_',
  '웹툰_식자_',
  '한일웹툰-',
];

// 클라이언트 필터 조건 (API 파라미터 무시됨 → 응답값으로 직접 필터)
// 스킬.원본언어: LGC0001=한국어, LGC0004=중국어간체, null=식자계열
// 스킬.역할: WORKER=작업자, EVALUATOR=검수자
const POSITIONS = [
  { label: '번역(KO→JA)',       원본언어: 'LGC0001', 역할: 'WORKER'    },
  { label: '번역검수(KO→JA)',   원본언어: 'LGC0001', 역할: 'EVALUATOR' },
  { label: '번역(ZH-CN→JA)',    원본언어: 'LGC0004', 역할: 'WORKER'    },
  { label: '번역검수(ZH-CN→JA)',원본언어: 'LGC0004', 역할: 'EVALUATOR' },
  { label: '식자(JA)',           원본언어: null,       역할: 'WORKER'    },
  { label: '식자검수(JA)',       원본언어: null,       역할: 'EVALUATOR' },
];
// ──────────────────────────────────────────────────────────

const slack = new WebClient(SLACK_BOT_TOKEN);

// ─── 1. 기존 DB 이메일 로드 ───────────────────────────────
function loadExistingEmails() {
  if (!fs.existsSync(EXISTING_PATH)) {
    console.log('⚠️  workers_existing.csv 없음 — 중복 제외 없이 전체 조회');
    return new Set();
  }
  const lines  = fs.readFileSync(EXISTING_PATH, 'utf-8').replace(/^\uFEFF/, '').split('\n').slice(1);
  const emails = new Set();
  for (const line of lines) {
    const email = (line.split(',')[1] || '').replace(/"/g, '').trim().toLowerCase();
    if (email) emails.add(email);
  }
  console.log(`기존 DB 이메일 ${emails.size}개 로드 → 신규만 수집`);
  return emails;
}

// ─── 2. Totus 전체 조회 (targetLanguageCode=LGC0003) ──────
async function fetchAllTotusWorkers() {
  console.log('\n[1] Totus API 전체 조회 중... (targetLanguageCode=LGC0003)');
  const all  = [];
  let page   = 0;
  let total  = null;

  while (true) {
    const res  = await axios.get(`${PLATFORM_API_URL}/api/v1/workers`, {
      headers: { Authorization: `Bearer ${PLATFORM_API_TOKEN}` },
      params:  { targetLanguageCode: 'LGC0003', page, size: 100 },
    });
    const body = res.data;
    const list = body.data ?? body.content ?? (Array.isArray(body) ? body : []);
    if (!list.length) break;

    all.push(...list);
    total = body.meta?.전체건수 ?? body.totalElements ?? null;
    const totalPages = body.meta?.전체페이지 ?? body.totalPages ?? null;

    process.stdout.write(`\r    페이지 ${page + 1}/${totalPages ?? '?'} — 수집 ${all.length}/${total ?? '?'}명`);

    if (totalPages !== null && page + 1 >= totalPages) break;
    if (totalPages === null && list.length < 100) break;
    page++;
  }

  console.log(`\n    → 전체 ${all.length}명 수집 완료`);
  return all;
}

// ─── 3. 포지션별 클라이언트 필터링 ───────────────────────
function filterByPosition(allWorkers) {
  console.log('\n[2] 포지션별 필터링 중...');

  // 이메일 기준 중복 제거 후 포지션 레이블 부여
  // 한 작업자가 여러 스킬을 가질 수 있으므로 스킬 단위로 먼저 필터
  const seen    = new Set();
  const result  = [];

  for (const pos of POSITIONS) {
    let count = 0;
    for (const w of allWorkers) {
      const 스킬   = w.스킬;
      const email  = (w.작업자?.이메일 ?? '').toLowerCase();
      if (!email) continue;

      const 원본일치 = pos.원본언어 === null
        ? (스킬.원본언어 === null || 스킬.원본언어명 === null)
        : 스킬.원본언어 === pos.원본언어;
      const 역할일치 = 스킬.역할 === pos.역할;
      const 타겟일치 = 스킬.타겟언어 === 'LGC0003';

      if (!원본일치 || !역할일치 || !타겟일치) continue;
      if (seen.has(email)) continue;

      seen.add(email);
      result.push({
        name:   w.작업자?.이름  ?? '',
        email:  w.작업자?.이메일 ?? '',
        label:  pos.label,
      });
      count++;
    }
    console.log(`    [${pos.label}] ${count}명`);
  }

  console.log(`    → 전 포지션 합계 (중복 제거): ${result.length}명`);
  return result;
}

// ─── 4. Slack 전체 유저 → 이메일 맵 ──────────────────────
async function buildSlackEmailMap() {
  console.log('\n[3] Slack 전체 유저 수집 중...');
  const members = [];
  let cursor;
  do {
    const res = await slack.users.list({ limit: 200, cursor });
    members.push(...res.members);
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);

  const emailMap = new Map();
  for (const u of members) {
    if (u.is_bot || u.deleted) continue;
    const email = u.profile?.email;
    if (email) emailMap.set(email.toLowerCase(), u);
  }
  console.log(`    → 활성 유저 ${emailMap.size}명 맵 생성 완료`);
  return emailMap;
}

// ─── 5. Slack 작업자 채널 후보 ────────────────────────────
async function getWorkerChannels() {
  console.log('\n[4] Slack 작업자 채널 조회 중...');
  const channels = [];
  let cursor;
  do {
    const res = await slack.conversations.list({
      types: 'public_channel', limit: 1000, exclude_archived: true, cursor,
    });
    channels.push(...res.channels);
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);

  const workerChannels = channels.filter(c =>
    CHANNEL_PREFIXES.some(p => c.name.startsWith(p))
  );
  console.log(`    → 전체 ${channels.length}개 / 작업자 채널 ${workerChannels.length}개`);
  return workerChannels;
}

// ─── 6. 채널명 매칭 ───────────────────────────────────────
function findChannel(name, channels) {
  if (!name) return null;
  const norm = str =>
    str.toLowerCase().replace(/님$/, '').replace(/\s+/g, '-').replace(/_/g, '-');
  const t = norm(name);
  return (
    channels.find(c => norm(c.name).endsWith(t)) ??
    channels.find(c => norm(c.name).includes(t)) ??
    null
  );
}

// ─── 7. CSV 저장 ──────────────────────────────────────────
function saveCSV(rows) {
  const header = '이름(Totus),이메일,Slack UserID,채널ID';
  const lines  = rows.map(r =>
    r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
  );
  fs.writeFileSync(OUTPUT_PATH, '\uFEFF' + [header, ...lines].join('\n'), 'utf8');
  console.log(`\n    → CSV 저장: ${OUTPUT_PATH}`);
}

// ─── 메인 ─────────────────────────────────────────────────
async function main() {
  console.log('============================');
  console.log(' 작업자 정보 수집 시작');
  console.log('============================');

  const existingEmails = loadExistingEmails();
  const allTotus       = await fetchAllTotusWorkers();
  const filtered       = filterByPosition(allTotus);
  const slackEmailMap  = await buildSlackEmailMap();
  const workerChannels = await getWorkerChannels();

  console.log('\n[5] 매칭 처리 중...');
  const rows      = [];
  const noSlack   = [];
  const noChannel = [];

  for (const w of filtered) {
    const email = w.email.toLowerCase();
    if (existingEmails.has(email)) continue; // 기존 DB 스킵

    const slackUser = slackEmailMap.get(email);
    if (!slackUser) {
      noSlack.push(`${w.name} <${email}> [${w.label}]`);
      rows.push([w.name, w.email, '', '']); // 수동 입력 대상
      continue;
    }

    const userId    = slackUser.id;
    const channel   = findChannel(w.name, workerChannels);
    const channelId = channel?.id ?? '';

    if (!channelId) noChannel.push(`${w.name} (${userId}) [${w.label}]`);
    rows.push([w.name, w.email, userId, channelId]);

    console.log(`    ${channel ? '✅' : '❓'} [${w.label}] ${w.name} | ${userId} | ${channel ? '#' + channel.name : '채널 없음'}`);
  }

  saveCSV(rows);

  console.log('\n============================');
  console.log(' 완료 요약');
  console.log('============================');
  console.log(`CSV 등록                   : ${rows.length}명`);
  console.log(`Slack 도메인 불일치        : ${noSlack.length}명 → C/D열 수동 입력`);
  if (noSlack.length)   noSlack.forEach(n => console.log(`   ${n}`));
  console.log(`채널 미매칭                : ${noChannel.length}명 → D열 수동 입력`);
  if (noChannel.length) noChannel.forEach(n => console.log(`   ${n}`));
  console.log('\n→ workers_new.csv를 시트 기존 DB 아래에 붙여넣기');
}

main().catch(err => {
  console.error('❌ 오류:', err.message ?? err);
  process.exit(1);
});
