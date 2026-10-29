// 단일 책임: 언어쌍별 출력 목적지(고정 채널)·수신자(멘션)를 한 표로 들고 되돌려 준다
"use strict";

/**
 * 왜 있는가 — 한일 경로는 2026-10-28 에 운영에 올라갔지만 아직 실사용 검증 전이다.
 * 검증이 끝날 때까지 한일 소환 결과가 중일 운영 채널에 섞이면 안 되고(재상 님 지시 1),
 * 중일/한일 담당 APM 이 달라 알림 수신자도 갈라야 한다(지시 2).
 *
 * 분기를 코드에 흩뿌리지 않고 **언어쌍 → 목적지** 표 하나로 둔다(가이드 R7).
 * 새 언어쌍이 생기면 overrides 에 한 줄 추가하면 된다.
 *
 * ★미설정 = 종전과 동일. KOJA_* env 를 안 넣으면 한일도 지금처럼 공통 채널·공통 수신자로 간다.
 *   코드 리터럴 기본값은 두지 않는다(R5) — 폴백 대상은 언제나 "운영자가 이미 설정한 공통값"이다.
 */

/** 고정 채널 목적지 3종. 작업자 채널·원문 채널 답글은 작품이 정하므로 여기 없다. */
const DESTINATIONS = Object.freeze(["target", "pmRequest", "schedule"]);

/** 언어쌍 표시명 — 로그·안내문에서 사람이 읽는 이름. */
const LANG_LABELS = Object.freeze({ "zh-ja": "중일", "ko-ja": "한일" });

function nonEmpty(value) {
  if (Array.isArray(value)) return value.length ? value : null;
  const trimmed = String(value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * @param {object} args
 * @param {{ target: string, pmRequest: string, schedule: string,
 *           mentionUserIds: string[], pmSlackId: string }} args.base
 *        공통값 = 종전 동작(중일 기준). 전부 기존 필수 env 라 guard 가 이미 보장한다.
 * @param {Record<string, Partial<typeof args.base>>} [args.overrides]
 *        언어쌍별 덮어쓰기. 값이 비어 있으면 "미설정"으로 보고 base 를 쓴다.
 * @returns {{ channelFor: Function, mentionUserIdsFor: Function, pmSlackIdFor: Function,
 *             isOverridden: Function, describe: Function }}
 */
function createLangRouting({ base, overrides = {} }) {
  for (const kind of DESTINATIONS) {
    if (!nonEmpty(base?.[kind])) {
      throw new Error(`[lang-routing] 공통 목적지 '${kind}' 가 비어 있다 — env guard 를 먼저 통과시켜야 한다.`);
    }
  }

  // 표를 미리 평탄화해 둔다. 조회 때마다 폴백을 계산하면 규칙이 호출부로 샌다.
  const table = new Map();
  for (const [langPair, override] of Object.entries(overrides)) {
    const resolved = {};
    for (const kind of DESTINATIONS) resolved[kind] = nonEmpty(override?.[kind]) || base[kind];
    resolved.mentionUserIds = nonEmpty(override?.mentionUserIds) || base.mentionUserIds;
    resolved.pmSlackId      = nonEmpty(override?.pmSlackId)      || base.pmSlackId;
    // 어느 항목이 실제로 갈라졌는지 — 부팅 로그에 그대로 찍는다.
    resolved.overridden = [...DESTINATIONS, "mentionUserIds", "pmSlackId"]
      .filter(key => nonEmpty(override?.[key]));
    table.set(langPair, resolved);
  }

  const rowFor = (langPair) => table.get(langPair) || null;

  return {
    /**
     * @param {"target"|"pmRequest"|"schedule"} kind
     * @param {string|null} langPair — 모르면 null. null 은 공통값(= 종전 동작)이다.
     */
    channelFor(kind, langPair) {
      if (!DESTINATIONS.includes(kind)) throw new Error(`[lang-routing] 알 수 없는 목적지: ${kind}`);
      return rowFor(langPair)?.[kind] || base[kind];
    },
    /** @returns {string[]} 고정 멘션 수신자 */
    mentionUserIdsFor(langPair) {
      return rowFor(langPair)?.mentionUserIds || base.mentionUserIds;
    },
    pmSlackIdFor(langPair) {
      return rowFor(langPair)?.pmSlackId || base.pmSlackId;
    },
    /** 그 언어쌍이 공통값과 갈라져 있나 — 안내문에 「테스트 채널로 보냈다」를 붙일지 판단용 */
    isOverridden(langPair, kind = null) {
      const row = rowFor(langPair);
      if (!row) return false;
      return kind ? row.overridden.includes(kind) : row.overridden.length > 0;
    },
    /** 부팅 로그 한 줄 — 무엇이 어디로 가는지 눈으로 확인하려고 */
    describe() {
      const lines = [];
      for (const [langPair, row] of table) {
        const label = LANG_LABELS[langPair] || langPair;
        lines.push(row.overridden.length
          ? `${label}(${langPair}) 분리: ${row.overridden.join(", ")}`
          : `${label}(${langPair}) 분리 없음 — 공통값 사용`);
      }
      return lines.length ? lines.join(" | ") : "분리 설정 없음 — 전 언어 공통값";
    },
  };
}

module.exports = { createLangRouting, DESTINATIONS, LANG_LABELS };
