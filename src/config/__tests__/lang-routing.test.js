"use strict";
/**
 * 언어쌍별 출력 분리 표 — 회귀 시험
 *
 * 지키려는 계약 두 줄:
 *   1) KOJA_* 미설정 = 종전 동작. 한일도 공통 채널·공통 수신자로 간다.
 *   2) 설정하면 **그 항목만** 한일에서 갈린다. 중일은 어떤 경우에도 영향받지 않는다.
 *
 * 2번이 깨지면 중일 운영 문의가 테스트 채널로 사라진다 — 조용히 틀리는 쪽이라 시험으로 묶는다.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { createLangRouting } = require("../lang-routing");
const { assertLangRouting, readLangRoutingOverrides } = require("../../utils/env");

const BASE = Object.freeze({
  target:    "C_TARGET",
  pmRequest: "C_PMREQ",
  schedule:  "C_SCHED",
  mentionUserIds: ["U_A", "U_B"],
  pmSlackId:      "U_PM",
});

describe("lang-routing — 미설정이면 종전 동작", () => {
  test("overrides 가 비면 전 언어가 공통값", () => {
    const r = createLangRouting({ base: BASE });
    for (const lang of ["zh-ja", "ko-ja", null]) {
      assert.equal(r.channelFor("target", lang), "C_TARGET");
      assert.equal(r.channelFor("pmRequest", lang), "C_PMREQ");
      assert.equal(r.channelFor("schedule", lang), "C_SCHED");
      assert.deepEqual(r.mentionUserIdsFor(lang), ["U_A", "U_B"]);
      assert.equal(r.pmSlackIdFor(lang), "U_PM");
    }
  });

  test("한일 칸이 빈 객체여도 공통값 — 키만 있고 값이 없는 env 가 흔하다", () => {
    const r = createLangRouting({ base: BASE, overrides: { "ko-ja": {} } });
    assert.equal(r.channelFor("target", "ko-ja"), "C_TARGET");
    assert.equal(r.isOverridden("ko-ja"), false);
  });

  test("빈 문자열·빈 배열도 미설정으로 본다", () => {
    const r = createLangRouting({
      base: BASE,
      overrides: { "ko-ja": { target: "   ", mentionUserIds: [], pmSlackId: "" } },
    });
    assert.equal(r.channelFor("target", "ko-ja"), "C_TARGET");
    assert.deepEqual(r.mentionUserIdsFor("ko-ja"), ["U_A", "U_B"]);
    assert.equal(r.pmSlackIdFor("ko-ja"), "U_PM");
  });
});

describe("lang-routing — 설정하면 그 항목만 갈린다", () => {
  const r = createLangRouting({
    base: BASE,
    overrides: { "ko-ja": { target: "C_KOJA_TEST", mentionUserIds: ["U_KO"] } },
  });

  test("한일은 지정한 항목만 바뀐다", () => {
    assert.equal(r.channelFor("target", "ko-ja"), "C_KOJA_TEST");
    assert.deepEqual(r.mentionUserIdsFor("ko-ja"), ["U_KO"]);
    // 지정 안 한 항목은 공통값 그대로
    assert.equal(r.channelFor("pmRequest", "ko-ja"), "C_PMREQ");
    assert.equal(r.pmSlackIdFor("ko-ja"), "U_PM");
  });

  // ★이게 깨지면 중일 운영 문의가 테스트 채널로 사라진다.
  test("중일은 한일 설정에 절대 영향받지 않는다", () => {
    assert.equal(r.channelFor("target", "zh-ja"), "C_TARGET");
    assert.deepEqual(r.mentionUserIdsFor("zh-ja"), ["U_A", "U_B"]);
    assert.equal(r.isOverridden("zh-ja"), false);
  });

  test("언어를 모르면(null) 공통값 — DM 링크 소환에 신호가 없다", () => {
    assert.equal(r.channelFor("target", null), "C_TARGET");
    assert.deepEqual(r.mentionUserIdsFor(null), ["U_A", "U_B"]);
  });

  test("isOverridden 으로 어느 항목이 갈렸는지 알 수 있다", () => {
    assert.equal(r.isOverridden("ko-ja"), true);
    assert.equal(r.isOverridden("ko-ja", "target"), true);
    assert.equal(r.isOverridden("ko-ja", "pmRequest"), false);
  });

  test("describe() 가 무엇이 갈렸는지 적어 준다 — 부팅 로그로 눈 확인", () => {
    assert.match(r.describe(), /한일/);
    assert.match(r.describe(), /target/);
  });
});

describe("lang-routing — 잘못 쓰면 바로 터진다", () => {
  test("공통 목적지가 비면 생성에서 throw", () => {
    assert.throws(() => createLangRouting({ base: { ...BASE, schedule: "" } }), /schedule/);
  });

  test("없는 목적지 이름은 throw — 오타가 조용히 공통값으로 떨어지지 않게", () => {
    const r = createLangRouting({ base: BASE });
    assert.throws(() => r.channelFor("taget", "ko-ja"), /알 수 없는 목적지/);
  });
});

describe("KOJA_* env 읽기·검증", () => {
  test("미설정이면 빈 override — 종전 동작", () => {
    assert.deepEqual(readLangRoutingOverrides({}), { "ko-ja": {} });
  });

  test("설정한 항목만 override 로 올라온다. 멘션은 쉼표로 쪼갠다", () => {
    const over = readLangRoutingOverrides({
      KOJA_TARGET_CHANNEL_ID: "C_KOJA",
      KOJA_FORWARD_MENTION_USER_ID: "U_ONE, U_TWO",
    });
    assert.deepEqual(over, { "ko-ja": { target: "C_KOJA", mentionUserIds: ["U_ONE", "U_TWO"] } });
  });

  // ★채널 이름(#한일-테스트)을 ID 자리에 넣는 실수가 흔하다. 그대로 뜨면 전송이 런타임에
  //   channel_not_found 로 조용히 실패하고 한일 문의가 사라진다 — 부팅에서 잡는다.
  test("채널 ID 모양이 아니면 부팅에서 throw", () => {
    assert.throws(() => assertLangRouting({ KOJA_TARGET_CHANNEL_ID: "#한일-테스트" }), /채널 ID/);
  });

  test("유저 ID 모양이 아니면 부팅에서 throw", () => {
    assert.throws(() => assertLangRouting({ KOJA_FORWARD_MENTION_USER_ID: "U_OK123,재상" }), /유저 ID/);
  });

  test("미설정·정상값은 통과", () => {
    assert.doesNotThrow(() => assertLangRouting({}));
    assert.doesNotThrow(() => assertLangRouting({
      KOJA_TARGET_CHANNEL_ID: "C0B73GL3WAJ",
      KOJA_PM_SLACK_ID: "U04463JR4HH",
      KOJA_FORWARD_MENTION_USER_ID: "U04463JR4HH, U07G8KC2EE6",
    }));
  });
});
