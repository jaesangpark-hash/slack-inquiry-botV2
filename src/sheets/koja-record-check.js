// 단일 책임: 한일 기록 탭 설정(RANGE·GRID_SHEET_ID)이 실제 시트와 맞는지 부팅 때 확인한다
"use strict";

/**
 * 왜 있는가 — append 는 RANGE 의 탭 이름으로, 링크·PIVO·완료 갱신은 gid 로 간다. 둘이 다른 탭을 가리키면
 * 기록은 한일 탭에, 갱신은 다른 탭의 같은 행에 덮어쓴다(AIA 리뷰 R1). 탭이 없으면 한일 문의가 첫 게시에서야
 * 실패한다(R2). 그래서 부팅 때 한 번 확인하고, 틀리면 그 분리만 끄고(한일도 공통 탭에 기록) 오류 로그를 남긴다.
 * 봇은 그대로 뜬다 — 중일 문의까지 멈추지 않게(2026-11-13 결정).
 *
 * 기록 대상은 gid 로 구분하므로(lang-record-router) 한일 탭 gid 가 공통 탭 gid 와 같으면 구분할 수 없다 — 이것도 끈다.
 * 쓰기 권한·보호 범위는 이 확인으로 알 수 없다(읽기 권한만 쓴다). 첫 한일 기록이 실패하면 게시가 멈추고 재시도 안내가 간다.
 */

/**
 * 한일 기록 탭 설정 읽기 — KOJA_{kind}_SHEET_RANGE + KOJA_{kind}_GRID_SHEET_ID 가 둘 다 있어야 켠다.
 * 반쪽 설정·숫자가 아닌 gid 는 경고 후 무시(한일도 공통 탭에 기록). SHEET_ID 를 비우면 공통 파일로 본다.
 * @returns {{ sheetId: string, range: string, gridId: number }|null}
 */
function kojaRecordConfig(env, kind, baseSheetId, warn = (m) => console.warn(m)) {
  const range = String(env[`KOJA_${kind}_SHEET_RANGE`] || "").trim();
  const gridRaw = String(env[`KOJA_${kind}_GRID_SHEET_ID`] || "").trim();
  const sheetId = String(env[`KOJA_${kind}_SHEET_ID`] || "").trim() || baseSheetId;
  if (!range && !gridRaw) return null;
  // gid 는 숫자만 — parseInt 는 "1179736144abc" 도 통과시킨다
  const gridId = /^\d+$/.test(gridRaw) ? Number(gridRaw) : NaN;
  if (!range || !Number.isFinite(gridId) || !sheetId) {
    warn(`[lang-record] KOJA_${kind}_* 설정이 반쪽이거나 gid 가 숫자가 아니라 무시 — RANGE·GRID_SHEET_ID 둘 다 필요(한일도 공통 탭에 기록)`);
    return null;
  }
  return { sheetId, range, gridId };
}

/** "'문의봇_한일'!A:I" → "문의봇_한일" */
function tabTitleOf(range) {
  const raw = String(range || "").split("!")[0].trim();
  const quoted = /^'(.*)'$/.exec(raw);
  return quoted ? quoted[1].replace(/''/g, "'") : raw;
}

/**
 * @param {{ sheetsClient: { getSheetTabs: Function }, kind: string,
 *           cfg: { sheetId: string, range: string, gridId: number }|null, baseGid: number }} args
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function checkKojaRecordTarget({ sheetsClient, kind, cfg, baseGid }) {
  if (!cfg) return { ok: true };
  if (cfg.gridId === baseGid) {
    return { ok: false, reason: `KOJA_${kind} 탭 gid(${cfg.gridId})가 공통 탭 gid 와 같아 기록 탭을 구분할 수 없음` };
  }
  let tabs;
  try {
    tabs = await sheetsClient.getSheetTabs(cfg.sheetId);
  } catch (e) {
    return { ok: false, reason: `KOJA_${kind} 시트 탭 목록을 읽지 못함(${e.message})` };
  }
  const title = tabTitleOf(cfg.range);
  const tab = tabs.find(t => t.title === title);
  if (!tab) return { ok: false, reason: `KOJA_${kind} 탭 「${title}」이 시트에 없음` };
  if (tab.sheetId !== cfg.gridId) {
    return { ok: false, reason: `KOJA_${kind} 탭 「${title}」의 gid(${tab.sheetId})가 설정 GRID_SHEET_ID(${cfg.gridId})와 다름` };
  }
  return { ok: true };
}

/**
 * 설정된 한일 기록 탭마다 확인하고, 틀린 것은 그 라우터의 분리를 끈다.
 * @param {{ sheetsClient: object, checks: Array<{ kind: string, cfg: object|null, baseGid: number,
 *           router: { disableKoja: Function } }>, log?: { log: Function, error: Function } }} args
 */
async function enforceKojaRecordTargets({ sheetsClient, checks, log = console }) {
  for (const { kind, cfg, baseGid, router } of checks) {
    if (!cfg) continue;
    const res = await checkKojaRecordTarget({ sheetsClient, kind, cfg, baseGid });
    if (res.ok) {
      log.log(`[lang-record] KOJA_${kind} 탭 확인 완료 — ${cfg.range} (gid=${cfg.gridId})`);
      continue;
    }
    router.disableKoja();
    log.error(`[lang-record] ${res.reason} — 한일 분리를 끄고 공통 탭에 기록한다`);
  }
}

module.exports = { kojaRecordConfig, tabTitleOf, checkKojaRecordTarget, enforceKojaRecordTargets };
