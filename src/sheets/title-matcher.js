// 단일 책임: 작품명 매칭 (Google Sheets 마스터 시트 조회 + 캐시 + 1~4순위 / 토큰 / 후보 감지)
"use strict";

const { normalizeTitle, normalizeTitleKo, stripKariSuffix } = require("./normalize");

// 새 시트 구조 (한일/중일 공통):
//   A=공통번호, B=pivo_id, C=론칭일, D=JP_title, E=가제(일본어), F=원제(중국어), G=프로젝트명(한국어표시용)
// 반환값: { ko, jaDisplay, jaNorm, koNorm, projectName, pivoId }
//   projectName = G열 한국어 프로젝트명 (APM 표시용)
//   pivoId      = B열 (Totus API 매핑용, 결과물 미노출)

const ZHJA_SHEET_RANGE = "'중일_master'!A:G";
const CANDIDATE_MAX = 5;

/**
 * @param {{ google: object, getGoogleAuth: function, masterSheetId: string, alertOnError: function, sheetsClient: object }} deps
 */
module.exports = function createTitleMatcher({ google, getGoogleAuth, masterSheetId, alertOnError, sheetsClient }) {
  // titleCache: factory 클로저 내부 단일 인스턴스 (app.js가 1회 호출)
  const titleCache = { loadedAt: 0, rows: [] };

  async function _loadMasterRows(range) {
    const res = await alertOnError("GoogleSheets(masterRows)", () =>
      sheetsClient.getValues(masterSheetId, range)
    );
    const rows = (res || []).slice(1); // 헤더 제외
    return rows.map(row => {
      const pivoId      = (row[1] || "").trim();                        // B열
      const jpTitle     = (row[3] || "").trim();                        // D열 JP_title(일본어 타이틀)
      const jaDisplay   = stripKariSuffix((row[4] || "").trim());       // E열 가제
      const ko          = (row[5] || "").trim();                        // F열 원제(중국어) — 매칭에 미사용
      const projectName = (row[6] || "").trim();                        // G열 프로젝트명(한국어)
      return { ko, jaDisplay, jpTitle, jaNorm: normalizeTitle(jaDisplay), koNorm: normalizeTitleKo(ko), projectName, pivoId };
    }).filter(r => r.ko || r.jaDisplay);
  }

  async function loadTitleRowsFromSheet() {
    if (Date.now() - titleCache.loadedAt < 300000 && titleCache.rows.length) return titleCache.rows;
    titleCache.rows = await _loadMasterRows(ZHJA_SHEET_RANGE);
    titleCache.loadedAt = Date.now();
    console.log("[DEBUG-SHEET] 중일_master 로드:", titleCache.rows.length, "건, 마지막 3행:", JSON.stringify(titleCache.rows.slice(-3)));
    return titleCache.rows;
  }

  async function matchWorkTitleFromSheet(titleJa, titleKo = null) {
    if (!titleJa && !titleKo) return null;
    const rows = await loadTitleRowsFromSheet();

    // 1순위: 한국어 — G열(projectName) 완전 일치
    if (titleKo) {
      const needle = normalizeTitleKo(titleKo);
      const exact  = rows.find(r => r.projectName && normalizeTitleKo(r.projectName) === needle);
      if (exact) { console.log("[match] 한국어 G열 완전일치:", exact.projectName); return exact; }
    }
    // 2순위: 한국어 — G열(projectName) 부분 일치
    if (titleKo) {
      const needle = normalizeTitleKo(titleKo);
      const partial = rows.find(r => r.projectName && (
        normalizeTitleKo(r.projectName).includes(needle) ||
        needle.includes(normalizeTitleKo(r.projectName))
      ));
      if (partial) { console.log("[match] 한국어 G열 부분일치:", partial.projectName); return partial; }
    }
    // 3순위: 일본어 — E열(jaDisplay) 완전 일치 (仮 제거 후)
    if (titleJa) {
      const needle = normalizeTitle(titleJa);
      const exact  = rows.find(r => r.jaNorm === needle);
      if (exact) { console.log("[match] 일본어 E열 완전일치:", exact.jaDisplay, "| pivoId:", exact.pivoId, "| projectName:", exact.projectName); return exact; }
    }
    // 4순위: 일본어 — E열(jaDisplay) 부분 일치 (仮 제거 후)
    if (titleJa) {
      const needle = normalizeTitle(titleJa);
      const partial = rows.find(r => r.jaNorm && (r.jaNorm.includes(needle) || needle.includes(r.jaNorm)));
      if (partial) { console.log("[match] 일본어 E열 부분일치:", partial.jaDisplay); return partial; }
    }

    console.log("[match] 매칭 실패 — ja:", titleJa, "ko:", titleKo);
    return null;
  }

  // ── 토큰 매칭 전용 (1~4순위 실패 후 호출) ────────────────
  // 반환: { single: row } | { multiple: [row, ...] } | null
  async function matchWorkTitleByTokens(titleKo, titleJa = null) {
    if (!titleKo && !titleJa) return null;
    const rows = await loadTitleRowsFromSheet();

    // 한국어 토큰 매칭 (G열 projectName)
    if (titleKo) {
      const tokens = titleKo.split(/\s+/).map(t => normalizeTitleKo(t)).filter(t => t.length >= 2);
      if (tokens.length) {
        const matched = rows.filter(r =>
          r.projectName && tokens.every(token => normalizeTitleKo(r.projectName).includes(token))
        );
        console.log(`[match-token] 한국어 토큰:${JSON.stringify(tokens)} → ${matched.length}건`);
        if (matched.length === 1) return { single: matched[0] };
        if (matched.length > 1)  return { multiple: matched };
      }
    }

    // 일본어 토큰 매칭 (E열 jaNorm)
    if (titleJa) {
      const tokens = normalizeTitle(titleJa).split(/\s+/).filter(t => t.length >= 2);
      if (tokens.length) {
        const matched = rows.filter(r =>
          r.jaNorm && tokens.every(token => r.jaNorm.includes(token))
        );
        console.log(`[match-token] 일본어 토큰:${JSON.stringify(tokens)} → ${matched.length}건`);
        if (matched.length === 1) return { single: matched[0] };
        if (matched.length > 1)  return { multiple: matched };
      }
    }

    return null;
  }

  // ── 부분일치 복수 후보 감지 (2·4순위 보완) ───────────────
  // 반환: { single: row } | { multiple: [row, ...] } | { tooMany: true } | null
  // 1·3순위(완전일치)는 단건 확정이므로 제외, 2·4순위 부분일치에서만 복수 체크
  async function matchWorkTitleWithCandidates(titleJa, titleKo = null) {
    if (!titleJa && !titleKo) return null;
    const rows = await loadTitleRowsFromSheet();

    // 1순위: 한국어 완전일치 → 단건 확정
    if (titleKo) {
      const needle = normalizeTitleKo(titleKo);
      const exact  = rows.find(r => r.projectName && normalizeTitleKo(r.projectName) === needle);
      if (exact) return { single: exact };
    }
    // 2순위: 한국어 부분일치 → 복수 체크
    if (titleKo) {
      const needle  = normalizeTitleKo(titleKo);
      const matched = rows.filter(r => r.projectName && (
        normalizeTitleKo(r.projectName).includes(needle) ||
        needle.includes(normalizeTitleKo(r.projectName))
      ));
      if (matched.length === 1) return { single: matched[0] };
      if (matched.length > 1 && matched.length <= CANDIDATE_MAX) return { multiple: matched };
      if (matched.length > CANDIDATE_MAX) return { tooMany: true };
    }
    // 3순위: 일본어 완전일치 → 단건 확정
    if (titleJa) {
      const needle = normalizeTitle(titleJa);
      const exact  = rows.find(r => r.jaNorm === needle);
      if (exact) return { single: exact };
    }
    // 4순위: 일본어 부분일치 → 복수 체크
    if (titleJa) {
      const needle  = normalizeTitle(titleJa);
      const matched = rows.filter(r => r.jaNorm && (r.jaNorm.includes(needle) || needle.includes(r.jaNorm)));
      if (matched.length === 1) return { single: matched[0] };
      if (matched.length > 1 && matched.length <= CANDIDATE_MAX) return { multiple: matched };
      if (matched.length > CANDIDATE_MAX) return { tooMany: true };
    }

    return null;
  }

  return { matchWorkTitleFromSheet, matchWorkTitleByTokens, matchWorkTitleWithCandidates, loadTitleRowsFromSheet };
};
