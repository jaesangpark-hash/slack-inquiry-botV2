// 단일 책임: 자유 텍스트에서 PIVO ID(항상 6자리 숫자) 추정 (순수 함수, 외부 의존 없음)
"use strict";

// 6자리 숫자가 정확히 1건만 고립되어 있을 때만 채택 — 여러 건이면 회차·날짜 등과 혼동 위험이 커 포기.
function extractPivoIdGuess(text = "") {
  const matches = String(text).match(/(?<!\d)\d{6}(?!\d)/g);
  if (!matches || matches.length !== 1) return null;
  return matches[0];
}

module.exports = { extractPivoIdGuess };
