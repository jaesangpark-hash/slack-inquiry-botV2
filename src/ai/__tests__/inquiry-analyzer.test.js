"use strict";
/**
 * ai/inquiry-analyzer.js 단위 테스트
 *
 * node:test + node:assert 빌트인 사용 (신규 dep 추가 금지).
 * factory DI — fake ai client + fake alertOnError 주입으로 실 Gemini API 없이 검증.
 *
 * 검증 항목:
 *   analyzeInquiryWithAI:
 *     - 정상 JSON → 필드 default 매핑 (source_lang 누락 → "ja", inquiry_type 누락 → "기타",
 *       action_required 누락 → "내용 확인 후 회신 필요", multi_items 비배열 → null)
 *     - 코드블록 stripping (```json / ``` 제거)
 *   parseScheduleInquiry:
 *     - msgDate 유무에 따른 dateContext 분기 (프롬프트 내 보간 검증)
 *     - 정상 파싱 반환
 *   parseFileInquiry:
 *     - 정상 파싱 반환 + 코드블록 stripping
 *
 * fixture self-fulfilling 금지:
 *   fake ai가 반환하는 JSON은 LLM 추론을 mock하는 것.
 *   테스트는 추출 함수의 post-processing (JSON.parse·default 매핑·stripping) 만 검증.
 *   프롬프트 내용·LLM 정답률은 검증 대상 아님.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const createInquiryAnalyzer = require("../inquiry-analyzer");

// ── fake 빌더 ─────────────────────────────────────────────────────────────────

/** fake alertOnError: 콜백을 그냥 실행하는 pass-through */
const fakeAlertOnError = async (_label, fn) => fn();

/**
 * fake ai 빌더: generateContent가 주어진 JSON을 text로 반환하는 mock
 * @param {object} jsonObj  LLM이 반환할 것처럼 설정하는 JSON 객체
 * @param {string} [wrap]   "codeblock" 지정 시 ```json ... ``` 으로 감싸서 stripping 검증
 */
function makeFakeAi(jsonObj, wrap) {
  const raw = JSON.stringify(jsonObj);
  const text = wrap === "codeblock" ? `\`\`\`json\n${raw}\n\`\`\`` : raw;
  return {
    models: {
      generateContent: async () => ({ text }),
    },
  };
}

// ── analyzeInquiryWithAI ──────────────────────────────────────────────────────

describe("analyzeInquiryWithAI", () => {
  test("정상 JSON → 필드 그대로 반환", async () => {
    const llmResponse = {
      translated_ko: "작품 문의입니다",
      source_lang: "ja",
      summary_ko: "요약",
      action_required: "담당자 확인",
      title_ja: "タイトルA",
      title_ko: null,
      inquiry_type: "작업 관련 문의",
      priority: "보통",
      episode: "10",
      multi_items: null,
    };
    const { analyzeInquiryWithAI } = createInquiryAnalyzer({
      ai: makeFakeAi(llmResponse),
      GEMINI_MODEL: "gemini-2.0-flash",
      alertOnError: fakeAlertOnError,
    });
    const result = await analyzeInquiryWithAI("테스트 문의");
    assert.strictEqual(result.translated_ko, "작품 문의입니다");
    assert.strictEqual(result.source_lang, "ja");
    assert.strictEqual(result.inquiry_type, "작업 관련 문의");
    assert.strictEqual(result.title_ja, "タイトルA");
    assert.strictEqual(result.multi_items, null);
  });

  test("source_lang 누락 → default 'ja' 보정", async () => {
    const { analyzeInquiryWithAI } = createInquiryAnalyzer({
      ai: makeFakeAi({ translated_ko: "번역", summary_ko: "요약", action_required: "확인" }),
      GEMINI_MODEL: "gemini-2.0-flash",
      alertOnError: fakeAlertOnError,
    });
    const result = await analyzeInquiryWithAI("문의");
    assert.strictEqual(result.source_lang, "ja");
  });

  test("inquiry_type 누락 → default '기타' 보정", async () => {
    const { analyzeInquiryWithAI } = createInquiryAnalyzer({
      ai: makeFakeAi({ translated_ko: "번역", source_lang: "ko", summary_ko: "요약", action_required: "확인" }),
      GEMINI_MODEL: "gemini-2.0-flash",
      alertOnError: fakeAlertOnError,
    });
    const result = await analyzeInquiryWithAI("문의");
    assert.strictEqual(result.inquiry_type, "기타");
  });

  test("action_required 누락 → default '내용 확인 후 회신 필요' 보정", async () => {
    const { analyzeInquiryWithAI } = createInquiryAnalyzer({
      ai: makeFakeAi({ translated_ko: "번역", source_lang: "ja", summary_ko: "요약" }),
      GEMINI_MODEL: "gemini-2.0-flash",
      alertOnError: fakeAlertOnError,
    });
    const result = await analyzeInquiryWithAI("문의");
    assert.strictEqual(result.action_required, "내용 확인 후 회신 필요");
  });

  test("multi_items 비배열(문자열) → null 보정", async () => {
    const { analyzeInquiryWithAI } = createInquiryAnalyzer({
      ai: makeFakeAi({ translated_ko: "번역", source_lang: "ja", summary_ko: "요약", action_required: "확인", multi_items: "잘못된값" }),
      GEMINI_MODEL: "gemini-2.0-flash",
      alertOnError: fakeAlertOnError,
    });
    const result = await analyzeInquiryWithAI("문의");
    assert.strictEqual(result.multi_items, null);
  });

  test("multi_items 배열 → 배열 그대로 반환", async () => {
    const items = [{ type: "스케줄", work_title_ja: "タイトル", episode: "10" }];
    const { analyzeInquiryWithAI } = createInquiryAnalyzer({
      ai: makeFakeAi({ translated_ko: "번역", source_lang: "ja", summary_ko: "요약", action_required: "확인", multi_items: items }),
      GEMINI_MODEL: "gemini-2.0-flash",
      alertOnError: fakeAlertOnError,
    });
    const result = await analyzeInquiryWithAI("문의");
    assert.ok(Array.isArray(result.multi_items));
    assert.strictEqual(result.multi_items.length, 1);
  });

  test("코드블록(```json```) stripping 후 JSON 파싱 성공", async () => {
    const { analyzeInquiryWithAI } = createInquiryAnalyzer({
      ai: makeFakeAi({ translated_ko: "번역", source_lang: "ja", summary_ko: "요약", action_required: "확인" }, "codeblock"),
      GEMINI_MODEL: "gemini-2.0-flash",
      alertOnError: fakeAlertOnError,
    });
    const result = await analyzeInquiryWithAI("문의");
    assert.strictEqual(result.translated_ko, "번역");
  });
});

