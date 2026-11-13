// 단일 책임: 문의 이력·재수급 기록을 언어쌍에 따라 공통 탭 / 한일 탭으로 보낸다
"use strict";

/**
 * 왜 있는가 — 한일 문의·재수급 기록을 중일 운영 탭과 섞지 않고 별도 탭(「문의봇_한일」「재수급봇_한일」)에
 * 쌓는다(재상 님 지시 2026-11-13). 언어는 이미 매칭된 작품이 정해 둔 draft.lang 을 쓰므로 조회·AI 호출이 늘지 않는다.
 *
 * ★미설정 = 종전과 동일. KOJA_* 기록 env 를 안 넣으면 한일도 공통 탭에 쌓인다(lang-routing 과 같은 규칙).
 * ★후속 호출(링크 갱신·PIVO 갱신·완료 체크)은 행 번호만으로는 어느 탭인지 모른다.
 *   그래서 기록할 때 실제로 쓴 탭의 번호(gid)를 「기록 대상」으로 남기고, 후속 호출은 그 gid 로 탭을 고른다.
 *   언어로 다시 고르면 게시와 클릭 사이에 설정이 바뀌었을 때 다른 탭의 같은 행을 건드린다(AIA 리뷰 S1).
 *   지금 설정에서 그 gid 를 찾을 수 없으면 아무 탭도 건드리지 않고 오류를 낸다.
 * ★기록 대상이 없는 옛 버튼은 종전 규칙(언어 → 탭)을 쓴다. 기능 이전 메시지(언어도 없음)는 공통 탭 행이라 공통으로 간다.
 *
 * @param {{ base: Record<string, Function>, koja?: Record<string, Function>|null,
 *           baseGid: number, kojaGid?: number|null, kojaLang?: string }} args
 *   base/koja = createInquiryHistory 또는 createResupplyRecord 가 돌려준 함수 묶음, baseGid/kojaGid = 그 탭의 gid.
 */
function createLangRecordRouter({ base, koja = null, baseGid, kojaGid = null, kojaLang = "ko-ja" }) {
  let kojaOn = koja;
  const pick = (lang) => (kojaOn && lang === kojaLang ? kojaOn : base);
  const langOfDraft = (draft) => draft?.lang || draft?.langPair || null;
  const gidOf = (target) => (target === base ? baseGid : kojaGid);
  const pickByGid = (gid) => {
    const n = Number(gid);
    if (kojaOn && n === kojaGid) return kojaOn;
    if (n === baseGid) return base;
    throw new Error(`기록한 탭(gid=${gid})을 지금 설정에서 찾을 수 없어 — 다른 탭은 건드리지 않았어.`);
  };
  /** target = { gid } 이면 그 탭, 아니면 언어(문자열|null)로 고른다(옛 버튼 호환). */
  const resolve = (target) => (target && typeof target === "object" && target.gid != null
    ? pickByGid(target.gid)
    : pick(target ?? null));
  return {
    pick,
    langOfDraft,
    resolve,
    /** 이 언어로 지금 기록하면 쓰게 될 탭의 gid — 게시 전에 정해 버튼·체크포인트에 남긴다. */
    recordGidFor: (lang) => gidOf(pick(lang)),
    /** 기록이 실제로 갈 곳 — "koja" | "base" (로그·시험용) */
    targetOf: (lang) => (pick(lang) === base ? "base" : "koja"),
    /** 부팅 확인에서 한일 탭 설정이 틀렸을 때 분리를 끈다(한일도 공통 탭에 기록). */
    disableKoja: () => { kojaOn = null; },
    kojaEnabled: () => !!kojaOn,
  };
}

/** 문의 이력 함수 묶음을 언어 라우팅으로 감싼다. 이름은 원래 함수와 같다. */
function routeInquiryHistory({ base, koja, baseGid, kojaGid }) {
  const r = createLangRecordRouter({ base, koja, baseGid, kojaGid });
  return {
    appendInquiryHistory: async (draft, submitterId, target = null) =>
      r.resolve(target ?? r.langOfDraft(draft)).appendInquiryHistory(draft, submitterId),
    updateInquiryHistorySourceLink: async (rowIndex, link, target = null) => r.resolve(target).updateInquiryHistorySourceLink(rowIndex, link),
    updateInquiryHistoryPivoId: async (rowIndex, pivoId, target = null) => r.resolve(target).updateInquiryHistoryPivoId(rowIndex, pivoId),
    checkInquiryDone: async (rowIndex, target = null) => r.resolve(target).checkInquiryDone(rowIndex),
    recordGidFor: r.recordGidFor,
    targetOf: r.targetOf,
    disableKoja: r.disableKoja,
    kojaEnabled: r.kojaEnabled,
  };
}

/** 재수급 기록 함수 묶음을 언어 라우팅으로 감싼다. */
function routeResupplyRecord({ base, koja, baseGid, kojaGid }) {
  const r = createLangRecordRouter({ base, koja, baseGid, kojaGid });
  return {
    appendResupplyRecord: async (draft, submitterId, client, target = null) =>
      r.resolve(target ?? r.langOfDraft(draft)).appendResupplyRecord(draft, submitterId, client),
    updateResupplySourceLink: async (rowIndex, link, target = null) => r.resolve(target).updateResupplySourceLink(rowIndex, link),
    updateResupplyPivoId: async (rowIndex, pivoId, target = null) => r.resolve(target).updateResupplyPivoId(rowIndex, pivoId),
    checkResupplyDone: async (rowIndex, target = null) => r.resolve(target).checkResupplyDone(rowIndex),
    recordGidFor: r.recordGidFor,
    targetOf: r.targetOf,
    disableKoja: r.disableKoja,
    kojaEnabled: r.kojaEnabled,
  };
}

/**
 * 버튼 값(meta)에서 기록 대상을 꺼낸다. rg(기록한 탭 gid)가 있으면 그것, 없으면 옛 버튼 — 언어로.
 * @param {{ rg?: number|null, lang?: string|null }} meta
 */
function recordTargetFromMeta(meta) {
  if (meta && meta.rg != null) return { gid: meta.rg };
  return (meta && meta.lang) || null;
}

module.exports = { createLangRecordRouter, routeInquiryHistory, routeResupplyRecord, recordTargetFromMeta };
