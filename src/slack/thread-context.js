// 단일 책임: Slack 스레드 맥락 조회 및 텍스트 결합 (슬랙 client 인자 기반 DI)
"use strict";

// ── 처리 완료 이모지 ────────────────────────────────────────
// 한 번 분기 처리까지 끝낸 원본 메시지에 부착해서, 같은 스레드에서 다른 댓글로 재소환되어도 재분석되지 않게 함.
const PROCESSED_REACTION = "대응완료";

/**
 * @param {{ cleanSlackText: Function }} deps
 */
module.exports = function createThreadContext({ cleanSlackText }) {
  async function fetchSingleLinkedMessage(client, channelId, ts) {
    const res = await client.conversations.history({ channel: channelId, oldest: ts, inclusive: true, limit: 1 });
    return res.messages?.[0] || null;
  }

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
      const targetTime = parseFloat(targetTs);
      const filtered = res.messages.filter(m => {
        if (parseFloat(m.ts) > targetTime) return false; // 소환 메시지 이후 제외
        if (m.bot_id) return false; // 봇 메시지 제외
        // 3. 자기 자신이 아닌 메시지 중 대응완료 이모지가 붙은 건 제외 (이미 처리된 문의)
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

  return {
    PROCESSED_REACTION,
    fetchSingleLinkedMessage,
    markInquiryProcessed,
    fetchThreadContext,
    buildThreadContextText,
  };
};
