// 단일 책임: 「리테이크 감시」 행을 폴링해 완료 시 납품 스레드에 답글 알림한다
"use strict";

/**
 * 리테이크 감시 폴러 (DI 팩토리)
 *
 * tick(): loadWatching → 각 judgeTaskUuid GET /api/v1/tasks/{uuid} → 상태 판정
 *   - state==="COMPLETED" → 납품검수 링크 붙여 납품 스레드(watchChannel/watchThreadTs)에 답글 → notified
 *   - state==="DROP"      → dropped(닫음)
 *   - 등록 후 14일 경과 미완료 → expired
 *   - 그 외(PROCESSING 등)  → watching 유지(무발송)
 *
 * 멱등·재시도: 답글 postMessage 성공 후에만 notified 마킹한다(실패 시 watching 유지 → 다음 tick 재시도).
 * 행별 try/catch로 한 행 실패가 다른 행을 막지 않는다.
 *
 * @param {{
 *   retakeWatchStore: { loadWatching: function, markStatus: function },
 *   slackClient: object,          // app.client (chat.postMessage)
 *   apiFetch: function,           // retakeFlow._apiFetch 재사용 (url, options, meta) => json
 *   base: function,               // () => PLATFORM_API_URL
 *   token: function,              // () => PLATFORM_API_TOKEN
 * }} deps
 */

// 등록 후 이 일수를 넘겨도 미완료면 만료 처리 (n8n 리테이크 완료체크 워크플로우와 동일 — 코드 상수, 비밀 아님)
const EXPIRY_DAYS = 14;
// 납품검수(OTC0087) 편집기 링크 베이스
const EDITOR_LINK_BASE = "https://main.totus.pro/ko/editor?uuid=";
const DELIVERY_REVIEW_OP_CODE = "OTC0087";

module.exports = function createRetakeWatchPoller({ retakeWatchStore, slackClient, apiFetch, base, token }) {
  const BASE  = base  || (() => process.env.PLATFORM_API_URL);
  const TOKEN = token || (() => process.env.PLATFORM_API_TOKEN);

  function _authHeaders() {
    return { headers: { Authorization: `Bearer ${TOKEN()}` } };
  }

  // GET /api/v1/tasks/{uuid} — 판정대상 태스크 단건 조회
  async function _getTask(taskUuid) {
    const json = await apiFetch(
      `${BASE()}/api/v1/tasks/${taskUuid}`,
      _authHeaders(),
      { bot: "retake-watch", endpoint: "/tasks/{uuid}", params: {}, expectedCount: 1 }
    );
    if (!json || !json.success) return null;
    return json.data || null;
  }

  // 납품검수(OTC0087) 링크 해석 — jobUuid의 OTC0087 태스크 중 리테이크여부=true & 생성일 최신
  async function _resolveDeliveryReviewLink(jobUuid) {
    if (!jobUuid) return null;
    try {
      const json = await apiFetch(
        `${BASE()}/api/v1/tasks?jobUuids=${encodeURIComponent(jobUuid)}&operationTypeCode=${DELIVERY_REVIEW_OP_CODE}&size=100`,
        _authHeaders(),
        { bot: "retake-watch", endpoint: "/tasks", params: { operationTypeCode: DELIVERY_REVIEW_OP_CODE } }
      );
      const list = Array.isArray(json?.data) ? json.data : [];
      const retakes = list.filter(t => t?.리테이크여부 === true);
      if (!retakes.length) return null;
      // 생성일 최신 1건 선택 (파싱 실패 시 0으로 취급)
      retakes.sort((a, b) => (Date.parse(b?.생성일) || 0) - (Date.parse(a?.생성일) || 0));
      const target = retakes[0];
      const uuid = target?.taskUuid || target?.uuid || null;
      return uuid ? `${EDITOR_LINK_BASE}${uuid}` : null;
    } catch (e) {
      console.error("[retake-watch] 납품검수 링크 조회 실패:", e.message);
      return null;
    }
  }

  // 등록 후 EXPIRY_DAYS 경과 여부 (registeredAt 파싱 실패 시 만료로 오판하지 않음)
  function _isExpired(registeredAt) {
    const regMs = Date.parse(registeredAt);
    if (Number.isNaN(regMs)) return false;
    return Date.now() - regMs > EXPIRY_DAYS * 24 * 3600 * 1000;
  }

  function _buildCompletionText(row, reviewLink) {
    const head = `✅ *${row.workName || "작품"} ${row.episode || "?"}화 [${row.operationName || "-"}]* 리테이크 수정이 완료됐어.`;
    const linkLine = reviewLink
      ? `🔗 납품검수: ${reviewLink}`
      : "🔗 납품검수 링크를 찾지 못했어. Totus에서 직접 확인해줘.";
    return `${head}\n${linkLine}`;
  }

  // 감시행 1건 처리
  async function _processRow(row) {
    const task = await _getTask(row.judgeTaskUuid);
    // 게이트웨이 단건 조회(GET /tasks/{uuid}) 응답은 키가 한글(상태). 값은 COMPLETED·DROP 등 영문 그대로.
    const state = task?.["상태"] || null;

    if (state === "COMPLETED") {
      const reviewLink = await _resolveDeliveryReviewLink(row.jobUuid);
      // 답글 성공 후에만 notified 마킹 (멱등·재시도 안전)
      await slackClient.chat.postMessage({
        channel: row.watchChannel,
        thread_ts: row.watchThreadTs,
        text: _buildCompletionText(row, reviewLink),
      });
      await retakeWatchStore.markStatus(row.rowIndex, "notified", {
        notifiedAt: new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }),
        note: reviewLink ? "" : "납품검수 링크 미해석",
      });
      console.log(`[retake-watch] 완료 알림 발송 — row:${row.rowIndex} ${row.workName} ${row.episode}화`);
      return;
    }

    if (state === "DROP") {
      await retakeWatchStore.markStatus(row.rowIndex, "dropped", { note: "태스크 DROP" });
      console.log(`[retake-watch] DROP 감지 → dropped — row:${row.rowIndex}`);
      return;
    }

    // 미완료 상태에서 14일 컷오프
    if (_isExpired(row.registeredAt)) {
      await retakeWatchStore.markStatus(row.rowIndex, "expired", { note: `${EXPIRY_DAYS}일 경과 미완료` });
      console.log(`[retake-watch] 14일 컷오프 → expired — row:${row.rowIndex}`);
      return;
    }

    // PROCESSING 등 → 유지(무발송)
  }

  /**
   * 폴러 1회 실행 — watching 행 전체를 순회 처리한다.
   */
  async function tick() {
    let rows;
    try {
      rows = await retakeWatchStore.loadWatching();
    } catch (e) {
      console.error("[retake-watch] 감시행 로드 실패:", e.message);
      return;
    }
    if (!rows.length) return;
    console.log(`[retake-watch] tick — watching ${rows.length}건`);
    for (const row of rows) {
      try {
        await _processRow(row);
      } catch (e) {
        // 실패 시 해당 행은 watching 유지 → 다음 tick 재시도
        console.error(`[retake-watch] 행 처리 실패(watching 유지) row:${row.rowIndex} judgeTaskUuid:${row.judgeTaskUuid} — ${e.message}`);
      }
    }
  }

  return { tick, _processRow, _resolveDeliveryReviewLink, _isExpired };
};
