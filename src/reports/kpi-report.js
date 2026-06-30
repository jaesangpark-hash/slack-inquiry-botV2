"use strict";
// 단일 책임: API 호출 로그 파일 파싱 → 과다조회/느린호출/N+1 집계 → Slack KPI 리포트 발송

const fs   = require("fs");
const path = require("path");

/**
 * KPI 리포트 팩토리.
 *
 * @param {{ slackClient: object, reportChannelId: string, logDir: string }} deps
 *   - slackClient    : Slack WebClient (app.client)
 *   - reportChannelId: 리포트 발송 대상 Slack 채널/DM ID (PM_SLACK_ID)
 *   - logDir         : JSONL 로그 디렉토리 경로 (apiLogger.LOG_DIR)
 * @returns {{ sendApiAnalysisReport: () => Promise<void> }}
 */
module.exports = function createKpiReport({ slackClient, reportChannelId, logDir }) {
  /**
   * 전날 API 호출 로그를 분석해 Slack KPI 리포트를 발송한다.
   * cron 진입점에서만 호출(매일 15:00 KST).
   */
  async function sendApiAnalysisReport() {
    try {
      const targetDate  = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const filePath    = path.join(logDir, `api-${targetDate}.jsonl`);
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
      // ── 봇별 완료 건수 (최종 액션 기준) ──────────────────────
      const COMPLETIONS = [
        { label: "태스크재생성봇", bot: "retake",      endpoint: "/tasks/dates"            },
        { label: "스케줄봇",       bot: "schedule",    endpoint: "/tasks/dates"            },
        { label: "파일순서봇",     bot: "fileOrder",   endpoint: "/source-groups/complete" },
        { label: "작업자봇",       bot: "workerRelay", endpoint: "/slack/relay-sent"       },
        { label: "문의봇",         bot: "inquiry",     endpoint: "/slack/inquiry-sent"     },
      ];
      const completionCounts = COMPLETIONS.map(({ label, bot, endpoint }) => {
        const count = logs.filter(l => l.bot === bot && l.endpoint === endpoint && l.success).length;
        return { label, count };
      });
      const completionLine = completionCounts
        .map(({ label, count }) => `${label} *${count}*회`)
        .join("  ·  ");

      const total  = logs.length;
      const fail   = logs.filter(l => !l.success).length;
      const avgMs  = Math.round(logs.reduce((s, l) => s + (l.elapsedMs ?? 0), 0) / total);
      const blocks = [
        { type: "header", text: { type: "plain_text", text: `📊 운영 리포트 — ${targetDate}` } },
        { type: "section", text: { type: "mrkdwn", text: `*봇별 완료 건수*\n${completionLine || "-"}` } },
        { type: "divider" },
        { type: "section", fields: [
          { type: "mrkdwn", text: `*총 API 호출*\n${total}회` },
          { type: "mrkdwn", text: `*실패*\n${fail}회` },
          { type: "mrkdwn", text: `*평균 응답*\n${avgMs}ms` },
        ]},
        { type: "divider" },
        ...(issues.length === 0
          ? [{ type: "section", text: { type: "mrkdwn", text: "✅ 개선 필요 항목 없음" } }]
          : issues.map(i => ({ type: "section", text: { type: "mrkdwn", text: i } }))
        ),
      ];
      await slackClient.chat.postMessage({
        channel: reportChannelId,
        text   : `📊 운영 리포트 — ${targetDate}`,
        blocks,
      });
      console.log("[apiAnalyzer] 리포트 전송 완료");
    } catch (e) {
      console.error("[apiAnalyzer] 분석 오류:", e.message);
    }
  }

  return { sendApiAnalysisReport };
};
