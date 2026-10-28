// 단일 책임: 작품명 후보 점수화 (순수 함수, 외부 의존 없음)
//
// 왜 필요한가 — 기존 매칭은 양방향 부분일치(`a.includes(b) || b.includes(a)`) 뒤에 `find`로
// 첫 일치를 조용히 채택했다. 짧은 제목이 긴 제목을 무차별로 집어삼키고, 어느 쪽이 채택됐는지
// 사람 눈에 안 보인다. 「무쌍」이 「뇌법무쌍」·「무쌍여제」 둘 다에 걸리는 식.
//
// 실측 (2026-10-28, 중일 마스터 229건 × 한일 마스터 1,262건, 한국어 제목 기준):
//   길이비 가드 0.0(현재) → 교차 충돌 18쌍 / 0.5 → 2쌍 / 0.6 → 2쌍 / 0.7 → 2쌍
// 가드만 넣어도 16쌍이 사라진다. 남는 2쌍(「소드마스터로회귀」⊂「게임속소드마스터로회귀」,
// 「아포칼립스」⊂「강호아포칼립스」)은 사람이 골라야 하는 진짜 모호함이라 가드로 없앨 게 아니라
// 후보로 띄운다 — 그래서 이 모듈은 "하나를 고르는" 대신 "순위를 매긴" 목록을 돌려준다.
"use strict";

// 짧은쪽/긴쪽 길이비가 이 값 미만이면 부분일치로 쳐 주지 않는다.
const PARTIAL_MIN_RATIO = 0.6;

// 숫자가 클수록 신뢰도가 높다. 정렬에만 쓰이므로 외부에 의미를 노출할 필요는 없다.
//
// WEAK = 부분일치는 하는데 길이비가 모자란 것. **버리지 않고 후보로만 남긴다.**
// 가드에 걸린 걸 통째로 버려 봤더니(실측: 작품명 앞 2~4글자로 558회 조회) 543회가 "매칭 없음"이
// 되고 후보가 한 번도 안 떴다. 사람이 「환생」이라고 줄여 치는 걸 못 받으면 가드가 사고를 막는
// 대신 기능을 죽인다. WEAK 가 하나뿐이면 그대로 채택하고(모호하지 않다), 둘 이상이면 고르게 한다
// — 구 코드가 조용히 첫 번째를 집어 7.0%(39/558) 틀렸던 자리가 정확히 이 지점이다.
const TIER = Object.freeze({ EXACT: 4, PREFIX: 3, PARTIAL: 2, WEAK: 1, NONE: 0 });

/**
 * 정규화가 끝난 두 문자열을 비교해 일치 등급과 길이비를 돌려준다.
 * @param {string} needle 찾는 말 (정규화 완료)
 * @param {string} hay 시트 쪽 값 (정규화 완료)
 * @param {number} [minRatio]
 * @returns {{ tier: number, ratio: number }}
 */
function scoreTitle(needle, hay, minRatio = PARTIAL_MIN_RATIO) {
  if (!needle || !hay) return { tier: TIER.NONE, ratio: 0 };
  if (needle === hay) return { tier: TIER.EXACT, ratio: 1 };
  const [short, long] = needle.length <= hay.length ? [needle, hay] : [hay, needle];
  if (!long.includes(short)) return { tier: TIER.NONE, ratio: 0 };
  const ratio = short.length / long.length;
  // 길이비가 모자라면 자동 채택 자격만 잃는다(WEAK). 후보로는 살아남는다.
  if (ratio < minRatio) return { tier: TIER.WEAK, ratio };
  return { tier: long.startsWith(short) ? TIER.PREFIX : TIER.PARTIAL, ratio };
}

/**
 * 행 목록을 필드별로 훑어 점수 매긴 뒤 높은 순으로 돌려준다.
 *
 * 필드는 **앞에 올수록 신뢰도가 높다**(기존 1~6순위를 그대로 옮긴 것). 등급이 같으면
 * 앞 필드가 이기고, 그것도 같으면 길이비가 높은 쪽이 이긴다. 한 행이 여러 필드에 걸리면
 * 가장 좋은 점수 하나만 남긴다 — 같은 작품이 후보 목록에 두 번 뜨면 안 된다.
 *
 *
 * @param {Array<object>} rows
 * @param {Array<{ name: string, needles: Array<string|null>, get: function(object): string }>} fields
 * @param {{ minRatio?: number }} [options]
 * @returns {Array<{ row: object, tier: number, ratio: number, fieldIndex: number, field: string, needle: string }>}
 */
function rankRows(rows, fields, { minRatio = PARTIAL_MIN_RATIO } = {}) {
  const best = new Map();   // row → 점수 기록
  fields.forEach((field, fieldIndex) => {
    const needles = (field.needles || []).filter(Boolean);
    if (!needles.length) return;
    for (const row of rows) {
      const hay = field.get(row);
      if (!hay) continue;
      for (const needle of needles) {
        const { tier, ratio } = scoreTitle(needle, hay, minRatio);
        if (tier === TIER.NONE) continue;
        const hit = { row, tier, ratio, fieldIndex, field: field.name, needle };
        const prev = best.get(row);
        if (!prev || compareHits(hit, prev) < 0) best.set(row, hit);
      }
    }
  });
  // fieldIndex 는 그대로 둔다 — decide()가 동점 판정에 다시 쓰고, 실패 진단 로그에도 필요하다.
  return [...best.values()].sort(compareHits);
}

// 정렬 비교자 — 음수면 a가 앞(더 좋음).
function compareHits(a, b) {
  if (a.tier !== b.tier) return b.tier - a.tier;
  if (a.fieldIndex !== b.fieldIndex) return a.fieldIndex - b.fieldIndex;
  return b.ratio - a.ratio;
}

/**
 * 순위 목록을 "자동 채택 / 사람이 고를 후보 / 없음"으로 가른다.
 *
 * 1등이 2등보다 **엄격히** 좋을 때만 자동 채택한다. 동점이면 고르게 한다 —
 * 조용히 하나를 집어서 틀린 작품을 내놓는 쪽이 되묻는 것보다 나쁘다.
 *
 * @param {Array<object>} ranked rankRows 결과
 * @param {{ candidateMax?: number }} [options]
 * @returns {{ single: object }|{ multiple: Array<object> }|{ tooMany: true }|null}
 */
function decide(ranked, { candidateMax = 5 } = {}) {
  if (!ranked.length) return null;
  const top = ranked[0];
  // WEAK 끼리는 길이비로 우열을 가리지 않는다. 「환생」이 「환생권신」(0.50)과
  // 「환생 황녀의 화려한 복수」(0.22) 둘 다에 걸릴 때 짧은 쪽을 집을 근거가 없다 —
  // 길이비가 높다는 건 "더 맞다"가 아니라 "제목이 짧다"는 뜻일 뿐이다. 전부 후보로 올린다.
  const isTop = top.tier === TIER.WEAK
    ? hit => hit.tier === TIER.WEAK
    : hit => compareHits(hit, top) === 0;
  const tied = ranked.filter(isTop).map(hit => hit.row);
  if (tied.length === 1) return { single: tied[0] };
  if (tied.length > candidateMax) return { tooMany: true };
  return { multiple: tied };
}

module.exports = { scoreTitle, rankRows, decide, compareHits, PARTIAL_MIN_RATIO, TIER };
