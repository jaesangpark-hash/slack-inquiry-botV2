"use strict";
/**
 * sheets/title-score.js 단위 테스트
 *
 * node:test + node:assert 빌트인 사용 (신규 dep 추가 금지).
 * 순수 함수라 DI 없음 — 정규화가 끝난 문자열이 들어온다는 전제로 검증한다.
 *
 * 검증 항목:
 *   scoreTitle:
 *     - 완전일치 → EXACT
 *     - 접두일치 → PREFIX (부분일치보다 높다)
 *     - 중간 포함 → PARTIAL
 *     - 길이비 미달 → NONE (가드의 존재 이유)
 *     - 방향 무관 (needle 이 길든 짧든 같은 판정)
 *     - 빈 문자열 → NONE
 *   rankRows:
 *     - 등급 우선 정렬
 *     - 등급이 같으면 앞 필드 우선
 *     - 한 행이 여러 필드에 걸려도 한 번만 등장
 *     - needle 이 없는 필드는 건너뜀
 *   decide:
 *     - 1등이 유일 → single
 *     - 동점 → multiple
 *     - 동점이 상한 초과 → tooMany
 *     - 빈 목록 → null
 *   실데이터 회귀:
 *     - 「무쌍」류 짧은 제목이 긴 제목을 집어삼키지 않는다
 *     - 실측 교차 충돌 쌍이 가드에 걸린다
 *
 * fixture self-fulfilling 금지:
 *   기대값을 입력에서 베껴 오지 않고, 2026-10-28 실측에서 실제로 충돌했던 제목쌍을 그대로 쓴다.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { scoreTitle, rankRows, decide, TIER, PARTIAL_MIN_RATIO } = require("../title-score");

describe("scoreTitle", () => {
  test("완전일치는 EXACT", () => {
    assert.deepEqual(scoreTitle("무쌍여제", "무쌍여제"), { tier: TIER.EXACT, ratio: 1 });
  });

  test("접두일치는 PREFIX, 가드 미달은 WEAK — 등급으로 갈린다", () => {
    const prefix = scoreTitle("아포칼립스", "아포칼립스생존기");          // 5/8 = 0.625
    const middle = scoreTitle("아포칼립스", "강호아포칼립스대전");        // 5/10 = 0.5 → 가드 미달
    assert.equal(prefix.tier, TIER.PREFIX);
    assert.equal(middle.tier, TIER.WEAK);
    assert.ok(prefix.tier > middle.tier);
  });

  test("가드를 넘는 중간 포함은 PARTIAL", () => {
    const hit = scoreTitle("소드마스터로회귀", "게임속소드마스터로회귀"); // 8/11 ≈ 0.73
    assert.equal(hit.tier, TIER.PARTIAL);
    assert.ok(hit.ratio > PARTIAL_MIN_RATIO);
  });

  test("길이비가 모자라면 WEAK — 자동 채택 자격만 잃고 후보로는 남는다", () => {
    const hit = scoreTitle("무쌍", "뇌법무쌍");                            // 2/4 = 0.5
    assert.equal(hit.tier, TIER.WEAK);
    assert.ok(hit.tier > TIER.NONE, "버리지 않는다 — 버리면 줄여 친 입력을 아예 못 받는다");
    assert.equal(hit.ratio, 0.5, "진단용 ratio 는 남아 있어야 한다");
  });

  test("needle 이 길어도 같은 판정 — 방향에 좌우되지 않는다", () => {
    assert.deepEqual(scoreTitle("뇌법무쌍", "무쌍"), scoreTitle("무쌍", "뇌법무쌍"));
  });

  test("빈 값은 NONE", () => {
    assert.equal(scoreTitle("", "무쌍여제").tier, TIER.NONE);
    assert.equal(scoreTitle("무쌍여제", "").tier, TIER.NONE);
  });

  test("minRatio 를 낮추면 종전처럼 걸린다 — 가드가 실제로 동작함을 반증", () => {
    assert.equal(scoreTitle("무쌍", "뇌법무쌍", 0).tier, TIER.PARTIAL);
  });
});

// 필드 우선순위를 가진 행 목록 — 실제 매처가 넘기는 모양과 같게 구성
const fieldsFor = (titleKo, titleJa) => [
  { name: "ko", needles: [titleKo], get: row => row.ko },
  { name: "ja", needles: [titleJa], get: row => row.ja },
];

describe("rankRows", () => {
  const rows = [
    { id: "A", ko: "무쌍여제", ja: "むそうじょてい" },
    { id: "B", ko: "뇌법무쌍", ja: "らいほうむそう" },
    { id: "C", ko: "무쌍여제외전", ja: "" },
  ];

  test("완전일치가 부분일치보다 앞", () => {
    const ranked = rankRows(rows, fieldsFor("무쌍여제", null));
    assert.equal(ranked[0].row.id, "A");
    assert.equal(ranked[0].tier, TIER.EXACT);
    assert.equal(ranked[1].row.id, "C", "접두일치 6→4 (0.67) 는 가드를 넘어 남는다");
    assert.equal(ranked.length, 2, "「뇌법무쌍」은 길이비 0.5 라 탈락");
  });

  test("등급이 같으면 앞 필드가 이긴다", () => {
    const sameTier = [
      { id: "ja-hit", ko: "전혀다른제목", ja: "むそうじょてい" },
      { id: "ko-hit", ko: "무쌍여제", ja: "" },
    ];
    const ranked = rankRows(sameTier, fieldsFor("무쌍여제", "むそうじょてい"));
    assert.equal(ranked[0].row.id, "ko-hit");
    assert.equal(ranked[0].field, "ko");
  });

  test("한 행이 두 필드에 걸려도 한 번만 등장한다", () => {
    const both = [{ id: "X", ko: "무쌍여제", ja: "무쌍여제" }];
    const ranked = rankRows(both, fieldsFor("무쌍여제", "무쌍여제"));
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].field, "ko", "더 신뢰도 높은 필드 쪽 점수가 남는다");
  });

  test("needle 이 없는 필드는 건너뛴다", () => {
    const ranked = rankRows(rows, fieldsFor(null, null));
    assert.deepEqual(ranked, []);
  });
});

describe("decide", () => {
  const hit = (id, tier, fieldIndex = 0, ratio = 1) =>
    ({ row: { id }, tier, fieldIndex, ratio, field: "ko", needle: "n" });

  test("1등이 유일하면 single", () => {
    const out = decide([hit("A", TIER.EXACT), hit("B", TIER.PARTIAL, 0, 0.7)]);
    assert.deepEqual(out, { single: { id: "A" } });
  });

  test("동점이면 고르게 한다 — 조용히 하나를 집지 않는다", () => {
    const out = decide([hit("A", TIER.PARTIAL, 0, 0.7), hit("B", TIER.PARTIAL, 0, 0.7)]);
    assert.deepEqual(out, { multiple: [{ id: "A" }, { id: "B" }] });
  });

  test("동점이 상한을 넘으면 tooMany", () => {
    const many = ["A", "B", "C", "D", "E", "F"].map(id => hit(id, TIER.PARTIAL, 0, 0.7));
    assert.deepEqual(decide(many, { candidateMax: 5 }), { tooMany: true });
  });

  test("빈 목록은 null", () => {
    assert.equal(decide([]), null);
  });
});

describe("실측 회귀 — 2026-10-28 중일×한일 교차 충돌", () => {
  // 가드 0 에서 실제로 붙었던 쌍들. 길이비가 높은 둘은 PARTIAL 로 살아남고,
  // 나머지는 WEAK 로 내려간다. 어느 쪽이든 **자동 채택은 안 되고** 후보로 간다.
  const PAIRS = [
    ["소드마스터로회귀", "게임속소드마스터로회귀", TIER.PARTIAL],
    ["아포칼립스", "강호아포칼립스", TIER.PARTIAL],
    ["무쌍", "뇌법무쌍", TIER.WEAK],
    ["무쌍", "무쌍여제", TIER.WEAK],
    ["소설속엑스트라", "소설속엑스트라엄마의인생역전기", TIER.WEAK],
    ["아포칼립스", "빙하기아포칼립스의회사원", TIER.WEAK],
  ];

  for (const [a, b, tier] of PAIRS) {
    test(`${a} ⊂ ${b} → ${tier === TIER.PARTIAL ? "PARTIAL" : "WEAK"}`, () => {
      assert.equal(scoreTitle(a, b).tier, tier);
    });
  }

  test("같은 등급에서 충돌하면 자동 채택하지 않고 고르게 한다", () => {
    // 「환생」 한 마디에 여러 작품이 전부 WEAK 로 걸리는 실제 상황.
    // 구 코드는 여기서 시트 순서상 첫 번째를 조용히 집어 틀렸다(실측 39/558).
    const rows = [
      { id: "a", ko: "환생권신" },
      { id: "b", ko: "환생황녀의화려한복수" },
      { id: "c", ko: "환생했더니망한마을촌장입니다" },
    ];
    const out = decide(rankRows(rows, [{ name: "ko", needles: ["환생"], get: r => r.ko }]));
    assert.ok(out.multiple, "제목이 짧다는 이유로 하나를 집으면 안 된다");
    assert.equal(out.multiple.length, 3);
  });

  test("한쪽이 확연히 가까우면 그쪽으로 확정한다 — 등급 차이는 근거가 된다", () => {
    // 「아포칼립스」가 중일·한일 작품에 동시에 걸리지만 길이비가 0.71 대 0.42 로 벌어진다.
    // 0.6 가드를 넘은 쪽은 제목 거의 전체가 일치한 것이라 WEAK 조각과 동급으로 두지 않는다.
    const rows = [
      { id: "zh", ko: "강호아포칼립스" },               // 0.71 → PARTIAL
      { id: "kj", ko: "빙하기아포칼립스의회사원" },      // 0.42 → WEAK
    ];
    const ranked = rankRows(rows, [{ name: "ko", needles: ["아포칼립스"], get: r => r.ko }]);
    assert.equal(ranked[0].tier, TIER.PARTIAL);
    assert.equal(ranked[1].tier, TIER.WEAK);
    assert.equal(decide(ranked).single.id, "zh");
  });

  test("걸리는 작품이 하나뿐이면 그대로 채택한다 — 모호하지 않으니 되묻지 않는다", () => {
    const rows = [{ id: "only", ko: "빙하기아포칼립스의회사원" }];
    const out = decide(rankRows(rows, [{ name: "ko", needles: ["아포칼립스"], get: r => r.ko }]));
    assert.deepEqual(out, { single: { id: "only", ko: "빙하기아포칼립스의회사원" } });
  });
});
