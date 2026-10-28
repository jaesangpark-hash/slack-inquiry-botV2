"use strict";
/**
 * 작품 확정 화면에 탈출 수단이 빠진 자리가 없는지 — 소스 수준 커버리지 가드
 *
 * node:test + node:assert 빌트인 사용 (신규 dep 추가 금지).
 *
 * 왜 소스를 읽어 검사하나:
 *   「후보를 띄웠는데 그중에 없으면 끝」이 되는 자리를 막는 게 목적이다. 흐름마다 하네스를
 *   띄워 UI 를 그려 보려면 Slack 모킹이 커지는데, 정작 지키려는 건 "블록을 손으로 만들지 말고
 *   빌더를 쓸 것" + "빌더에 탈출 버튼을 줄 것" 두 가지라 소스로 보는 게 더 직접적이다.
 *   빌더를 거치면 탈출 버튼 유무는 work-picker-blocks.test.js 가 따로 보증한다.
 *
 * 검증 항목:
 *   - 후보/직접입력 블록을 손으로 조립한 자리가 남아 있지 않다
 *   - buildCandidateBlocks 호출에는 전부 manualActionId 나 pivoActionId 가 있다
 *     (복수문의는 모달 자체가 없어 TODO 로 명시 제외)
 *   - 버튼이 가리키는 action_id 가 실제로 등록돼 있다 (죽은 버튼 금지)
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

const FLOW_FILES = [
  "slack/inquiry-router.js",
  "retakeFlow.js",
  "fileOrderFlow.js",
  "multipleInquiryFlow.js",
];

describe("작품 확정 UI 는 빌더를 거친다", () => {
  for (const rel of FLOW_FILES) {
    test(`${rel} 에 손으로 만든 후보 블록이 없다`, () => {
      const src = read(rel);
      // 후보 버튼을 직접 map 으로 찍어내던 흔적
      assert.ok(!/action_id: `\w+_(cand|token)_pick_\$\{/.test(src),
        "후보 버튼은 buildCandidateBlocks 로 만들어야 탈출 버튼을 빠뜨리지 않는다");
    });
  }

  test("buildCandidateBlocks 호출에는 탈출 수단이 있다", () => {
    const missing = [];
    for (const rel of FLOW_FILES) {
      const src = read(rel);
      // 호출 블록 하나를 통째로 떼어 본다 (중첩 괄호가 없어 이 정도로 충분)
      for (const m of src.matchAll(/buildCandidateBlocks\(\{[\s\S]*?\}\)/g)) {
        const call = m[0];
        const hasEscape = /manualActionId|pivoActionId/.test(call);
        // 복수문의는 항목 단위라 모달 자체가 없다 — TODO 로 명시해 둔 자리만 예외.
        const excused = rel === "multipleInquiryFlow.js" && /TODO 복수문의/.test(src);
        if (!hasEscape && !excused) missing.push(`${rel}: ${call.slice(0, 80)}`);
      }
    }
    assert.deepEqual(missing, [], "후보만 띄우고 끝나는 자리가 있으면 안 된다");
  });
});

describe("버튼이 가리키는 핸들러가 실제로 있다", () => {
  test("manualActionId / pivoActionId 가 전부 등록돼 있다", () => {
    const all = FLOW_FILES.map(read).join("\n");
    const referenced = new Set();
    for (const m of all.matchAll(/(?:manualActionId|pivoActionId):\s*"([^"]+)"/g)) referenced.add(m[1]);
    assert.ok(referenced.size > 0, "참조가 하나도 없으면 이 검사가 무의미하다");

    // 핸들러 등록은 흐름 파일과 handlers/ 양쪽에 흩어져 있다
    const handlerSrc = [
      ...FLOW_FILES,
      "handlers/direct-input-actions.js",
      "handlers/schedule-actions.js",
    ].map(read).join("\n");

    const dead = [...referenced].filter(id => !handlerSrc.includes(`app.action("${id}"`));
    assert.deepEqual(dead, [], "눌러도 아무 일 없는 버튼이 생긴다");
  });
});
