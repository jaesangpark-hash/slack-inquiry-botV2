"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const {
  readKoreanProjectNameFromSelectionPayload,
} = require("../title-selection-payload");

describe("readKoreanProjectNameFromSelectionPayload", () => {
  test("의미가 명확한 koreanProjectName을 우선한다", () => {
    assert.equal(
      readKoreanProjectNameFromSelectionPayload({
        koreanProjectName: "새 작품명",
        projectName: "구 작품명",
      }),
      "새 작품명"
    );
  });

  test("배포 전 버튼의 projectName을 하위 호환한다", () => {
    assert.equal(
      readKoreanProjectNameFromSelectionPayload({ projectName: "기존 작품명" }),
      "기존 작품명"
    );
  });
});
