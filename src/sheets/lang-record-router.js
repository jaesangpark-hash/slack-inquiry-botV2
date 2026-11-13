// 단일 책임: 문의 이력·재수급 기록을 언어쌍에 따라 공통 탭 / 한일 탭으로 보낸다
"use strict";

/**
 * 왜 있는가 — 한일 문의·재수급 기록을 중일 운영 탭과 섞지 않고 별도 탭(「문의봇_한일」「재수급봇_한일」)에
 * 쌓는다(재상 님 지시 2026-11-13). 언어는 이미 매칭된 작품이 정해 둔 draft.lang 을 쓰므로 조회·AI 호출이 늘지 않는다.
 *
 * ★미설정 = 종전과 동일. KOJA_* 기록 env 를 안 넣으면 한일도 공통 탭에 쌓인다(lang-routing 과 같은 규칙).
 * ★후속 호출(링크 갱신·PIVO 갱신·완료 체크)은 행 번호만으로는 어느 탭인지 모른다 — 반드시 같은 lang 을 넘긴다.
 *   완료 버튼은 버튼 값(meta.lang)에 언어를 영속해 두고 그걸 넘긴다. 배포 전 메시지(meta.lang 없음)는 공통 탭 행이라 공통으로 간다.
 *
 * @param {{ base: Record<string, Function>, koja?: Record<string, Function>|null, kojaLang?: string }} args
 *   base/koja = createInquiryHistory 또는 createResupplyRecord 가 돌려준 함수 묶음.
 */
function createLangRecordRouter({ base, koja = null, kojaLang = "ko-ja" }) {
  const pick = (lang) => (koja && lang === kojaLang ? koja : base);
  const langOfDraft = (draft) => draft?.lang || draft?.langPair || null;
  return {
    pick,
    langOfDraft,
    /** 기록이 실제로 갈 곳 — "koja" | "base" (로그·시험용) */
    targetOf: (lang) => (pick(lang) === base ? "base" : "koja"),
  };
}

/** 문의 이력 함수 묶음을 언어 라우팅으로 감싼다. 이름은 원래 함수와 같다. */
function routeInquiryHistory({ base, koja }) {
  const r = createLangRecordRouter({ base, koja });
  return {
    appendInquiryHistory: (draft, submitterId) => r.pick(r.langOfDraft(draft)).appendInquiryHistory(draft, submitterId),
    updateInquiryHistorySourceLink: (rowIndex, link, lang = null) => r.pick(lang).updateInquiryHistorySourceLink(rowIndex, link),
    updateInquiryHistoryPivoId: (rowIndex, pivoId, lang = null) => r.pick(lang).updateInquiryHistoryPivoId(rowIndex, pivoId),
    checkInquiryDone: (rowIndex, lang = null) => r.pick(lang).checkInquiryDone(rowIndex),
    targetOf: r.targetOf,
  };
}

/** 재수급 기록 함수 묶음을 언어 라우팅으로 감싼다. */
function routeResupplyRecord({ base, koja }) {
  const r = createLangRecordRouter({ base, koja });
  return {
    appendResupplyRecord: (draft, submitterId, client) => r.pick(r.langOfDraft(draft)).appendResupplyRecord(draft, submitterId, client),
    updateResupplySourceLink: (rowIndex, link, lang = null) => r.pick(lang).updateResupplySourceLink(rowIndex, link),
    updateResupplyPivoId: (rowIndex, pivoId, lang = null) => r.pick(lang).updateResupplyPivoId(rowIndex, pivoId),
    checkResupplyDone: (rowIndex, lang = null) => r.pick(lang).checkResupplyDone(rowIndex),
    targetOf: r.targetOf,
  };
}

module.exports = { createLangRecordRouter, routeInquiryHistory, routeResupplyRecord };