// ── parseScheduleInquiry ──────────────────────────────────────────────────────

describe("parseScheduleInquiry", () => {
  test("정상 파싱 반환", async () => {
    const llmResponse = {
      work_title_ja: "タイトルB",
      work_title_ko: null,
      episode: "49",
      requested_date: "2026-06-10",
      extend_days: 3,
      worker_type: "식자",
    };
    const { parseScheduleInquiry } = createInquiryAnalyzer({
      ai: makeFakeAi(llmResponse),
      GEMINI_MODEL: "gemini-2.0-flash",
      alertOnError: fakeAlertOnError,
    });
    const result = await parseScheduleInquiry("49화 3일 연장 요청합니다");
    assert.strictEqual(result.episode, "49");
    assert.strictEqual(result.extend_days, 3);
    assert.strictEqual(result.worker_type, "식자");
  });

  test("msgDate 있으면 dateContext가 프롬프트 앞에 삽입됨 (캡처 검증)", async () => {
    let capturedPrompt = null;
    const capturingAi = {
      models: {
        generateContent: async ({ contents }) => {
          capturedPrompt = contents;
          return { text: JSON.stringify({ work_title_ja: null, work_title_ko: null, episode: null, requested_date: null, extend_days: null, worker_type: "불명" }) };
        },
      },
    };
    const { parseScheduleInquiry } = createInquiryAnalyzer({
      ai: capturingAi,
      GEMINI_MODEL: "gemini-2.0-flash",
      alertOnError: fakeAlertOnError,
    });
    await parseScheduleInquiry("문의 텍스트", "2026-06-05");
    assert.ok(capturedPrompt.startsWith("문의 작성일(KST): 2026-06-05"), "msgDate 있을 때 dateContext가 프롬프트 앞에 포함되어야 함");
  });

  test("msgDate 없으면 dateContext 없이 프롬프트 시작", async () => {
    let capturedPrompt = null;
    const capturingAi = {
      models: {
        generateContent: async ({ contents }) => {
          capturedPrompt = contents;
          return { text: JSON.stringify({ work_title_ja: null, work_title_ko: null, episode: null, requested_date: null, extend_days: null, worker_type: "불명" }) };
        },
      },
    };
    const { parseScheduleInquiry } = createInquiryAnalyzer({
      ai: capturingAi,
      GEMINI_MODEL: "gemini-2.0-flash",
      alertOnError: fakeAlertOnError,
    });
    await parseScheduleInquiry("문의 텍스트");
    assert.ok(!capturedPrompt.startsWith("문의 작성일(KST):"), "msgDate 없을 때 dateContext가 없어야 함");
  });
});

// ── parseFileInquiry ──────────────────────────────────────────────────────────

describe("parseFileInquiry", () => {
  test("정상 파싱 반환", async () => {
    const llmResponse = {
      work_title_ja: "タイトルC",
      work_title_ko: null,
      episode: "12",
      file_numbers: [3, 4, 5],
      reason_raw: "레이어 미분리",
    };
    const { parseFileInquiry } = createInquiryAnalyzer({
      ai: makeFakeAi(llmResponse),
      GEMINI_MODEL: "gemini-2.0-flash",
      alertOnError: fakeAlertOnError,
    });
    const result = await parseFileInquiry("12화 파일 재수급 요청");
    assert.strictEqual(result.episode, "12");
    assert.deepStrictEqual(result.file_numbers, [3, 4, 5]);
    assert.strictEqual(result.reason_raw, "레이어 미분리");
  });

  test("코드블록(```json```) stripping 후 JSON 파싱 성공", async () => {
    const { parseFileInquiry } = createInquiryAnalyzer({
      ai: makeFakeAi({ work_title_ja: null, work_title_ko: "작품D", episode: null, file_numbers: [], reason_raw: null }, "codeblock"),
      GEMINI_MODEL: "gemini-2.0-flash",
      alertOnError: fakeAlertOnError,
    });
    const result = await parseFileInquiry("파일 문의");
    assert.strictEqual(result.work_title_ko, "작품D");
  });
});
