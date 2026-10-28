// 단일 책임: 작품명 매칭 (Google Sheets 마스터 시트 조회 + 캐시 + 1~4순위 / 토큰 / 후보 감지)
"use strict";

const { normalizeTitle, normalizeTitleKo, stripKariSuffix } = require("./normalize");
const { rankRows, decide, compareHits } = require("./title-score");

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
        normalizedKoreanProjectName: normalizeTitleKo(koreanProjectName),
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

  // 세 진입점이 공유하는 점수표. 배열 **순서가 곧 신뢰도 순서**다(한국어 → 원어 원제 → 일본어 표시명).
  // titleJa 는 AI 프롬프트상 "일본어 또는 중국어" 겸용 입력이라 원제 칸에도 같이 넣는다.
  function rankByTitle(rows, { titleJa, titleKo }) {
    const ko = normalizeTitleKo(titleKo || "");
    const ja = normalizeTitle(titleJa || "");
    const jaAsOriginal = normalizeTitleKo(titleJa || "");
    return rankRows(rows, [
      { name: "한국어 프로젝트명", needles: [ko],               get: row => row.normalizedKoreanProjectName },
      { name: "원어 원제",         needles: [ko, jaAsOriginal], get: row => row.normalizedChineseOriginalTitle },
      { name: "일본어 표시명",     needles: [ja],               get: row => row.normalizedJapaneseDisplayTitle },
    ]);
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

    // 종전 1~6순위(필드 × 완전/부분)를 점수표 한 번으로 대체한다. 순위가 바뀐 게 아니라
    // 같은 순서를 등급·필드·길이비로 다시 쓴 것 — 달라지는 건 두 가지다.
    //   ① 길이비 가드로 「무쌍」이 「뇌법무쌍」을 집어삼키던 부분일치가 떨어진다
    //   ② find(첫 일치 조용히 채택) 대신 전체를 모아 가장 높은 점수를 고른다
    const ranked = rankByTitle(rows, { titleJa, titleKo });
    if (!ranked.length) {
      console.log("[match] 매칭 실패 — ja:", titleJa, "ko:", titleKo, "pivoId:", pivoId);
      return null;
    }
    const top = ranked[0];
    const tied = ranked.filter(hit => compareHits(hit, top) === 0);
    if (tied.length > 1) {
      // 여기서는 하나를 돌려줘야 하는 계약이라 1등을 채택하되, 모호했다는 사실은 남긴다.
      // 되묻기가 필요한 경로는 matchWorkTitleWithCandidates 를 쓴다.
      console.log(`[match] 동점 ${tied.length}건 — 1등 채택:`, tied.map(h => h.row.koreanProjectName || h.row.chineseOriginalTitle).join(" / "));
    }
    console.log(`[match] ${top.field} 일치(길이비 ${top.ratio.toFixed(2)}):`, top.row.koreanProjectName || top.row.chineseOriginalTitle, "| pivoId:", top.row.pivoId);
    return top.row;
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

    // 중국어 원제 토큰 매칭 — titleJa 필드는 일본어/중국어 겸용 입력이라 원제 그대로 붙여넣는 경우 대비
    for (const candidate of [titleKo, titleJa]) {
      if (!candidate) continue;
      const tokens = normalizeTitleKo(candidate).split(/\s+/).filter(t => t.length >= 2);
      if (tokens.length) {
        const matched = rows.filter(row =>
          row.normalizedChineseOriginalTitle && tokens.every(token => row.normalizedChineseOriginalTitle.includes(token))
        );
        console.log(`[match-token] 중국어 토큰:${JSON.stringify(tokens)} → ${matched.length}건`);
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

    // 점수표로 전체를 모은 뒤 1등이 **유일할 때만** 자동 채택한다. 동점이면 고르게 한다 —
    // 조용히 하나를 집어 틀린 작품을 내놓는 쪽이 되묻는 것보다 나쁘다.
    const ranked = rankByTitle(rows, { titleJa, titleKo });
    const result = decide(ranked, { candidateMax: CANDIDATE_MAX });
    if (!result) return null;
    if (result.multiple) {
      console.log(`[match-candidates] 동점 ${result.multiple.length}건 — 되묻는다:`,
        result.multiple.map(row => row.koreanProjectName || row.chineseOriginalTitle).join(" / "));
    } else if (result.single) {
      const top = ranked[0];
      console.log(`[match-candidates] ${top.field} 일치(길이비 ${top.ratio.toFixed(2)}):`, top.row.koreanProjectName || top.row.chineseOriginalTitle);
    }
    return result;
  }

  return { matchWorkTitleFromSheet, matchWorkTitleByTokens, matchWorkTitleWithCandidates, loadTitleRowsFromSheet };
};
