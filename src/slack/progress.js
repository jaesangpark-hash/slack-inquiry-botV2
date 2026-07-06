// 단일 책임: Slack 진행 상태 업데이트 및 오류 알럿 유틸
"use strict";

/**
 * @param {{ slackClient: object, sendAlert: Function }} deps
 */
module.exports = function createProgress({ slackClient, sendAlert }) {
  function buildProgressText(step, note = "") {
    const steps = ["링크 확인", "메시지 조회", "AI 분석", "시트 매칭", "초안 작성"];
    const lines = ["*실행 중...*"];
    steps.forEach((label, i) => lines.push(i < step ? "■ " + label : i === step ? "▣ " + label : "□ " + label));
    if (note) lines.push("", note);
    return lines.join("\n");
  }

  async function updateProgress(channel, ts, step, note = "") {
    await slackClient.chat.update({ channel, ts, text: buildProgressText(step, note) });
  }

  async function alertOnError(label, fn) {
    try {
      return await fn();
    } catch (e) {
      console.error(`[${label}] 오류:`, e.message);
      await sendAlert(`*${label} 오류*\n${e.message}`).catch(() => {});
      throw e;
    }
  }

  async function withTimeout(fn, { dmChannel, client, label = "봇 처리", timeoutMs } = {}) {
    const TIMEOUT_MS = timeoutMs || 60000;
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("TIMEOUT")), TIMEOUT_MS);
    });
    const fnPromise = fn();
    try {
      const result = await Promise.race([fnPromise, timeoutPromise]);
      clearTimeout(timer);
      return result;
    } catch (e) {
      clearTimeout(timer);
      // fn()이 타임아웃 이후에도 백그라운드에서 실행 중일 수 있음.
      // 나중에 reject되면 UnhandledPromiseRejection → 프로세스 종료로 이어지므로 silencing.
      fnPromise.catch(() => {});
      if (e.message === "TIMEOUT") {
        console.error(`[timeout] ${label} ${TIMEOUT_MS / 1000}초 초과`);
        if (dmChannel && client) {
          await client.chat.postMessage({
            channel: dmChannel,
            text: `⏱ 처리 시간이 초과됐어. 다시 소환해줘.\n문제가 반복되면 담당자에게 문의해줘.`,
          }).catch(() => {});
        }
        await sendAlert(`*타임아웃*\n• 위치: \`${label}\`\n• ${TIMEOUT_MS / 1000}초 초과로 처리가 중단됐어.`).catch(() => {});
      } else {
        // 타임아웃 외 일반 오류도 알럿
        await sendAlert(`*${label} 오류*\n${e.message}`).catch(() => {});
      }
      throw e;
    }
  }

  return { buildProgressText, updateProgress, alertOnError, withTimeout };
};
