"use strict";
/**
 * sheets/delivery-date.js — 한일(ko-ja) 납품 탭 선택·접두 처리 단위 테스트
 *
 * node:test + node:assert 빌트인 사용 (신규 dep 추가 금지).
 * factory DI — fake sheetsClient 가 range 별로 다른 행을 돌려줘 중일/한일 두 탭을 흉내낸다.
 *
 * 검증 항목 (AIA 리뷰 T1·T2·T4):
 *   T1 lang="ko-ja" → 한일 탭을 읽는다
 *   T2 lang 생략·"zh-ja" → 중일 탭을 읽는다 (기존 동작 불변)
 *   T4 한일 탭 B열 "[카카오픽코마] 신과 함께 레벨업" 이 "신과 함께 레벨업" 질의와 **완전일치**
 *      - 접두를 떼지 않으면 부분일치로만 걸린다 → 점수제 도입 시 길이비 0.54 로 떨어진다
 *   접두 제거는 한일에만 적용 (중일 작품명에 괄호가 들어가도 안 깎인다)
 *   접두 제거가 다른 작품을 끌어오지 않는다
 *
 * fixture self-fulfilling 금지:
 *   실제 시트 표기(2026-10-28 실측 — 한일 B열은 "[카카오픽코마] …", 중일 B열은 접두 없음)를
 *   그대로 깔고, 기대값은 "어느 탭을 읽었는가"로 판정한다.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const createDeliveryDateService = require("../delivery-date");

const ZH_RANGE = "납품관리시트_Japan(중일 V5)!A:G";
const KO_RANGE = "납품관리시트_Japan(한일 V5)!A:G";

const row = (workName, episode, deliveryDate, pm = "PM1", apm = "APM1") =>
  ["A1", workName, pm, apm, String(episode), "F열", deliveryDate];

// range 로 탭을 가려 서로 다른 행을 준다. 어느 탭을 읽었는지가 그대로 결과에 드러난다.
function makeService({ zh = [], ko = [] } = {}) {
  const reads = [];
  const sheetsClient = {
    getValues: async (_id, range) => {
      reads.push(range);
      const rows = range.includes("한일") ? ko : zh;
      return [["header"], ...rows];
    },
  };
  const svc = createDeliveryDateService({
    google: {}, getGoogleAuth: () => {},
    deliverySheetId: "delivery-sheet",
    deliverySheetZhJa: ZH_RANGE,
    deliverySheetKoJa: KO_RANGE,
    alertOnError: async (_l, fn) => fn(),
    sheetsClient,
  });
  return { svc, reads };
}

const FIXTURE = {
  // 중일 탭 — 접두 없음
  zh: [row("소돔의 밤", 1, "2026-08-04", "박재상", "서주원")],
  // 한일 탭 — 고객사 접두가 붙어 있다
  ko: [
    row("[카카오픽코마] 신과 함께 레벨업", 145, "2026-03-06", "Violette Jung", "서주원"),
    row("[카카오픽코마] 회귀자 사용설명서", 169, "2026-05-01"),
  ],
};

describe("납품 탭 선택 (T1·T2)", () => {
  test("T1 lang=ko-ja → 한일 탭을 읽고 한일 납품일이 나온다", async () => {
    const { svc, reads } = makeService(FIXTURE);
    const r = await svc.fetchDeliveryDate("신과 함께 레벨업", "145", "ko-ja", "신과 함께 레벨업");
    assert.equal(reads.length, 1);
    assert.match(reads[0], /한일/);
    assert.equal(r.deliveryDate, "2026-03-06");
    assert.equal(r.pm, "Violette Jung");
    assert.equal(r.apm, "서주원");
  });

  test("T2 lang=zh-ja → 중일 탭 (기존 동작 불변)", async () => {
    const { svc, reads } = makeService(FIXTURE);
    const r = await svc.fetchDeliveryDate("소돔의 밤", "1", "zh-ja", "소돔의 밤");
    assert.match(reads[0], /중일/);
    assert.equal(r.deliveryDate, "2026-08-04");
  });

  test("T2 lang 생략 → 중일 탭 (기본값)", async () => {
    const { svc, reads } = makeService(FIXTURE);
    await svc.fetchDeliveryDate("소돔의 밤", "1");
    assert.match(reads[0], /중일/);
  });

  test("한일 작품을 중일 탭에서 찾으면 확인 불가 — 고치기 전 증상", async () => {
    const { svc } = makeService(FIXTURE);
    const r = await svc.fetchDeliveryDate("신과 함께 레벨업", "145", "zh-ja", "신과 함께 레벨업");
    assert.equal(r.deliveryDate, "확인 불가");
    assert.equal(r.pm, "");
  });
});

describe("고객사 접두 처리 (T4)", () => {
  test("T4 접두 없는 질의가 접두 붙은 한일 행과 완전일치한다", async () => {
    const { svc } = makeService(FIXTURE);
    const r = await svc.fetchDeliveryDate("신과 함께 레벨업", "145", "ko-ja", null);
    assert.equal(r.deliveryDate, "2026-03-06");
    assert.equal(r.workName, "[카카오픽코마] 신과 함께 레벨업", "시트 표기 그대로 돌려준다");
  });

  test("접두를 붙여 물어도 걸린다 — 마스터 G열 표기로 들어오는 경우", async () => {
    const { svc } = makeService(FIXTURE);
    const r = await svc.fetchDeliveryDate("[카카오픽코마] 신과 함께 레벨업", "145", "ko-ja", null);
    assert.equal(r.deliveryDate, "2026-03-06");
  });

  test("접두 제거가 다른 작품을 끌어오지 않는다", async () => {
    const { svc } = makeService(FIXTURE);
    const r = await svc.fetchDeliveryDate("회귀자 사용설명서", "145", "ko-ja", null);
    assert.equal(r.deliveryDate, "확인 불가", "169화만 있는 작품이라 145화는 없다");
  });

  test("접두 제거는 중일 탭에 적용하지 않는다", async () => {
    // 중일에 괄호로 시작하는 제목이 있어도 앞부분이 깎이면 안 된다
    const { svc } = makeService({ zh: [row("[외전] 소돔의 밤", 1, "2026-09-09")], ko: [] });
    const hit = await svc.fetchDeliveryDate("[외전] 소돔의 밤", "1", "zh-ja", null);
    assert.equal(hit.deliveryDate, "2026-09-09", "시트 표기 그대로 물으면 걸린다");
  });
});
