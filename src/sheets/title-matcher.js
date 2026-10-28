// 단일 책임: 작품명 매칭 (Google Sheets 마스터 시트 조회 + 캐시 + 1~4순위 / 토큰 / 후보 감지)
"use strict";

const { normalizeTitle, normalizeTitleKo, stripKariSuffix } = require("./normalize");
const { rankRows, decide, compareHits } = require("./title-score");

// 반환 행은 시트의 실제 언어·업무 의미를 필드명으로 드러낸다.
// { lang, chineseOriginalTitle, koreanProjectName, japaneseDisplayTitle,
//   japaneseFixedTitle, normalizedKoreanProjectName, normalizedChineseOriginalTitle,
//   normalizedJapaneseDisplayTitle, normalizedJapaneseFixedTitle, pivoId }
//
// ★chineseOriginalTitle 은 "원어 원제" 자리다. 중일이면 중국어, 한일이면 한국어가 들어간다.
//   필드명을 바꾸면 소비처 17개 파일을 같이 고쳐야 해서 이름은 그대로 두고 의미만 넓혔다.

const CANDIDATE_MAX = 5;

// 언어쌍 → 마스터 시트. 새 언어쌍 추가 = 이 표에 한 줄(가이드 R7).
// columns 값은 시트 열 인덱스(0-based)다.
const MASTERS = Object.freeze({
  "zh-ja": {
    sheetKey: "masterSheetId",
    range: "'출판사 드라이브 링크'!A:I",
    columns: Object.freeze({ chineseOriginalTitle: 1, koreanProjectName: 2, japaneseDisplayTitle: 3, japaneseFixedTitle: 4, pivoId: 8 }),
  },
  // 한일은 원어가 한국어다 — F 원제 하나가 "원어 원제"와 "한국어 이름" 둘 다를 겸한다.
  // G 프로젝트명("[카카오픽코마] …")은 쓰지 않는다: 문의는 접두 없이 들어오고(재상 님 확인
  // 2026-10-28), 완결작 행에는 작품명 대신 "완결작품"이 박혀 있다. 완결작은 문의봇 범위 밖.
  "ko-ja": {
    sheetKey: "masterSheetKoJaId",
    range: "'한일_master'!A:P",
    columns: Object.freeze({ chineseOriginalTitle: 5, koreanProjectName: 5, japaneseDisplayTitle: 4, japaneseFixedTitle: 3, pivoId: 1 }),
  },
});

function readCell(row, columnIndex) {
  return String(row[columnIndex] ?? "").trim();
}

/**
 * @param {{ google: object, getGoogleAuth: function, masterSheetId: string,
 *            masterSheetKoJaId: string, alertOnError: function, sheetsClient: object }} deps
 */
