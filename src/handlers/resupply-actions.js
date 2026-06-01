// 단일 책임: 재수급·파일문의 관련 action/view 핸들러를 Bolt app에 등록한다

"use strict";

/**
 * @param {import("@slack/bolt").App} app
 * @param {{
 *   draftStore: Map,
 *   buildFileInquiryBlocks: Function,
 *   buildFileInquiryMessage: Function,
 *   appendResupplyRecord: Function,
 *   strikethroughResupplyRow: Function,
 *   PM_REQUEST_CHANNEL_ID: string,
 * }} deps
 */
module.exports = function registerResupplyActions(app, deps) {
  const {
    draftStore,
    buildFileInquiryBlocks,
    buildFileInquiryMessage,
    appendResupplyRecord,
    strikethroughResupplyRow,
    PM_REQUEST_CHANNEL_ID,
  } = deps;

  app.action("open_file_inquiry_modal", async ({ ack, body, client }) => {
    await ack();
    const draft = draftStore.get(body.actions[0].value);
    if (!draft) return;
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal", callback_id: "submit_file_inquiry_modal",
        private_metadata: JSON.stringify({ draftId: body.actions[0].value }),
        title: { type: "plain_text", text: "재수급 요청 수정" },
        submit: { type: "plain_text", text: "전송" },
        close:  { type: "plain_text", text: "취소" },
        blocks: [
          { type: "input", block_id: "fi_work_block", label: { type: "plain_text", text: "작품명" },
            element: { type: "plain_text_input", action_id: "value", initial_value: draft.workName||"" }},
          { type: "input", block_id: "fi_episode_block", label: { type: "plain_text", text: "회차" },
            element: { type: "plain_text_input", action_id: "value", initial_value: draft.episode ? String(draft.episode) : "" }},
          { type: "input", block_id: "fi_files_block", label: { type: "plain_text", text: "파일/페이지 번호 (쉼표로 구분)" },
            element: { type: "plain_text_input", action_id: "value", initial_value: draft.fileNumbers?.join(", ")||"", placeholder: { type: "plain_text", text: "예: 5, 6, 7" } }},
          { type: "input", block_id: "fi_reason_block", label: { type: "plain_text", text: "재수급 사유" },
            element: { type: "plain_text_input", action_id: "value", initial_value: draft.reason||"", placeholder: { type: "plain_text", text: "예: 파일 손상" } }},
        ],
      },
    });
  });

  app.view("submit_file_inquiry_modal", async ({ ack, body, view, client }) => {
    await ack();
    const { draftId } = JSON.parse(view.private_metadata || "{}");
    const draft = draftStore.get(draftId);
    if (!draft) return;
    const v = view.state.values;
    draft.workName    = v.fi_work_block?.value?.value?.trim()    || draft.workName;
    draft.episode     = v.fi_episode_block?.value?.value?.trim() || draft.episode;
    draft.fileNumbers = (v.fi_files_block?.value?.value || "").split(",").map(s => s.trim()).filter(Boolean);
    draft.reason      = v.fi_reason_block?.value?.value?.trim()  || draft.reason;
    draftStore.set(draftId, draft);
    const rowIndex = await appendResupplyRecord(draft, body.user.id, client);
    draft.resupplyRowIndex = rowIndex;
    draftStore.set(draftId, draft);
    const msg = buildFileInquiryMessage(draft, body.user.id);
    const pmPost = await client.chat.postMessage({ channel: PM_REQUEST_CHANNEL_ID, ...msg });
    if (draft.sourceLink && draft.sourceLink !== "-") {
      await client.chat.postMessage({ channel: PM_REQUEST_CHANNEL_ID, thread_ts: pmPost.ts, text: `🔗 원본 링크: ${draft.sourceLink}` });
    }
    await client.chat.postMessage({ channel: draft.dmChannelId, text: `✅ <#${PM_REQUEST_CHANNEL_ID}> 채널에 재수급 요청을 전송했어.` });
  });

  app.action("send_file_inquiry_now", async ({ ack, body, client }) => {
    await ack();
    const draft = draftStore.get(body.actions[0].value);
    if (!draft) return;
    const rowIndex2 = await appendResupplyRecord(draft, body.user.id, client);
    draft.resupplyRowIndex = rowIndex2;
    draftStore.set(body.actions[0].value, draft);
    const msg = buildFileInquiryMessage(draft, body.user.id);
    const pmPost2 = await client.chat.postMessage({ channel: PM_REQUEST_CHANNEL_ID, ...msg });
    if (draft.sourceLink && draft.sourceLink !== "-") {
      await client.chat.postMessage({ channel: PM_REQUEST_CHANNEL_ID, thread_ts: pmPost2.ts, text: `🔗 원본 링크: ${draft.sourceLink}` });
    }
    await client.chat.postMessage({ channel: draft.dmChannelId || body.user.id, text: `✅ <#${PM_REQUEST_CHANNEL_ID}> 채널에 재수급 요청을 전송했어.` });
  });

  // ── 재수급 완료 버튼 ──────────────────────────────────────
  app.action("file_resupply_done", async ({ ack, body, client }) => {
    await ack();
    try {
      const meta = JSON.parse(body.actions[0].value || "{}");
      const { originalChannelId, originalTs, apmUserId, workName, episode } = meta;

      // ① PM 채널 메시지 완료 처리 (버튼 제거 + context 추가)
      await client.chat.update({
        channel: body.channel.id, ts: body.message.ts,
        text: body.message.text,
        blocks: [
          ...body.message.blocks.filter(b => b.type === "section"),
          { type: "context", elements: [
            { type: "mrkdwn", text: `✅ *재수급 완료 처리됨* — <@${body.user.id}> · ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}` },
          ]},
        ],
      });

      // ② PM 채널 메시지 스레드에 APM 멘션 + 작업자 완료 안내 버튼
      if (apmUserId) {
        const workerNotifyMeta = JSON.stringify({
          originalChannelId, originalTs, apmUserId, workName, episode,
        });
        await client.chat.postMessage({
          channel: body.channel.id,
          thread_ts: body.message.ts,
          text: `<@${apmUserId}> 원본 수급이 완료되었습니다. 파일 교체 후 아래 버튼으로 작업자에게 안내해줘.`,
          blocks: [
            { type: "section", text: { type: "mrkdwn",
              text: `<@${apmUserId}> 원본 수급이 완료되었습니다.\n파일 교체 완료 후 아래 버튼으로 작업자에게 안내해줘.` } },
            { type: "actions", elements: [
              { type: "button", action_id: "resupply_notify_worker",
                text: { type: "plain_text", text: "📢 작업자에게 완료 안내" },
                style: "primary", value: workerNotifyMeta },
            ]},
          ],
        });
      }

      // ③ 시트 취소선 처리
      if (meta.resupplyRowIndex) {
        await strikethroughResupplyRow(meta.resupplyRowIndex);
      }
    } catch (e) { console.error("file_resupply_done 오류:", e.message); }
  });

  // ── 작업자에게 완료 안내 버튼 ─────────────────────────────
  app.action("resupply_notify_worker", async ({ ack, body, client }) => {
    await ack();
    try {
      const meta = JSON.parse(body.actions[0].value || "{}");
      const { originalChannelId, originalTs, apmUserId } = meta;

      if (!originalChannelId || !originalTs) {
        await client.chat.postMessage({ channel: body.user.id,
          text: "⚠️ 원본 문의 스레드 정보가 없어. 직접 안내해줘." });
        return;
      }

      // 원본 문의 스레드에 완료 안내 (작업자 멘션)
      let mentionText = "";
      try {
        const msgRes = await client.conversations.history({
          channel: originalChannelId, oldest: originalTs, latest: originalTs, inclusive: true, limit: 1,
        });
        const originalUser = msgRes.messages?.find(m => m.ts === originalTs)?.user || null;
        if (originalUser) mentionText = `<@${originalUser}> `;
      } catch (_) {}

      await client.chat.postMessage({
        channel: originalChannelId,
        thread_ts: originalTs,
        text: `${mentionText}✅ 원본 파일 교체가 완료되었습니다. 확인 부탁드립니다.`,
      });

      // 버튼 메시지 업데이트 (버튼 제거 → 완료 context)
      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: body.message.text,
        blocks: [
          ...body.message.blocks.filter(b => b.type === "section"),
          { type: "context", elements: [
            { type: "mrkdwn", text: `📢 *작업자 안내 완료* — <@${body.user.id}> · ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}` },
          ]},
        ],
      });
    } catch (e) { console.error("resupply_notify_worker 오류:", e.message); }
  });
};
