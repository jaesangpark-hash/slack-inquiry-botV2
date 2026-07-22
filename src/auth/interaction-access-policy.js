"use strict";

/**
 * Slack 상호작용 권한 정책의 단일 진입점.
 *
 * - ENTRY_APM: 허용된 APM만 사용
 * - OWNER_APM: 허용된 APM이면서 해당 초안의 소유자
 * - COMPLETION: 초안 소유 APM 또는 지정 PM
 * - PM_ONLY: 지정 PM
 * - WORKER_TARGET: 초안에 저장된 대상 작업자 Slack ID
 */
const POLICY = Object.freeze({
  ENTRY_APM: "ENTRY_APM",
  OWNER_APM: "OWNER_APM",
  COMPLETION: "COMPLETION",
  PM_ONLY: "PM_ONLY",
  WORKER_TARGET: "WORKER_TARGET",
});
const ACCESS = POLICY;

function surface(kind, registrationKey, policy, scope = null) {
  return Object.freeze({ kind, registrationKey, policy, scope });
}

// 등록된 Slack surface 전수 목록. 새 action/view를 추가하면 이 표에 없을 때 부팅 단계에서 실패한다.
const INTERACTION_SURFACES = Object.freeze([
  surface("event", "reaction_added", POLICY.ENTRY_APM, "trigger_reaction"),
  surface("message", "human_dm", POLICY.ENTRY_APM, "human_dm"),

  surface("action", "/^fileorder_cand_pick_\\d+$/", POLICY.OWNER_APM),
  surface("action", "open_file_order_info_modal", POLICY.OWNER_APM),
  surface("view", "submit_file_order_info_modal", POLICY.OWNER_APM),
  surface("action", "file_order_apply_suggested", POLICY.OWNER_APM),
  surface("action", "file_order_manual_input", POLICY.OWNER_APM),
  surface("view", "submit_file_order_manual_modal", POLICY.OWNER_APM),
  surface("action", "fo_open_notify_modal", POLICY.OWNER_APM),
  surface("view", "fo_notify_submit", POLICY.OWNER_APM),
  surface("action", "file_order_close", POLICY.COMPLETION),

  surface("action", "/^retake_token_pick_\\d+$/", POLICY.OWNER_APM),
  surface("action", "retake_select_operation", POLICY.OWNER_APM),
  surface("action", "/^retake_pick_operation_\\d+$/", POLICY.OWNER_APM),
  surface("action", "/^retake_select_task_\\d+$/", POLICY.OWNER_APM),
  surface("action", "retake_open_date_modal", POLICY.OWNER_APM),
  surface("view", "submit_retake_date_modal", POLICY.OWNER_APM),
  surface("action", "direct_retake_btn", POLICY.ENTRY_APM),
  surface("action", "open_retake_info_modal", POLICY.OWNER_APM),
  surface("view", "submit_retake_info_modal", POLICY.OWNER_APM),
  surface("action", "retake_correct_by_pivoid", POLICY.OWNER_APM),
  surface("view", "submit_retake_correct_pivoid", POLICY.OWNER_APM),
  surface("action", "retake_worker_request_send", POLICY.OWNER_APM),
  surface("action", "retake_open_worker_msg_modal", POLICY.OWNER_APM),
  surface("view", "submit_retake_worker_msg_modal", POLICY.OWNER_APM),
  surface("action", "retake_manual_channel_input", POLICY.OWNER_APM),
  surface("view", "submit_retake_manual_channel", POLICY.OWNER_APM),
  surface("action", "retake_close", POLICY.COMPLETION),

  surface("action", "wr_lang_ko", POLICY.OWNER_APM),
  surface("action", "wr_lang_en", POLICY.OWNER_APM),
  surface("action", "wr_manual_input", POLICY.OWNER_APM),
  surface("view", "wr_manual_submit", POLICY.OWNER_APM),
  surface("action", "wr_send", POLICY.OWNER_APM),
  surface("action", "/^wr_pick_target_\\d+$/", POLICY.OWNER_APM),
  surface("action", "wr_manual_channel_input", POLICY.OWNER_APM),
  surface("view", "wr_manual_channel_submit", POLICY.OWNER_APM),
  surface("action", "wr_edit_content", POLICY.OWNER_APM),
  surface("view", "wr_edit_submit", POLICY.OWNER_APM),
  surface("action", "wr_close", POLICY.COMPLETION),
  surface("action", "wr_worker_reply", POLICY.WORKER_TARGET),
  surface("view", "wr_reply_submit", POLICY.WORKER_TARGET),

  surface("action", "schedule_ask_pm", POLICY.OWNER_APM),
  surface("view", "schedule_pm_request_modal", POLICY.OWNER_APM),
  surface("action", "schedule_pm_no", POLICY.ENTRY_APM),
  surface("action", "open_schedule_title_modal", POLICY.OWNER_APM),
  surface("view", "schedule_title_modal", POLICY.OWNER_APM),
  surface("action", "/^schedule_token_pick_\\d+$/", POLICY.OWNER_APM),

  surface("action", "schbulk_open_basic_modal", POLICY.ENTRY_APM),
  surface("action", "/^schbulk_mode_open/", POLICY.ENTRY_APM),
  surface("view", "schbulk_step1", POLICY.OWNER_APM),
  surface("view", "schbulk_step2", POLICY.OWNER_APM),
  surface("action", "schbulk_apply", POLICY.OWNER_APM),
  surface("action", "schbulk_open_adjust", POLICY.OWNER_APM),
  surface("view", "schbulk_adjust", POLICY.OWNER_APM),

  surface("action", "inquiry_done", POLICY.COMPLETION),
  surface("action", "open_inquiry_reply_modal", POLICY.OWNER_APM),
  surface("view", "submit_inquiry_reply_modal", POLICY.OWNER_APM),
  surface("action", "direct_resupply_btn", POLICY.ENTRY_APM),
  surface("view", "direct_resupply_modal", POLICY.OWNER_APM),
  surface("action", "direct_schedule_btn", POLICY.ENTRY_APM),
  surface("view", "direct_schedule_modal", POLICY.OWNER_APM),
  surface("action", "direct_inquiry_btn", POLICY.ENTRY_APM),
  surface("view", "direct_inquiry_modal", POLICY.OWNER_APM),
  surface("action", "direct_fileorder_btn", POLICY.ENTRY_APM),
  surface("view", "direct_fileorder_modal", POLICY.OWNER_APM),
  surface("action", "open_manual_title_modal", POLICY.OWNER_APM),
  surface("view", "manual_title_modal", POLICY.OWNER_APM),
  surface("action", "/^inquiry_cand_pick_\\d+$/", POLICY.OWNER_APM),
  surface("action", "route_pick_relay", POLICY.OWNER_APM),
  surface("action", "route_pick_inquiry", POLICY.OWNER_APM),
  surface("action", "open_inquiry_modal", POLICY.OWNER_APM),
  surface("action", "send_inquiry_now", POLICY.OWNER_APM),
  surface("view", "submit_inquiry_modal", POLICY.OWNER_APM),

  surface("action", "open_file_inquiry_modal", POLICY.OWNER_APM),
  surface("view", "submit_file_inquiry_modal", POLICY.OWNER_APM),
  surface("action", "send_file_inquiry_now", POLICY.OWNER_APM),
  surface("action", "file_resupply_done", POLICY.COMPLETION),
  surface("action", "resupply_upload_file", POLICY.OWNER_APM),
  surface("action", "resupply_notify_worker", POLICY.OWNER_APM),

  surface("action", "schext_open_days_modal", POLICY.OWNER_APM),
  surface("view", "schext_days_modal_submit", POLICY.OWNER_APM),
  surface("action", "/^schext_select_requester_\\d+$/", POLICY.OWNER_APM),
  surface("action", "schext_confirm_step1", POLICY.OWNER_APM),
  surface("action", "schext_goto_step2", POLICY.OWNER_APM),
  surface("action", "/^schext_edit_task_\\d+$/", POLICY.OWNER_APM),
  surface("view", "schext_edit_task_modal_submit", POLICY.OWNER_APM),
  surface("action", "schext_apply_all", POLICY.OWNER_APM),
  surface("action", "schext_retry_proceed", POLICY.OWNER_APM),
  surface("action", "schext_cancel", POLICY.COMPLETION),
  surface("action", "schext_ask_pm", POLICY.OWNER_APM),
  surface("view", "schext_pm_modal_submit", POLICY.OWNER_APM),
  surface("action", "schext_pm_delivery_confirm", POLICY.PM_ONLY),
  surface("action", "schext_pm_delivery_no", POLICY.PM_ONLY),
  surface("action", "schext_open_worker_msg_modal", POLICY.OWNER_APM),
  surface("action", "schext_skip_worker_msg", POLICY.OWNER_APM),
  surface("action", "schext_open_requester_reply_modal", POLICY.OWNER_APM),
  surface("view", "schext_requester_reply_submit", POLICY.OWNER_APM),
  surface("view", "schext_worker_msg_modal_submit", POLICY.OWNER_APM),

  surface("action", "multi_fill_missing", POLICY.OWNER_APM),
  surface("view", "submit_multi_fill_missing", POLICY.OWNER_APM),
  surface("action", "/^multi_token_pick_\\d+$/", POLICY.OWNER_APM),
]);

function registrationKey(matcher) {
  return matcher instanceof RegExp ? matcher.toString() : String(matcher);
}

function getAccessPolicy(kind, matcher) {
  const key = registrationKey(matcher);
  return INTERACTION_SURFACES.find(
    rule => rule.kind === kind && rule.registrationKey === key
  ) || null;
}

module.exports = {
  ACCESS,
  INTERACTION_SURFACES,
  getAccessPolicy,
  registrationKey,
};
