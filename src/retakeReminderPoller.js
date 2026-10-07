// 단일 책임: 미제출(미완료) 리테이크를 모아 지정 시각에 소환 담당자를 태그해 공지한다
"use strict";

const { cleanWorkName } = require("./retakeTitle");

/**
 * 미제출 리테이크 일괄 리마인더 (DI 팩토리)
 *
 * tick(): 감시 시트 전체를 읽어
 *   - status === "watching"(아직 완료 알림 안 나감 = 미제출)
 *   - 오늘(KST) 등록분(registeredAt)
 *   - 감시 대상 채널(watchChannels) 소환건
 *   만 골라, 채널별로 1건 요약 메시지를 올려 "소환한 담당자"(ownerUserId)를 @멘션한다.
 *
 * 완료(notified)·DROP(dropped)·14일 컷오프(expired)·범위 밖(skipped)·어제 이전 행은 제외.
 * 대상이 없으면 아무것도 보내지 않는다(빈 공지 방지). 평일 18시 등 호출 주기는 app.js의 cron이 정한다.
 *
 * @param {{
 *   retakeWatchStore: { _loadRows: function },  // 시트 전체 행 로드
 *   slackClient: object,                        // app.client (chat.postMessage)
 *   watchChannels: Set<string>|undefined,       // 감시 대상 채널 필터
 * }} deps
 */
module.exports = function createRetakeReminderPoller({ retakeWatchStore, slackClient, watchChannels }) {

  // KST 기준 오늘 날짜 (YYYY-MM-DD) — registeredAt(_kstIsoNow)의 날짜부와 직접 비교
  function _todayKst(d = new Date()) {
    return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  }

  function _buildText(rows) {
    const head = `⏰ *[미제출 리테이크 알림]* 오늘 요청된 수정 건 중 아직 완료되지 않은 ${rows.length}건입니다. 제출 확인 부탁드립니다!`;
    const lines = rows.map(r => {
      const work  = cleanWorkName(r.workName) || "작품";
      const owner = r.ownerUserId ? `<@${r.ownerUserId}>` : "(소환자 미상)";
      return `• *${work} ${r.episode || "?"}화 [${r.operationName || "-"}]* — ${owner}`;
    });
    return `${head}\n${lines.join("\n")}`;
  }

  /**
   * 리마인더 1회 실행 — 오늘 등록된 미제출 watching 행을 채널별로 공지한다.
   */
  async function tick() {
    let rows;
    try {
      rows = await retakeWatchStore._loadRows();
    } catch (e) {
      console.error("[retake-reminder] 감시행 로드 실패:", e.message);
      return;
    }
    const today = _todayKst();
    const target = rows.filter(r =>
      r.status === "watching" &&
      (r.registeredAt || "").slice(0, 10) === today &&
      (!watchChannels || watchChannels.has(r.watchChannel))
    );
    if (!target.length) {
      console.log("[retake-reminder] 오늘 미제출 건 없음 — 공지 skip");
      return;
    }

    // 채널별 그룹 → 각 채널에 1건씩 요약 공지(스레드 아님, 채널 최상위 메시지)
    const byChannel = new Map();
    for (const r of target) {
      if (!byChannel.has(r.watchChannel)) byChannel.set(r.watchChannel, []);
      byChannel.get(r.watchChannel).push(r);
    }
    for (const [channel, chRows] of byChannel) {
      try {
        await slackClient.chat.postMessage({ channel, text: _buildText(chRows) });
        console.log(`[retake-reminder] 미제출 ${chRows.length}건 공지 발송 — ch:${channel}`);
      } catch (e) {
        console.error(`[retake-reminder] 공지 발송 실패 ch:${channel} — ${e.message}`);
      }
    }
  }

  return { tick, _buildText, _todayKst };
};
