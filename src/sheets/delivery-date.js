// 단일 책임: 납품 시트 조회 및 회차 파싱 (parseEpisodeNumbers + fetchDeliveryDate)
"use strict";

const { normalizeTitleKo } = require("./normalize");

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
    const results = [];
    for (const epNum of episodeNums) {
      const matched = rows.find(row => {
        const bVal = normalizeTitleKo(row[1] || "");
        if (!bVal) return false;
        const matchMain = bVal === needle || bVal.includes(needle) || needle.includes(bVal);
        const matchAlt = alternateKoreanNeedle && (
          bVal === alternateKoreanNeedle ||
          bVal.includes(alternateKoreanNeedle) ||
          alternateKoreanNeedle.includes(bVal)
        );
        if (!matchMain && !matchAlt) return false;
        return !isNaN(parseInt(row[4])) && parseInt(row[4]) === epNum;
      });
      if (!matched) {
        const sample = rows.filter(r => r[1]).slice(0, 3).map(r => normalizeTitleKo(r[1]));
        const fuzzy  = rows.filter(r => {
          const v = normalizeTitleKo(r[1] || "");
          return v.includes("똥") || v.includes("검사") || v.includes("살아남");
        }).slice(0, 5).map(r => `"${r[1]}"(E열:${r[4]})`);
        console.log(`[fetchDelivery] ${epNum}화 매칭 실패 — needle: "${needle}" / alternateKoreanNeedle: "${alternateKoreanNeedle}"`);
        console.log(`[fetchDelivery] 시트 앞 샘플:`, sample);
        console.log(`[fetchDelivery] 유사 작품명 검색:`, fuzzy.length ? fuzzy : "없음");
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
