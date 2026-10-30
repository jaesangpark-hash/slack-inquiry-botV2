"use strict";
/**
 * 한일 작품명 블록 — 회귀 시험 (지시 2026-10-29)
 *
 * 한일은 **작품명 = 원제(한국어)** 이고 그게 작업자가 부르는 이름이다.
 * 고객사와 쓰는 건 일본어 쪽이고 **FIX 먼저, 없으면 仮** 이다.
 *
 * 틀려도 전송은 성공하고, APM 이 고객사에 엉뚱한 이름을 쓰고 나서야 드러난다 — 시험으로 묶는다.
 * 샘플은 한일_master 실측 행에서 가져왔다(2026-10-29 · 1,300행).
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const createInquiryBlocks = require("../inquiry-blocks");

const blocks = createInquiryBlocks({
  pmSlackIdFor: () => "U_PM",
  mentionUserIdsFor: () => ["U_APM"],
});

const titleField = (fields) =>
  blocks.buildFinalMainMessage({ submitterId: "U1", ...fields }).blocks[2].fields[0].text;

describe("한일 작품명 블록", () => {
  test("FIX 가 있으면 고객사용은 FIX — 작품명 자리는 원제(한국어) 그대로", () => {
    const text = titleField({
      langPair: "ko-ja",
      workName: "피폐물 주인공의 부인이 되었습니다",
      workNameJaFixed: "冷血皇子と捨てられた王女",
      workNameJaDisplay: "冷血皇子と捨てられた王女",
      workNameZh: "피폐물 주인공의 부인이 되었습니다",
    });
    assert.match(text, /\*작품명\*\n피폐물 주인공의 부인이 되었습니다/);
    assert.match(text, /고객사용: 冷血皇子と捨てられた王女 \(FIX\)/);
  });

  // ★실측 43건이 이 경우다. 仮 를 안 내보내면 고객사용 이름이 통째로 빠진다.
  test("FIX 가 없으면 가제로 내려가고 (仮) 로 표시한다", () => {
    const text = titleField({
      langPair: "ko-ja",
      workName: "타임 트래블러",
      workNameJaFixed: "",
      workNameJaDisplay: "タイムトラベラー",
      workNameZh: "타임 트래블러",
    });
    assert.match(text, /고객사용: タイムトラベラー \(仮\)/);
    assert.ok(!text.includes("FIX"), "FIX 가 없는데 FIX 로 표시됐다");
  });

  test("둘 다 없으면 줄을 안 낸다 — 빈 라벨만 남지 않게", () => {
    const text = titleField({
      langPair: "ko-ja",
      workName: "거울 속의 이방인",
      workNameJaFixed: "", workNameJaDisplay: "",
      workNameZh: "거울 속의 이방인",
    });
    assert.equal(text, "*작품명*\n거울 속의 이방인");
  });

  // 한일은 원제 칸(F열)과 작품명이 같은 값이라 原題 줄은 중복이다.
  test("한일에는 原題 줄을 내지 않는다", () => {
    const text = titleField({
      langPair: "ko-ja",
      workName: "검은 거울 (BL)",
      workNameJaFixed: "黒い鏡",
      workNameJaDisplay: "黒い鏡",
      workNameZh: "검은 거울 (BL)",
    });
    assert.ok(!text.includes("原題"), text);
  });
});

describe("중일 작품명 블록 — 한일 변경에 영향받지 않는다", () => {
  test("FIX 와 原題(중국어) 를 종전대로 낸다", () => {
    const text = titleField({
      langPair: "zh-ja",
      workName: "아비스",
      workNameJaFixed: "アビス",
      workNameJaDisplay: "アビス",
      workNameZh: "深渊",
    });
    assert.match(text, /FIX: アビス/);
    assert.match(text, /原題: 深渊/);
    assert.ok(!text.includes("고객사용"), "중일에 한일 표기가 샜다");
  });

  test("언어를 모르면 종전(중일) 표기 — 직접 입력 건이 여기로 온다", () => {
    const text = titleField({
      workName: "아비스",
      workNameJaFixed: "アビス",
      workNameZh: "深渊",
    });
    assert.match(text, /FIX: アビス/);
    assert.match(text, /原題: 深渊/);
  });
});
