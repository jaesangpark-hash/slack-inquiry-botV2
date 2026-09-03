// 단일 책임: 납품 시트 조회 및 회차 파싱 (parseEpisodeNumbers + fetchDeliveryDate)
"use strict";

const { normalizeTitleKo } = require("./normalize");

// 매칭 실패 진단 로그의 출력 한도 (진단 전용 — 매칭 판정에는 관여하지 않는다)
const FAIL_SHEET_SAMPLE_LIMIT   = 3;   // "시트 앞 샘플" 표시 행 수
const FAIL_FUZZY_PROBE_LEN      = 4;   // 근접 후보 검색에 쓰는 needle prefix 길이
const FAIL_FUZZY_SAMPLE_LIMIT   = 5;   // 근접 후보 표시 행 수
const FAIL_EPISODE_SAMPLE_LIMIT = 20;  // "보유 화수" 표시 개수

/**
 * @param {{ google: object, getGoogleAuth: function, deliverySheetId: string,
 *            deliverySheetZhJa: string, deliverySheetKoJa: string, alertOnError: function,
 *            sheetsClient: object }} deps
 */
module.exports = function createDeliveryDateService({ google, getGoogleAuth, deliverySheetId, deliverySheetZhJa, deliverySheetKoJa, alertOnError, sheetsClient }) {

  // ── 납품 시트 조회 ────────────────────────────────────────
  function parseEpisodeNumbers(ep) {
    if (!ep && ep !== 0) return [];
    const str = String(ep).replace(/話|화|제|\s/g, "");
    const rangeMatch = str.match(/^(\d+)[~\-–](\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]), end = parseInt(rangeMatch[2]);
      return Array.from({ length: end - start + 1 }, (_, i) => start + i);
    }
    const single = parseInt(str);
    return isNaN(single) ? [] : [single];
  }

  async function fetchDeliveryDate(primaryWorkTitle, episode, lang = "zh-ja", koreanProjectName = null) {
    const rawRange = lang === "ko-ja" ? deliverySheetKoJa : deliverySheetZhJa;
    const clean   = rawRange.replace(/^'+|'+$/g, "");
    const bangIdx = clean.indexOf("!");
    const range   = bangIdx === -1 ? clean : `'${clean.slice(0, bangIdx)}'${clean.slice(bangIdx)}`;
    const res  = await alertOnError("GoogleSheets(deliveryDate)", () =>
      sheetsClient.getValues(deliverySheetId, range)
    );
    const rows = res || [];
    const needle      = normalizeTitleKo(primaryWorkTitle);
    const episodeNums = parseEpisodeNumbers(episode);
    // 중일 문의의 첫 제목은 중국어 원제일 수 있어 한국어 프로젝트명을 보조 검색어로 함께 사용한다.
    const alternateKoreanNeedle = koreanProjectName
      ? normalizeTitleKo(koreanProjectName)
      : null;
    console.log(`[fetchDelivery] primaryWorkTitle: "${primaryWorkTitle}" | needle: "${needle}" | koreanProjectName: "${koreanProjectName}" | episode: ${episode} | lang: ${lang} | rows: ${rows.length}`);
    // 제목 매칭과 화수 매칭을 분리한다 — 실패 시 원인(제목 불일치 / 화수 미존재) 판별에 재사용.
    const titleMatchesRow = (row) => {
      const bVal = normalizeTitleKo(row[1] || "");
      if (!bVal) return false;
      const matchMain = bVal === needle || bVal.includes(needle) || needle.includes(bVal);
      const matchAlt = alternateKoreanNeedle && (
        bVal === alternateKoreanNeedle ||
        bVal.includes(alternateKoreanNeedle) ||
        alternateKoreanNeedle.includes(bVal)
      );
      return Boolean(matchMain || matchAlt);
    };
    const episodeOfRow = (row) => parseInt(row[4]);

    const results = [];
    for (const epNum of episodeNums) {
      const matched = rows.find(row => {
        if (!titleMatchesRow(row)) return false;
        const rowEp = episodeOfRow(row);
        return !isNaN(rowEp) && rowEp === epNum;
      });
      if (!matched) {
        const titleHits = rows.filter(titleMatchesRow);
        if (titleHits.length > 0) {
          // 제목은 시트에 있는데 그 화수 행이 없다 — 작업 미생성 또는 화수 표기 상이.
          const eps  = titleHits.map(episodeOfRow).filter(n => !isNaN(n)).sort((a, b) => a - b);
          const more = eps.length > FAIL_EPISODE_SAMPLE_LIMIT ? ", …" : "";
          console.log(`[fetchDelivery] ${epNum}화 매칭 실패 — 원인: 화수 미존재 (제목 일치 ${titleHits.length}행) — needle: "${needle}" / alternateKoreanNeedle: "${alternateKoreanNeedle}"`);
          console.log(`[fetchDelivery] 보유 화수(${eps.length}건):`, eps.length ? `[${eps.slice(0, FAIL_EPISODE_SAMPLE_LIMIT).join(", ")}${more}]` : "숫자 화수 0건");
        } else {
          // 제목 자체가 시트에서 안 잡힌다 — needle prefix 로 근접 후보를 뽑아 표기 차이를 드러낸다.
          const sample = rows.filter(r => r[1]).slice(0, FAIL_SHEET_SAMPLE_LIMIT).map(r => normalizeTitleKo(r[1]));
          const probe  = needle.slice(0, FAIL_FUZZY_PROBE_LEN);
          const fuzzy  = probe
            ? rows.filter(r => normalizeTitleKo(r[1] || "").includes(probe))
                  .slice(0, FAIL_FUZZY_SAMPLE_LIMIT)
                  .map(r => `"${r[1]}"(E열:${r[4]})`)
            : [];
          console.log(`[fetchDelivery] ${epNum}화 매칭 실패 — 원인: 제목 불일치 — needle: "${needle}" / alternateKoreanNeedle: "${alternateKoreanNeedle}"`);
          console.log(`[fetchDelivery] 시트 앞 샘플:`, sample);
          console.log(`[fetchDelivery] 근접 후보 (probe: "${probe}"):`, fuzzy.length ? fuzzy : "없음");
        }
      }
      results.push({ episode: epNum, deliveryDate: matched?.[6] || "확인 불가", workName: matched?.[1] || primaryWorkTitle, pm: matched?.[2] || "", apm: matched?.[3] || "" });
    }
    if (!results.length) return null;
    const dates   = results.map(r => r.deliveryDate);
    const allSame = dates.every(d => d === dates[0]);
    const first   = results[0];
    return {
      workName: first.workName, pm: first.pm, apm: first.apm, allSame,
      deliveryDate: allSame ? dates[0] : null,
      episodes: results,
      episodeLabel: allSame
        ? (results.length > 1 ? `${results[0].episode}-${results[results.length-1].episode}화` : `${results[0].episode}화`)
        : results.map(r => r.episode + "화").join(", "),
    };
  }

  return { parseEpisodeNumbers, fetchDeliveryDate };
};
