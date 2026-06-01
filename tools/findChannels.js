// findChannels.js
// 미매칭 작업자의 Slack User ID로 공개 채널을 조회하여 채널 ID를 찾는 스크립트
// 실행: node findChannels.js

require("dotenv").config();
const { WebClient } = require("@slack/web-api");
const fs = require("fs");
const path = require("path");

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

// ── 작업자 채널 prefix 패턴 ──────────────────────────────
const CHANNEL_PREFIXES = [
  "ko2ja_webtoon_tr_",
  "cn2ja_webtoon_tr_",
  "zh-cn2ja_webtoon_tr_",
  "zh-ch2ja_webtoon_tr_",
  "식자_",
  "웹툰_식자_",
  "한일웹툰-",
];

// ── 미매칭 작업자 목록 (workers.csv에서 채널ID가 없는 행) ──
// 아래 배열을 workers.csv 미매칭 데이터로 교체하거나
// CSV를 직접 읽도록 수정 가능
const UNMATCHED_WORKERS = require("./unmatched_workers.json");

async function getAllPublicChannels() {
  console.log("공개 채널 전체 목록 조회 중...");
  const channels = [];
  let cursor;

  do {
    const res = await client.conversations.list({
      types: "public_channel",
      limit: 1000,
      cursor,
      exclude_archived: true,
    });
    channels.push(...(res.channels || []));
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);

  // 작업자 채널 prefix에 해당하는 채널만 필터링
  const workerChannels = channels.filter(ch =>
    CHANNEL_PREFIXES.some(prefix => ch.name.startsWith(prefix))
  );

  console.log(`전체 공개 채널: ${channels.length}개 / 작업자 채널: ${workerChannels.length}개`);
  return workerChannels;
}

async function getMembersOfChannel(channelId) {
  const members = [];
  let cursor;
  try {
    do {
      const res = await client.conversations.members({
        channel: channelId,
        limit: 200,
        cursor,
      });
      members.push(...(res.members || []));
      cursor = res.response_metadata?.next_cursor;
    } while (cursor);
  } catch (e) {
    // 봇이 멤버가 아닌 채널은 skip
  }
  return members;
}

async function main() {
  // ── 1. 작업자 채널 전체 목록 조회 ──────────────────────
  const workerChannels = await getAllPublicChannels();

  // ── 2. 채널별 멤버 목록 수집 (User ID → 채널 ID/Name 맵) ──
  console.log(`채널 멤버 조회 중... (${workerChannels.length}개 채널)`);
  const userToChannel = {}; // { slackUserId: { id, name } }

  for (let i = 0; i < workerChannels.length; i++) {
    const ch = workerChannels[i];
    process.stdout.write(`\r  [${i + 1}/${workerChannels.length}] ${ch.name}                    `);
    const members = await getMembersOfChannel(ch.id);
    for (const userId of members) {
      if (!userToChannel[userId]) {
        userToChannel[userId] = { id: ch.id, name: ch.name };
      }
    }
  }
  console.log("\n멤버 수집 완료.");

  // ── 3. 미매칭 작업자와 매칭 ──────────────────────────────
  const results = { found: [], notFound: [] };

  for (const worker of UNMATCHED_WORKERS) {
    const match = userToChannel[worker.slackId];
    if (match) {
      results.found.push({
        name:      worker.name,
        email:     worker.email,
        slackId:   worker.slackId,
        channelId: match.id,
        channelName: match.name,
      });
    } else {
      results.notFound.push({
        name:    worker.name,
        email:   worker.email,
        slackId: worker.slackId,
      });
    }
  }

  // ── 4. 결과 출력 및 저장 ─────────────────────────────────
  console.log(`\n============================`);
  console.log(` 결과 요약`);
  console.log(`============================`);
  console.log(`채널 찾음  : ${results.found.length}명`);
  console.log(`여전히 없음: ${results.notFound.length}명`);

  if (results.found.length) {
    console.log("\n✅ 채널 찾은 작업자:");
    results.found.forEach(w => console.log(`  ${w.name} (${w.slackId}) → #${w.channelName} [${w.channelId}]`));
  }

  if (results.notFound.length) {
    console.log("\n❓ 여전히 채널 없음 (수동 입력 필요):");
    results.notFound.forEach(w => console.log(`  ${w.name} (${w.slackId})`));
  }

  fs.writeFileSync(
    path.join(__dirname, "findChannels_result.json"),
    JSON.stringify(results, null, 2),
    "utf-8"
  );
  console.log("\n→ 결과 저장: findChannels_result.json");
}

main().catch(e => console.error("오류:", e.message));
