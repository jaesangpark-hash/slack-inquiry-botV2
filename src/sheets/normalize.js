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

// 납품 시트의 한일 작품명은 "[카카오픽코마] 신과 함께 레벨업" 꼴인데 문의는 접두 없이
// "신과 함께 레벨업" 으로 들어온다(재상 님 확인 2026-10-28). 괄호만 떼는 normalizeTitleKo 로는
// "카카오픽코마신과함께레벨업" 이 돼 길이비 0.54 로 가드에 걸린다 — 접두 자체를 떼야 한다.
function stripClientPrefix(v = "") {
  return String(v ?? "").replace(/^\s*[\[【(（][^\]】)）]{1,20}[\]】)）]\s*/u, "").trim();
}

function stripKariSuffix(v = "") {
  return v.normalize("NFKC").replace(/\s*[\(（]仮[\)）]\s*$/u, "").trim();
}

module.exports = { normalizeTitle, normalizeTitleKo, stripKariSuffix, stripClientPrefix };
