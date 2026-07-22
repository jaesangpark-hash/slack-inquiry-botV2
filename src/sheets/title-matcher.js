// 단일 책임: 작품명 매칭 (Google Sheets 마스터 시트 조회 + 캐시 + 1~4순위 / 토큰 / 후보 감지)
"use strict";

const { normalizeTitle, normalizeTitleKo, stripKariSuffix } = require("./normalize");

// 반환 행은 시트의 실제 언어·업무 의미를 필드명으로 드러낸다.
// { chineseOriginalTitle, koreanProjectName, japaneseDisplayTitle,
//   japaneseFixedTitle, normalizedChineseOriginalTitle,
//   normalizedJapaneseDisplayTitle, pivoId }

const ZHJA_SHEET_RANGE = "'출판사 드라이브 링크'!A:I";
const CANDIDATE_MAX = 5;
const MASTER_COLUMN_INDEX = Object.freeze({
  CHINESE_ORIGINAL_TITLE: 1,
  KOREAN_PROJECT_NAME: 2,
  JAPANESE_DISPLAY_TITLE: 3,
  JAPANESE_FIXED_TITLE: 4,
  PIVO_ID: 8,
});

function readCell(row, columnIndex) {
  return String(row[columnIndex] ?? "").trim();
}

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
      const pivoId = readCell(row, MASTER_COLUMN_INDEX.PIVO_ID);
      const japaneseFixedTitle = readCell(row, MASTER_COLUMN_INDEX.JAPANESE_FIXED_TITLE);
      const japaneseDisplayTitle = stripKariSuffix(
        readCell(row, MASTER_COLUMN_INDEX.JAPANESE_DISPLAY_TITLE)
      );
      const chineseOriginalTitle = readCell(row, MASTER_COLUMN_INDEX.CHINESE_ORIGINAL_TITLE);
      const koreanProjectName = readCell(row, MASTER_COLUMN_INDEX.KOREAN_PROJECT_NAME);
      return {
        chineseOriginalTitle,
        koreanProjectName,
        japaneseDisplayTitle,
        japaneseFixedTitle,
        normalizedChineseOriginalTitle: normalizeTitleKo(chineseOriginalTitle),
        normalizedJapaneseDisplayTitle: normalizeTitle(japaneseDisplayTitle),
        pivoId,
      };
    }).filter(row =>
      row.pivoId ||
      row.koreanProjectName ||
      row.chineseOriginalTitle ||
      row.japaneseDisplayTitle ||
      row.japaneseFixedTitle
    );
  }

  async function loadTitleRowsFromSheet() {
    if (Date.now() - titleCache.loadedAt < 300000 && titleCache.rows.length) return titleCache.rows;
    const fresh = await _loadMasterRows(ZHJA_SHEET_RANGE);
    if (fresh.length) {
      titleCache.rows = fresh;
      titleCache.loadedAt = Date.now();
      console.log("[DEBUG-SHEET] '출판사 드라이브 링크' 로드:", titleCache.rows.length, "건, 마지막 3행:", JSON.stringify(titleCache.rows.slice(-3)));
    } else {
      console.warn("[title-matcher] 시트 재로드 실패 — 기존 캐시 유지:", titleCache.rows.length, "건");
    }
    return titleCache.rows;
  }

  /**
   * @param {{ titleJa?: string|null, titleKo?: string|null, pivoId?: string|null }|string|null} queryOrTitleJa
   * @param {string|null} legacyTitleKo
   * @param {string|null} legacyPivoId
   * @returns {Promise<{
   *   chineseOriginalTitle: string,
   *   koreanProjectName: string,
   *   japaneseDisplayTitle: string,
   *   japaneseFixedTitle: string,
   *   normalizedChineseOriginalTitle: string,
   *   normalizedJapaneseDisplayTitle: string,
   *   pivoId: string,
   * }|null>}
   */
  async function matchWorkTitleFromSheet(queryOrTitleJa, legacyTitleKo = null, legacyPivoId = null) {
    const query = queryOrTitleJa && typeof queryOrTitleJa === "object"
      ? {
          titleJa: queryOrTitleJa.titleJa || null,
          titleKo: queryOrTitleJa.titleKo || null,
          pivoId:  queryOrTitleJa.pivoId  || null,
        }
      : {
          titleJa: queryOrTitleJa || null,
          titleKo: legacyTitleKo  || null,
          pivoId:  legacyPivoId   || null,
        };
    const { titleJa, titleKo, pivoId } = query;
    if (!titleJa && !titleKo && !pivoId) return null;
    const rows = await loadTitleRowsFromSheet();

    // PIVO ID는 표시 작품명과 독립된 식별자이므로 제목보다 먼저 정확히 대조한다.
    if (pivoId) {
      const exactPivo = rows.find(row => row.pivoId === String(pivoId).trim());
      if (exactPivo) {
        console.log("[match] PIVO ID 완전일치:", exactPivo.pivoId, "| 한국어 프로젝트명:", exactPivo.koreanProjectName);
        return exactPivo;
      }
    }

    // 1순위: 한국어 프로젝트명 완전 일치
    if (titleKo) {
      const needle = normalizeTitleKo(titleKo);
      const exact  = rows.find(row => row.koreanProjectName && normalizeTitleKo(row.koreanProjectName) === needle);
      if (exact) { console.log("[match] 한국어 프로젝트명 완전일치:", exact.koreanProjectName); return exact; }
    }
    // 2순위: 한국어 프로젝트명 부분 일치
    if (titleKo) {
      const needle = normalizeTitleKo(titleKo);
      const partial = rows.find(row => row.koreanProjectName && (
        normalizeTitleKo(row.koreanProjectName).includes(needle) ||
        needle.includes(normalizeTitleKo(row.koreanProjectName))
      ));
      if (partial) { console.log("[match] 한국어 프로젝트명 부분일치:", partial.koreanProjectName); return partial; }
    }
    // 3순위: 일본어 표시명 완전 일치 (仮 제거 후)
    if (titleJa) {
      const needle = normalizeTitle(titleJa);
      const exact  = rows.find(row => row.normalizedJapaneseDisplayTitle === needle);
      if (exact) { console.log("[match] 일본어 표시명 완전일치:", exact.japaneseDisplayTitle, "| pivoId:", exact.pivoId, "| 한국어 프로젝트명:", exact.koreanProjectName); return exact; }
    }
    // 4순위: 일본어 표시명 부분 일치 (仮 제거 후)
    if (titleJa) {
      const needle = normalizeTitle(titleJa);
      const partial = rows.find(row => row.normalizedJapaneseDisplayTitle && (
        row.normalizedJapaneseDisplayTitle.includes(needle) ||
        needle.includes(row.normalizedJapaneseDisplayTitle)
      ));
      if (partial) { console.log("[match] 일본어 표시명 부분일치:", partial.japaneseDisplayTitle); return partial; }
    }

    console.log("[match] 매칭 실패 — ja:", titleJa, "ko:", titleKo, "pivoId:", pivoId);
    return null;
  }

  // ── 토큰 매칭 전용 (1~4순위 실패 후 호출) ────────────────
  // 반환: { single: row } | { multiple: [row, ...] } | null
  async function matchWorkTitleByTokens(titleKo, titleJa = null, pivoId = null) {
    if (!titleKo && !titleJa && !pivoId) return null;
    const rows = await loadTitleRowsFromSheet();

    // 0순위: PIVO ID 완전일치 — 있으면 텍스트 토큰 매칭보다 우선 신뢰
    if (pivoId) {
      const exactPivo = rows.find(row => row.pivoId === String(pivoId).trim());
      if (exactPivo) {
        console.log("[match-token] PIVO ID 완전일치:", exactPivo.pivoId);
        return { single: exactPivo };
      }
    }

    // 한국어 프로젝트명 토큰 매칭
    if (titleKo) {
      const tokens = titleKo.split(/\s+/).map(t => normalizeTitleKo(t)).filter(t => t.length >= 2);
      if (tokens.length) {
        const matched = rows.filter(row =>
          row.koreanProjectName && tokens.every(token => normalizeTitleKo(row.koreanProjectName).includes(token))
        );
        console.log(`[match-token] 한국어 토큰:${JSON.stringify(tokens)} → ${matched.length}건`);
        if (matched.length === 1) return { single: matched[0] };
        if (matched.length > 1)  return { multiple: matched };
      }
    }

    // 일본어 표시명 토큰 매칭
    if (titleJa) {
      const tokens = normalizeTitle(titleJa).split(/\s+/).filter(t => t.length >= 2);
      if (tokens.length) {
        const matched = rows.filter(row =>
          row.normalizedJapaneseDisplayTitle && tokens.every(token => row.normalizedJapaneseDisplayTitle.includes(token))
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
  async function matchWorkTitleWithCandidates(titleJa, titleKo = null, pivoId = null) {
    if (!titleJa && !titleKo && !pivoId) return null;
    const rows = await loadTitleRowsFromSheet();

    // 0순위: PIVO ID 완전일치 — 있으면 텍스트 매칭보다 우선 신뢰
    if (pivoId) {
      const exactPivo = rows.find(row => row.pivoId === String(pivoId).trim());
      if (exactPivo) {
        console.log("[match-candidates] PIVO ID 완전일치:", exactPivo.pivoId);
        return { single: exactPivo };
      }
    }

    // 1순위: 한국어 완전일치 → 단건 확정
    if (titleKo) {
      const needle = normalizeTitleKo(titleKo);
      const exact  = rows.find(row => row.koreanProjectName && normalizeTitleKo(row.koreanProjectName) === needle);
      if (exact) return { single: exact };
    }
    // 2순위: 한국어 부분일치 → 복수 체크
    if (titleKo) {
      const needle  = normalizeTitleKo(titleKo);
      const matched = rows.filter(row => row.koreanProjectName && (
        normalizeTitleKo(row.koreanProjectName).includes(needle) ||
        needle.includes(normalizeTitleKo(row.koreanProjectName))
      ));
      if (matched.length === 1) return { single: matched[0] };
      if (matched.length > 1 && matched.length <= CANDIDATE_MAX) return { multiple: matched };
      if (matched.length > CANDIDATE_MAX) return { tooMany: true };
    }
    // 3순위: 일본어 완전일치 → 단건 확정
    if (titleJa) {
      const needle = normalizeTitle(titleJa);
      const exact  = rows.find(row => row.normalizedJapaneseDisplayTitle === needle);
      if (exact) return { single: exact };
    }
    // 4순위: 일본어 부분일치 → 복수 체크
    if (titleJa) {
      const needle  = normalizeTitle(titleJa);
      const matched = rows.filter(row => row.normalizedJapaneseDisplayTitle && (
        row.normalizedJapaneseDisplayTitle.includes(needle) ||
        needle.includes(row.normalizedJapaneseDisplayTitle)
      ));
      if (matched.length === 1) return { single: matched[0] };
      if (matched.length > 1 && matched.length <= CANDIDATE_MAX) return { multiple: matched };
      if (matched.length > CANDIDATE_MAX) return { tooMany: true };
    }

    return null;
  }

  return { matchWorkTitleFromSheet, matchWorkTitleByTokens, matchWorkTitleWithCandidates, loadTitleRowsFromSheet };
};
