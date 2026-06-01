// 단일 책임: 스케줄 문의 관련 action/view 핸들러를 Bolt app에 등록한다

"use strict";

/**
 * @param {import("@slack/bolt").App} app
 * @param {{
 *   draftStore: Map,
 *   loadTitleRowsFromSheet: Function,
 *   matchWorkTitleFromSheet: Function,
 *   fetchDeliveryDate: Function,
 *   handleScheduleExt: Function,
 *   PM_SLACK_ID: string,
 *   SCHEDULE_CHANNEL_ID: string,
 * }} deps
 */
module.exports = function registerScheduleActions(app, deps) {
  const {
    draftStore,
    loadTitleRowsFromSheet,
    matchWorkTitleFromSheet,
    fetchDeliveryDate,
    handleScheduleExt,
    PM_SLACK_ID,
    SCHEDULE_CHANNEL_ID,
  } = deps;

  app.action("schedule_ask_pm", async ({ ack, body, client }) => {
    await ack();
    const data = draftStore.get(body.actions[0].value);
    if (!data) return;
    const workName     = data.delivery?.workName     || "-";
    const episodeLabel = data.delivery?.episodeLabel || "-";
    const deliveryDate = data.delivery?.allSame
      ? data.delivery.deliveryDate
      : (data.delivery?.episodes?.map(e => `${e.episode}화: ${e.deliveryDate}`).join(", ") || "-");
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal", callback_id: "schedule_pm_request_modal",
        private_metadata: JSON.stringify({ draftId: body.actions[0].value }),
        title: { type: "plain_text", text: "PM 납품일 변경 요청" },
        submit: { type: "plain_text", text: "PM 채널에 전송" },
        close:  { type: "plain_text", text: "취소" },
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `*작품명:* ${workName}　*회차:* ${episodeLabel}\n*기존 납품일:* ${deliveryDate}` }},
          { type: "input", block_id: "desired_date_block", label: { type: "plain_text", text: "희망 납품일" },
            element: { type: "datepicker", action_id: "desired_date_input", placeholder: { type: "plain_text", text: "날짜 선택" } }},
          { type: "input", block_id: "extra_note_block", label: { type: "plain_text", text: "추가 메모 (선택)" }, optional: true,
            element: { type: "plain_text_input", action_id: "extra_note_input", multiline: true, placeholder: { type: "plain_text", text: "전달할 내용이 있으면 입력해줘" } }},
        ],
      },
    });
  });

  app.view("schedule_pm_request_modal", async ({ ack, body, view, client }) => {
    await ack();
    const { draftId } = JSON.parse(view.private_metadata || "{}");
    const data = draftStore.get(draftId);
    if (!data) { await client.chat.postMessage({ channel: body.user.id, text: "초안 정보를 찾지 못했어. 링크를 다시 보내줘." }); return; }
    const workName     = data.delivery?.workName     || "-";
    const episodeLabel = data.delivery?.episodeLabel || "-";
    const deliveryDate = data.delivery?.allSame ? data.delivery.deliveryDate : (data.delivery?.episodes?.map(e => `${e.episode}화: ${e.deliveryDate}`).join(", ") || "-");
    const desiredDate  = view.state.values.desired_date_block?.desired_date_input?.selected_date || "-";
    const extraNote    = view.state.values.extra_note_block?.extra_note_input?.value?.trim() || "";
    const lines = [
      `<@${PM_SLACK_ID}>`, `안녕하세요.`, `아래 작품 납품일 변경이 가능할지 문의 드립니다.`,
      `- 담당자 : <@${body.user.id}>`, `- 작품명 : ${workName}`, `- 회차 : ${episodeLabel}`,
      `- 기존 납품일 : ${deliveryDate}`, `- 희망 납품일 : ${desiredDate}`,
    ];
    if (extraNote) { lines.push(""); lines.push(extraNote); }
    await client.chat.postMessage({ channel: SCHEDULE_CHANNEL_ID, text: lines.join("\n") });
    await client.chat.postMessage({ channel: body.user.id, text: `🔄 <#${SCHEDULE_CHANNEL_ID}> 채널에 납품일 변경 요청을 전송했어.\n희망 납품일: ${desiredDate}` });
  });

  app.action("schedule_pm_no", async ({ ack, body, client }) => {
    await ack();
    await client.chat.postMessage({ channel: body.user.id, text: "확인했어. TMS에서 직접 처리해줘." });
  });

  // ── 스케줄 작품명 직접 입력 ───────────────────────────────
  app.action("open_schedule_title_modal", async ({ ack, body, client }) => {
    await ack();
    const pending = draftStore.get(body.actions[0].value);
    if (!pending) return;
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal", callback_id: "schedule_title_modal",
        private_metadata: JSON.stringify({ pendingId: body.actions[0].value }),
        title: { type: "plain_text", text: "작품명 직접 입력" },
        submit: { type: "plain_text", text: "납품일 다시 조회" },
        close:  { type: "plain_text", text: "취소" },
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `AI 추출값: \`${pending.parsed?.work_title_ja || pending.parsed?.work_title_ko || "없음"}\`` }},
          { type: "input", block_id: "title_ja_block", label: { type: "plain_text", text: "작품명 (원문 그대로)" },
            element: { type: "plain_text_input", action_id: "title_ja_input",
              initial_value: pending.parsed?.work_title_ja || pending.parsed?.work_title_ko || "",
              placeholder: { type: "plain_text", text: "예: 本当は転生したくない 또는 미러월드" } }},
        ],
      },
    });
  });

  app.view("schedule_title_modal", async ({ ack, body, view, client }) => {
    await ack();
    const { pendingId } = JSON.parse(view.private_metadata || "{}");
    const pending = draftStore.get(pendingId);
    if (!pending) return;
    const titleInput   = view.state.values.title_ja_block?.title_ja_input?.value?.trim() || "";
    const matchedTitle = await matchWorkTitleFromSheet(titleInput, titleInput).catch(() => null);
    const workNameKo   = matchedTitle?.projectName || titleInput;
    const delivery     = pending.parsed?.episode
      ? await fetchDeliveryDate(workNameKo, pending.parsed.episode, "zh-ja", matchedTitle?.projectName || null).catch(() => null)
      : null;
    if (delivery) {
      await client.chat.postMessage({ channel: body.user.id, text: `*${delivery.workName} ${delivery.episodeLabel}* 납품일: *${delivery.allSame ? delivery.deliveryDate : delivery.episodes?.map(e=>`${e.episode}화:${e.deliveryDate}`).join(", ")}*` });
    } else {
      await client.chat.postMessage({ channel: body.user.id, text: `납품 시트에서 *${workNameKo}* 를 찾지 못했어. 직접 확인해줘.` });
    }
    await handleScheduleExt(client, body.user.id, { ...pending.parsed, work_title_ko: workNameKo }, matchedTitle, delivery, pending.sourceLink || "");
    draftStore.delete(pendingId);
  });

  // ── 토큰 매칭 후보 선택 버튼 ─────────────────────────────
  app.action(/^schedule_token_pick_\d+$/, async ({ ack, body, client }) => {
    await ack();
    const { pendingId, pivoId, projectName } = JSON.parse(body.actions[0].value || "{}");
    const pending = draftStore.get(pendingId);
    if (!pending) return;

    const rows         = await loadTitleRowsFromSheet();
    const matchedTitle = rows.find(r => r.pivoId === pivoId) || { projectName, pivoId };
    const workNameKo   = matchedTitle.projectName || projectName;
    const delivery     = pending.parsed?.episode
      ? await fetchDeliveryDate(workNameKo, pending.parsed.episode, "zh-ja", workNameKo).catch(() => null)
      : null;

    if (delivery) {
      await client.chat.postMessage({ channel: body.user.id,
        text: `납품 시트 확인 완료 — *${delivery.episodeLabel}* 납품일: *${delivery.allSame ? delivery.deliveryDate : delivery.episodes?.map(e=>`${e.episode}화:${e.deliveryDate}`).join(", ")}*` });
    } else {
      await client.chat.postMessage({ channel: body.user.id, text: `납품 시트에서 *${workNameKo}* 를 찾지 못했어. 직접 확인해줘.` });
    }
    await handleScheduleExt(client, body.user.id, { ...pending.parsed, work_title_ko: workNameKo }, matchedTitle, delivery, pending.sourceLink || "");
    draftStore.delete(pendingId);
  });
};