module.exports = function createTitleMatcher({ google, getGoogleAuth, masterSheetId, masterSheetKoJaId, alertOnError, sheetsClient }) {
  // titleCache: factory 클로저 내부 단일 인스턴스 (app.js가 1회 호출)
  const titleCache = { loadedAt: 0, rows: [] };
  const sheetIds = { masterSheetId, masterSheetKoJaId };
  const activeMasters = Object.entries(MASTERS).filter(([, spec]) => sheetIds[spec.sheetKey]);

  async function _loadMasterRows(lang, spec) {
    const res = await alertOnError(`GoogleSheets(masterRows:${lang})`, () =>
      sheetsClient.getValues(sheetIds[spec.sheetKey], spec.range)
    );
    const cols = spec.columns;
    const rows = (res || []).slice(1); // 헤더 제외
    let droppedPivoIds = 0;
    const mapped = rows.map(row => {
      // ★pivo_id 칸에 "取り下げ"(취하) 같은 글자값이 섞여 있다(한일 실측 6행). 숫자만 ID로 본다 —
      //   글자값을 그대로 인덱싱하면 서로 다른 작품 6개가 같은 키를 공유한다.
      const rawPivoId = readCell(row, cols.pivoId);
      const pivoId = /^\d+$/.test(rawPivoId) ? rawPivoId : "";
      if (rawPivoId && !pivoId) droppedPivoIds++;
      const japaneseFixedTitle = readCell(row, cols.japaneseFixedTitle);
      const japaneseDisplayTitle = stripKariSuffix(readCell(row, cols.japaneseDisplayTitle));
      const chineseOriginalTitle = readCell(row, cols.chineseOriginalTitle);
      const koreanProjectName = readCell(row, cols.koreanProjectName);
      return {
        lang,
        chineseOriginalTitle,
        koreanProjectName,
        japaneseDisplayTitle,
        japaneseFixedTitle,
        normalizedKoreanProjectName: normalizeTitleKo(koreanProjectName),
        normalizedChineseOriginalTitle: normalizeTitleKo(chineseOriginalTitle),
        normalizedJapaneseDisplayTitle: normalizeTitle(japaneseDisplayTitle),
        normalizedJapaneseFixedTitle: normalizeTitle(japaneseFixedTitle),
        pivoId,
      };
    }).filter(row =>
      row.pivoId ||
      row.koreanProjectName ||
      row.chineseOriginalTitle ||
      row.japaneseDisplayTitle ||
      row.japaneseFixedTitle
    );
    if (droppedPivoIds) {
      console.warn(`[title-matcher] ${lang}: 숫자가 아닌 pivo_id ${droppedPivoIds}건 무시 — 제목으로만 찾는다`);
    }
    return mapped;
  }

  async function loadTitleRowsFromSheet() {
    if (Date.now() - titleCache.loadedAt < 300000 && titleCache.rows.length) return titleCache.rows;
    // ★양쪽을 동시에 읽는다. 순차로 부르면 +1초지만 동시에 부르면 추가 비용이 없다
    //   (실측 2026-10-28: 중일만 680ms · 한일만 1002ms · 둘 동시 636ms).
    const loaded = await Promise.all(activeMasters.map(([lang, spec]) =>
      _loadMasterRows(lang, spec).catch(err => {
        console.warn(`[title-matcher] ${lang} 마스터 로드 실패:`, err?.message ?? err);
        return null;   // null = 실패. 빈 배열(정상인데 0건)과 구분한다.
      })
    ));
    // 한쪽이라도 실패하면 기존 캐시를 유지한다 — 반쪽짜리를 5분간 물고 있으면
    // 그 언어 문의가 조용히 "작품 없음"이 된다.
    if (loaded.some(rows => rows === null)) {
      console.warn("[title-matcher] 마스터 일부 로드 실패 — 기존 캐시 유지:", titleCache.rows.length, "건");
      return titleCache.rows;
    }
    const fresh = loaded.flat();
    if (fresh.length) {
      titleCache.rows = fresh;
      titleCache.loadedAt = Date.now();
      const byLang = activeMasters.map(([lang]) => `${lang} ${fresh.filter(r => r.lang === lang).length}건`).join(" · ");
      console.log("[DEBUG-SHEET] 마스터 로드:", byLang);
    } else {
      console.warn("[title-matcher] 시트가 전부 비어 있음 — 기존 캐시 유지:", titleCache.rows.length, "건");
    }
    return titleCache.rows;
  }

  // 세 진입점이 공유하는 점수표. 배열 **순서가 곧 신뢰도 순서**다(한국어 → 원어 원제 → 일본어 표시명).
  // titleJa 는 AI 프롬프트상 "일본어 또는 중국어" 겸용 입력이라 원제 칸에도 같이 넣는다.
  function rankByTitle(rows, { titleJa, titleKo, langPair = null }) {
    const ko = normalizeTitleKo(titleKo || "");
    const ja = normalizeTitle(titleJa || "");
    const jaAsOriginal = normalizeTitleKo(titleJa || "");
    return rankRows(rows, [
      { name: "한국어 프로젝트명", needles: [ko],               get: row => row.normalizedKoreanProjectName },
      { name: "원어 원제",         needles: [ko, jaAsOriginal], get: row => row.normalizedChineseOriginalTitle },
      { name: "일본어 표시명",     needles: [ja],               get: row => row.normalizedJapaneseDisplayTitle },
      // ★FIX 타이틀도 본다. 한일 마스터는 D JP_title 이 정식 제목이고 E 가제가 임시라,
      //   표시명만 보면 「神と共にレベルアップ」같은 정식 제목으로 못 찾는다(실측).
      { name: "일본어 FIX 타이틀", needles: [ja],               get: row => row.normalizedJapaneseFixedTitle },
    // 소환 이모지가 가리킨 언어는 **동점일 때만** 먼저 둔다. 조회 범위를 자르지는 않는다 —
    // 이모지를 잘못 찍어도 반대쪽 작품이 후보에는 남아야 한다.
    ], { prefer: langPair ? row => row.lang === langPair : null });
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
          langPair: queryOrTitleJa.langPair || null,
        }
      : {
          titleJa: queryOrTitleJa || null,
          titleKo: legacyTitleKo  || null,
          pivoId:  legacyPivoId   || null,
          langPair: null,
        };
    const { titleJa, titleKo, pivoId, langPair } = query;
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
    const ranked = rankByTitle(rows, { titleJa, titleKo, langPair });
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
  async function matchWorkTitleWithCandidates(titleJa, titleKo = null, pivoId = null, langPair = null) {
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
    const ranked = rankByTitle(rows, { titleJa, titleKo, langPair });
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
