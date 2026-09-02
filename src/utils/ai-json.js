// 단일 책임: Gemini 등 LLM 응답 텍스트를 안전하게 JSON으로 파싱
"use strict";

/**
 * JSON 문자열 리터럴 내부의 원시 개행/탭과 유효하지 않은 백슬래시 이스케이프를 보정.
 * LLM이 원문(일본어/중국어 등)을 그대로 인용하면서 문자열 안에 실개행을 넣거나
 * JSON에서 허용되지 않는 이스케이프(예: \見)를 만드는 경우를 복구한다.
 */
function sanitizeJsonText(text) {
  const VALID_ESCAPES = '"\\/bfnrtu';
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      const next = text[i + 1];
      if (next !== undefined && VALID_ESCAPES.includes(next)) {
        out += ch + next;
        i++;
      } else {
        out += "\\\\"; // 유효하지 않은 이스케이프 → 백슬래시 자체를 이스케이프
      }
      continue;
    }
    if (ch === '"') { inString = false; out += ch; continue; }
    if (ch === "\n") { out += "\\n"; continue; }
    if (ch === "\r") { out += "\\r"; continue; }
    if (ch === "\t") { out += "\\t"; continue; }
    out += ch;
  }
  return out;
}

/**
 * LLM 응답 텍스트(코드블록 포함 가능)를 JSON으로 파싱.
 * 1차: 코드블록 제거 후 그대로 파싱
 * 2차: 문자열 리터럴 보정(sanitizeJsonText) 후 재시도
 * 둘 다 실패하면 원본 일부를 로그로 남기고 사용자 친화적 오류를 던짐.
 *
 * @param {string} rawText - AI 응답 원문
 * @param {string} [context] - 로그/에러 메시지에 붙일 호출 위치 라벨
 */
function parseAiJson(rawText, context = "") {
  const cleaned = (rawText || "").trim().replace(/```json|```/gi, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (e1) {
    try {
      return JSON.parse(sanitizeJsonText(cleaned));
    } catch (e2) {
      const label = context ? ` (${context})` : "";
      console.error(`[ai-json] JSON 파싱 실패${label}: ${e2.message}\n원본 응답 일부: ${cleaned.slice(0, 500)}`);
      throw new Error(`AI 응답을 해석하지 못했어${label}. 다시 시도해줘.`);
    }
  }
}

module.exports = { parseAiJson, sanitizeJsonText };
