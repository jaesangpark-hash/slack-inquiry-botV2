// 단일 책임: 작품을 확정짓는 UI 블록 조립 (후보 고르기 / 직접 입력 / PIVO ID 입력)
"use strict";

/**
 * 왜 모듈로 빼나 — 같은 모양("후보 N건 고르기", "작품명 직접 입력")을 라우터 여러 곳에서
 * 블록 리터럴로 베껴 쓰고 있었다. PIVO ID 입력 버튼을 **모든 자리에** 붙이려면 한 곳에서
 * 만들어야 빠뜨리지 않는다.
 *
 * PIVO ID 버튼이 늘 떠 있어야 하는 이유(재상 님 지정 2026-10-28): 제목 매칭은 1순위가 맞지만
 * 한일은 같은 제목이 여러 판본으로 갈리고 접두 표기도 달라 끝내 못 고르는 경우가 남는다.
 * 그때 사람이 PIVO ID 를 바로 때려넣을 구멍이 없으면 거기서 흐름이 끊긴다. 매칭이 성공했든
 * 후보가 떴든 아예 못 찾았든, 되돌릴 수단은 항상 보이게 둔다.
 */

const CANDIDATE_LABEL_MAX = 70;   // Slack 버튼 텍스트 상한 75자 — 여유를 둔다

const cut = (s, n) => {
  const t = String(s ?? "").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** 작품 한 건을 버튼 라벨로. 한국어 이름 → 일본어 표시명 → FIX 순으로 사람이 알아보는 걸 쓴다. */
function candidateLabel(row, index) {
  const name = row?.koreanProjectName || row?.japaneseDisplayTitle || row?.japaneseFixedTitle;
  return cut(name || `후보 ${index + 1}`, CANDIDATE_LABEL_MAX);
}

/**
 * PIVO ID 직접 입력 버튼. 모든 작품 확정 화면에 들어간다.
 *
 * action_id 를 인자로 받는 이유: 흐름마다 pending 객체 모양이 달라(문의 초안 / 스케줄 /
 * 리테이크) ID 를 풀고 난 뒤 할 일이 다르다. 한 모달로 묶으면 스케줄 소환에서 문의 초안이
 * 튀어나온다. 버튼 모양만 공유하고 뒤처리는 흐름이 각자 맡는다.
 *
 * @param {string} pendingId
 * @param {string} actionId
 * @returns {object} Slack button element
 */
function buildPivoIdButton(pendingId, actionId) {
  return {
    type: "button",
    action_id: actionId,
    text: { type: "plain_text", text: "PIVO ID 직접 입력" },
    value: pendingId,
  };
}

/**
 * 후보 여러 건 → 고르는 화면.
 * @param {{ candidates: Array<object>, pendingId: string, actionIdPrefix: string,
 *            pivoActionId?: string, max?: number }} args
 * @returns {Array<object>} Slack blocks
 */
function buildCandidateBlocks({ candidates, pendingId, actionIdPrefix, pivoActionId, max = 5 }) {
  const shown = (candidates || []).slice(0, max);
  return [
    { type: "section", text: { type: "mrkdwn", text: `*작품 후보 ${shown.length}건* — 해당하는 작품을 선택해줘.` } },
    {
      type: "actions",
      elements: [
        ...shown.map((row, i) => ({
          type: "button",
          action_id: `${actionIdPrefix}${i}`,
          text: { type: "plain_text", text: candidateLabel(row, i) },
          value: JSON.stringify({ pendingId, pivoId: row.pivoId, koreanProjectName: row.koreanProjectName }),
        })),
        ...(pivoActionId ? [buildPivoIdButton(pendingId, pivoActionId)] : []),
      ],
    },
  ];
}

/**
 * 후보가 너무 많거나 하나도 없을 때 → 직접 입력 화면.
 * @param {{ pendingId: string, manualActionId: string, pivoActionId?: string,
 *            titleHint?: string, manualLabel?: string }} args
 * @returns {Array<object>} Slack blocks
 */
function buildManualEntryBlocks({ pendingId, manualActionId, pivoActionId, titleHint = "", manualLabel = "작품명 직접 입력" }) {
  return [
    { type: "section", text: { type: "mrkdwn", text: `AI 추출 작품명: \`${titleHint || "없음"}\`` } },
    {
      type: "actions",
      elements: [
        { type: "button", action_id: manualActionId, text: { type: "plain_text", text: manualLabel }, style: "primary", value: pendingId },
        ...(pivoActionId ? [buildPivoIdButton(pendingId, pivoActionId)] : []),
      ],
    },
  ];
}

module.exports = { buildPivoIdButton, buildCandidateBlocks, buildManualEntryBlocks, candidateLabel, CANDIDATE_LABEL_MAX };
