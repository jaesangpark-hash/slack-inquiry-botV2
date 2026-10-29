// 단일 책임: 납품 시트 조회 및 회차 파싱 (parseEpisodeNumbers + fetchDeliveryDate)
"use strict";

const { normalizeTitleKo, stripClientPrefix } = require("./normalize");
// 마스터 매칭과 같은 채점기를 쓴다 — 두 곳이 어긋나면 작품은 맞게 고르고 납품일만
// 다른 작품 걸 가져온다.
const { scoreTitle, TIER } = require("./title-score");

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
    // 한일 납품 탭 B열은 "[카카오픽코마] 신과 함께 레벨업" 꼴인데 문의도 마스터 원제도 접두가 없다.
    // 괄호만 떼는 normalizeTitleKo 로는 "카카오픽코마신과함께레벨업" 이 돼서 짧은 쪽이 긴 쪽에
    // 포함되는 부분일치로만 걸린다 - 접두를 먼저 떼야 완전일치가 된다.
    const isKoJa = lang === "ko-ja";
    const rowTitle = (row) => normalizeTitleKo(isKoJa ? stripClientPrefix(row[1] || "") : (row[1] || ""));
    // ★가드 없는 양방향 부분일치 + find(첫 일치)는 「유혹」이 「지독한 유혹 WEB」에 걸리는
    //   식으로 엉뚱한 작품을 집는다. 마스터는 이미 점수제(title-score)라 여기만 뚫려 있으면
    //   작품은 맞게 고르고 납품일만 다른 작품 걸 가져온다.
    //
    //   다만 길이비로 **잘라내면** 안 된다. 납품 시트 B열에는 「유제 (PSD파일 Dropbox에
    //   업로드 필요)」처럼 운영 메모가 붙은 행이 있어서, 가드로 치면 멀쩡한 11건이 통째로
    //   "납품일 없음"이 된다(2026-10-29 전수 실측). 그래서 **거르지 않고 점수로 줄을 세워
    //   가장 가까운 행을 고른다** — 못 찾는 건 늘리지 않으면서 오답만 걷어낸다.
    const titleScoreOfRow = (row) => {
      const bVal = rowTitle(row);
      if (!bVal) return null;
      const hits = [needle, alternateKoreanNeedle]
        .filter(Boolean)
        .map(n => scoreTitle(n, bVal, 0))   // minRatio 0 — 여기선 거르지 않고 점수만 본다
        .filter(h => h.tier !== TIER.NONE);
      if (!hits.length) return null;
      return hits.sort((a, b) => b.tier - a.tier || b.ratio - a.ratio)[0];
    };
    const titleMatchesRow = (row) => titleScoreOfRow(row) !== null;
    const episodeOfRow = (row) => parseInt(row[4]);

    const results = [];
    for (const epNum of episodeNums) {
      // 화수가 맞는 행을 전부 모아 제목 점수로 정렬 — 완전일치 > 접두 > 부분(길이비 큰 순).
      const epRows = [];
      for (const row of rows) {
        const rowEp = episodeOfRow(row);
        if (isNaN(rowEp) || rowEp !== epNum) continue;
        const score = titleScoreOfRow(row);
        if (score) epRows.push({ row, score });
      }
      epRows.sort((a, b) => b.score.tier - a.score.tier || b.score.ratio - a.score.ratio);
      const matched = epRows[0]?.row;
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
          const sample = rows.filter(r => r[1]).slice(0, FAIL_SHEET_SAMPLE_LIMIT).map(rowTitle);
          const probe  = needle.slice(0, FAIL_FUZZY_PROBE_LEN);
          const fuzzy  = probe
            ? rows.filter(r => rowTitle(r).includes(probe))
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
