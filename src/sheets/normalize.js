// 단일 책임: 작품명 정규화 (순수 함수, 외부 의존 없음)
// 〜〰(U+301C/U+3030): 물결표 변형 정규화 포함 (작품명 매칭 일관성)
"use strict";

function normalizeTitle(value = "") {
  return value.normalize("NFKC")
    .replace(/\s+/g, "").replace(/[「」『』【】\[\]\(\)（）]/g, "")
    .replace(/[~～〜〰\-‐-‒–—―_·•・:：!！?？"'`´""'']/g, "")
    .replace(/[、，。…]/g, "")
    .replace(/\.{2,}/g, "")
    .replace(/第?\d+話/g, "").replace(/仮$/i, "").toLowerCase().trim();
}

function normalizeTitleKo(value = "") {
  return value.normalize("NFKC")
    .replace(/\s+/g, "").replace(/[（）()\[\]【】「」『』<>《》]/g, "")
    .replace(/[~～〜〰\-‐-―_]/g, "")
    .replace(/（仮）|（仮$/g, "").toLowerCase().trim();
}

function stripKariSuffix(v = "") {
  return v.normalize("NFKC").replace(/\s*[\(（]仮[\)）]\s*$/u, "").trim();
}

module.exports = { normalizeTitle, normalizeTitleKo, stripKariSuffix };
