"use strict";
/**
 * slack/work-picker-blocks.js 단위 테스트
 *
 * node:test + node:assert 빌트인 사용 (신규 dep 추가 금지).
 * 순수 블록 조립 함수라 DI 없음.
 *
 * 검증 항목:
 *   buildCandidateBlocks:
 *     - 후보마다 버튼 + 맨 끝에 PIVO ID 버튼
 *     - 버튼 value 에 pendingId·pivoId·한국어명이 실린다 (선택 핸들러 계약)
 *     - max 를 넘으면 잘린다
 *     - pivoActionId 를 안 주면 PIVO 버튼이 안 붙는다 (흐름별 모달 미구현 자리 보호)
 *   buildManualEntryBlocks:
 *     - 직접 입력 버튼 + PIVO ID 버튼
 *     - 작품명 힌트가 없으면 "없음"
 *   candidateLabel:
 *     - 한국어 → 일본어 표시명 → FIX 순으로 고른다
 *     - Slack 버튼 상한을 넘기지 않는다
 *
 * fixture self-fulfilling 금지:
 *   기대값을 코드에서 베끼지 않고 Slack 블록 규격(버튼 텍스트 75자 상한)과
 *   선택 핸들러가 실제로 읽는 필드(pendingId·pivoId·koreanProjectName)를 기준으로 검증.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildCandidateBlocks, buildManualEntryBlocks, buildPivoIdButton,
  candidateLabel, CANDIDATE_LABEL_MAX,
} = require("../work-picker-blocks");

const row = (ko, ja = "", fix = "", pivo = "", lang = "zh-ja") =>
  ({ koreanProjectName: ko, japaneseDisplayTitle: ja, japaneseFixedTitle: fix, pivoId: pivo, lang });

describe("buildCandidateBlocks", () => {
  const candidates = [row("신과 함께 레벨업", "", "", "82357"), row("회귀자 사용설명서", "", "", "86975")];

  test("후보 버튼 뒤에 PIVO ID 버튼이 붙는다", () => {
    const blocks = buildCandidateBlocks({ candidates, pendingId: "p1", actionIdPrefix: "pick_", pivoActionId: "open_pivo_id_modal" });
    const els = blocks[1].elements;
    assert.equal(els.length, 3);
    assert.deepEqual(els.slice(0, 2).map(e => e.action_id), ["pick_0", "pick_1"]);
    assert.equal(els[2].action_id, "open_pivo_id_modal");
    assert.equal(els[2].value, "p1");
  });

  test("버튼 value 에 선택 핸들러가 읽는 네 필드가 실린다", () => {
    const [, actions] = buildCandidateBlocks({ candidates, pendingId: "p1", actionIdPrefix: "pick_", pivoActionId: "x" });
    assert.deepEqual(JSON.parse(actions.elements[0].value), {
      pendingId: "p1", pivoId: "82357", koreanProjectName: "신과 함께 레벨업", lang: "zh-ja",
    });
  });

  // ★버튼을 누른 뒤엔 소환 이모지가 남아 있지 않다. lang 이 빠지면 받는 쪽이 언어를
  //   되찾을 수 없어 한일 작품도 중일 납품 탭에서 찾는다.
  test("한일 후보면 lang 도 한일로 실린다", () => {
    const koJa = [row("신과 함께 레벨업", "", "", "82357", "ko-ja")];
    const [, actions] = buildCandidateBlocks({ candidates: koJa, pendingId: "p1", actionIdPrefix: "pick_", pivoActionId: "x" });
    assert.equal(JSON.parse(actions.elements[0].value).lang, "ko-ja");
  });

  test("lang 이 없는 행이면 null 로 실어 보낸다 — 빈 문자열이 언어로 둔갑하지 않게", () => {
    const noLang = [{ koreanProjectName: "작품", pivoId: "1" }];
    const [, actions] = buildCandidateBlocks({ candidates: noLang, pendingId: "p1", actionIdPrefix: "pick_", pivoActionId: "x" });
    assert.equal(JSON.parse(actions.elements[0].value).lang, null);
  });

  test("max 를 넘는 후보는 잘린다", () => {
    const many = Array.from({ length: 9 }, (_, i) => row(`작품${i}`, "", "", String(i)));
    const [section, actions] = buildCandidateBlocks({ candidates: many, pendingId: "p1", actionIdPrefix: "pick_", pivoActionId: "x", max: 5 });
    assert.equal(actions.elements.length, 6, "후보 5개 + PIVO 버튼");
    assert.match(section.text.text, /후보 5건/);
  });

  test("pivoActionId 가 없으면 PIVO 버튼을 안 붙인다 — 흐름별 모달이 없는 자리 보호", () => {
    const [, actions] = buildCandidateBlocks({ candidates, pendingId: "p1", actionIdPrefix: "pick_" });
    assert.equal(actions.elements.length, 2);
  });
});

describe("buildManualEntryBlocks", () => {
  test("직접 입력 버튼과 PIVO 버튼이 같이 뜬다", () => {
    const [section, actions] = buildManualEntryBlocks({
      pendingId: "p2", manualActionId: "open_manual_title_modal",
      pivoActionId: "open_pivo_id_modal", titleHint: "神と共にレベルアップ",
    });
    assert.match(section.text.text, /神と共にレベルアップ/);
    assert.deepEqual(actions.elements.map(e => e.action_id), ["open_manual_title_modal", "open_pivo_id_modal"]);
    assert.equal(actions.elements[0].style, "primary");
  });

  test("작품명 힌트가 없으면 '없음'", () => {
    const [section] = buildManualEntryBlocks({ pendingId: "p2", manualActionId: "m", pivoActionId: "x" });
    assert.match(section.text.text, /없음/);
  });
});

describe("candidateLabel", () => {
  test("한국어 → 일본어 표시명 → FIX 순", () => {
    assert.equal(candidateLabel(row("한국어", "にほんご", "FIX"), 0), "한국어");
    assert.equal(candidateLabel(row("", "にほんご", "FIX"), 0), "にほんご");
    assert.equal(candidateLabel(row("", "", "FIX"), 0), "FIX");
    assert.equal(candidateLabel(row("", "", ""), 2), "후보 3");
  });

  test("Slack 버튼 텍스트 상한(75자)을 넘기지 않는다", () => {
    const label = candidateLabel(row("가".repeat(200)), 0);
    assert.ok(label.length <= CANDIDATE_LABEL_MAX);
    assert.ok(CANDIDATE_LABEL_MAX < 75, "Slack 상한보다 여유가 있어야 한다");
    assert.match(label, /…$/);
  });
});

describe("buildPivoIdButton", () => {
  test("action_id 를 인자로 받는다 — 흐름마다 뒤처리가 다르다", () => {
    assert.equal(buildPivoIdButton("p1", "open_schedule_pivo_modal").action_id, "open_schedule_pivo_modal");
  });
});
