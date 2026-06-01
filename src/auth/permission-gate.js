"use strict";
/**
 * 권한 게이트 모듈 (단일책임: "이 Slack 사용자가 봇을 쓸 권한이 있는가")
 *
 * 허용 조건 = Slack user ID가 ALLOWED_USER_IDS 화이트리스트에 있는가 (단순 멤버십).
 * Slack users.info / email / 도메인 / Totus 조회 없음 — event.user 직접 대조.
 */

// ── 허용 사용자 목록 (APM 담당자 Slack user ID) ─────────────────────────────
// 추가: 아래 배열에 "Uxxxxxxxx",  // 이름  한 줄 추가
// 제외: 해당 줄 삭제
// (Slack user ID는 Slack 프로필 > "멤버 ID 복사"로 확인)
const ALLOWED_USER_IDS = new Set([
  "UBRE3KL5A",    // APM 1
  "U01GN9Q3WPK",  // APM 2
  "U05CE8HFA6B",  // 정태영 (John)
  "U02BTD7TY48",  // APM 4
  "U07G8KC2EE6",  // APM 5
  "U075B3S7VPD",  // APM 6
  "U02GPTNGZ5W",  // APM 7
  "U07E0QPL8MV",  // APM 8
  "U04463JR4HH",  // APM 9
  "U06MUFY0JH3",  // APM 10
]);

/**
 * @typedef {Object} PermissionResult
 * @property {boolean} allowed
 * @property {"ALLOWED"|"DENY_NOT_ALLOWED"} reason
 */

/**
 * Slack 사용자 권한을 확인한다.
 *
 * @param {string} slackUserId - 반응을 누른 Slack 사용자 ID (event.user)
 * @param {object} [deps] - (선택) 테스트용 화이트리스트 주입 { allowedUserIds }
 * @returns {PermissionResult}
 */
function checkPermission(slackUserId, deps = {}) {
  const allowed = deps.allowedUserIds ?? ALLOWED_USER_IDS;
  const ok = allowed.has(slackUserId);
  return { allowed: ok, reason: ok ? "ALLOWED" : "DENY_NOT_ALLOWED" };
}

module.exports = { checkPermission, ALLOWED_USER_IDS };
