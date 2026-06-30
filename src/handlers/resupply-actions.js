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
    checkResupplyDone,
    PM_REQUEST_CHANNEL_ID,
    // 납품일·APM 조회 (선택 주입 — 미주입 시 조회 skip)
    matchWorkTitleFromSheet,
    fetchDeliveryDate,
    resolveApmUserId,
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

    // 작품/회차 수정 반영 후 납품일·APM 재조회 (회차 형식 무관)
    if (matchWorkTitleFromSheet && fetchDeliveryDate && draft.episode && draft.episode !== "-") {
      const mt    = await matchWorkTitleFromSheet(draft.workName, draft.workName).catch(() => null);
      const qName = mt?.projectName || draft.workName;
      const dRes  = qName
        ? await fetchDeliveryDate(qName, draft.episode, "zh-ja", mt?.projectName || null).catch(() => null)
        : null;
      if (dRes) {
        draft.deliveryDate = dRes.allSame ? dRes.deliveryDate : dRes.episodes?.map(e => `${e.episode}화:${e.deliveryDate}`).join(", ");
        draft.apmName   = dRes.apm || draft.apmName || null;
        draft.apmUserId = (typeof resolveApmUserId === "function" ? resolveApmUserId(dRes.apm || null) : null) || draft.apmUserId || null;
      }
    }
    draftStore.set(draftId, draft);
    let rowIndex;
    try {
      rowIndex = await appendResupplyRecord(draft, body.user.id, client);
    } catch (e) {
      console.error("[resupply] 시트 기록 실패:", e.message);
      await client.chat.postMessage({ channel: draft.dmChannelId || body.user.id, text: `⚠️ 재수급 시트 기록 실패: ${e.message}` }).catch(() => {});
    }
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
    let rowIndex2;
    try {
      rowIndex2 = await appendResupplyRecord(draft, body.user.id, client);
    } catch (e) {
      console.error("[resupply] 시트 기록 실패:", e.message);
      await client.chat.postMessage({ channel: draft.dmChannelId || body.user.id, text: `⚠️ 재수급 시트 기록 실패: ${e.message}` }).catch(() => {});
    }
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

      // ② PM 채널 메시지 스레드에 APM 멘션 + 원본 이관·작업자 안내 버튼
      const sharedMeta = JSON.stringify({
        originalChannelId, originalTs, apmUserId, workName, episode,
        resupplyRowIndex: meta.resupplyRowIndex || null,
      });
      const sectionText = apmUserId
        ? `<@${apmUserId}> 원본 수급이 완료되었습니다.\n파일을 이 스레드에 올린 뒤 *원본 이관* 버튼을 눌러줘.`
        : `⚠️ APM을 자동으로 찾지 못했어. 담당 APM을 직접 태그한 후 파일을 올리고 *원본 이관* 버튼을 눌러줘.\n*작품: ${workName || "-"} / ${episode || "-"}화*`;
      await client.chat.postMessage({
        channel: body.channel.id,
        thread_ts: body.message.ts,
        text: apmUserId
          ? `<@${apmUserId}> 원본 수급이 완료되었습니다. 파일 이관 후 작업자에게 안내해줘.`
          : `⚠️ APM을 찾지 못했어. 직접 태그하고 진행해줘.`,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: sectionText } },
          { type: "actions", elements: [
            { type: "button", action_id: "resupply_upload_file",
              text: { type: "plain_text", text: "📤 원본 이관" },
              value: sharedMeta },
            { type: "button", action_id: "resupply_notify_worker",
              text: { type: "plain_text", text: "📢 작업자에게 완료 안내" },
              style: "primary", value: sharedMeta },
          ]},
        ],
      });

      // ③ 재수급 시트 완료 체크박스 처리
      if (meta.resupplyRowIndex) {
        await checkResupplyDone(meta.resupplyRowIndex);
      }
    } catch (e) { console.error("file_resupply_done 오류:", e.message); }
  });

  // ── 원본 이관 버튼 ────────────────────────────────────────
  app.action("resupply_upload_file", async ({ ack, body, client }) => {
    await ack();
    try {
      const meta = JSON.parse(body.actions[0].value || "{}");
      const { originalChannelId, originalTs, apmUserId, workName, episode } = meta;
      const BASE  = process.env.PLATFORM_API_URL;
      const TOKEN = process.env.PLATFORM_API_TOKEN;

      // 1. 버튼이 속한 스레드에서 파일 스캔
      const repliesRes = await client.conversations.replies({
        channel: body.channel.id,
        ts: body.message.thread_ts,
      });
      const files = (repliesRes.messages || []).flatMap(m => m.files || []);

      if (!files.length) {
        await client.chat.postMessage({
          channel: body.channel.id,
          thread_ts: body.message.thread_ts,
          text: "⚠️ 스레드에 파일이 없어. 파일을 이 스레드에 첨부한 뒤 다시 눌러줘.",
        });
        return;
      }

      // 2. projectUuid 조회
      const projRes  = await fetch(`${BASE}/api/v1/projects?name=${encodeURIComponent(workName || "")}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const projJson = await projRes.json();
      if (!projJson.success || !projJson.data?.length) {
        await client.chat.postMessage({
          channel: body.channel.id,
          thread_ts: body.message.thread_ts,
          text: `⚠️ TOTUS에서 "${workName}" 프로젝트를 찾지 못했어. 작품명을 확인해줘.`,
        });
        return;
      }
      const projectUuid = projJson.data[0].uuid;

      // 3. 파일별 다운로드 → TOTUS 업로드
      const results = [];
      for (const file of files) {
        try {
          const dlRes = await fetch(file.url_private_download, {
            headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
          });
          if (!dlRes.ok) throw new Error(`Slack 다운로드 실패 (${dlRes.status})`);
          const buffer = Buffer.from(await dlRes.arrayBuffer());

          const formData = new FormData();
          formData.append("file", new Blob([buffer], { type: file.mimetype || "application/octet-stream" }), file.name);
          formData.append("textLanguageCode", "LGC0003"); // 일본어 원본

          const uploadRes  = await fetch(`${BASE}/api/v1/projects/${projectUuid}/files`, {
            method: "POST",
            headers: { Authorization: `Bearer ${TOKEN}` },
            body: formData,
          });
          const uploadJson = await uploadRes.json();
          if (!uploadJson.success) throw new Error(uploadJson.error?.message || "업로드 실패");

          results.push({ name: file.name, ok: true });
          console.log(`[resupply-upload] 이관 완료: ${file.name} → ${projectUuid}`);
        } catch (err) {
          results.push({ name: file.name, ok: false, error: err.message });
          console.error(`[resupply-upload] 실패: ${file.name}`, err.message);
        }
      }

      const succeeded = results.filter(r => r.ok);
      const failed    = results.filter(r => !r.ok);
      const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });

      let resultText = "";
      if (succeeded.length) resultText += `✅ 이관 완료: ${succeeded.map(r => r.name).join(", ")}`;
      if (failed.length)    resultText += `${succeeded.length ? "\n" : ""}❌ 실패: ${failed.map(r => `${r.name} (${r.error})`).join(", ")}`;

      const notifyMeta = JSON.stringify({ originalChannelId, originalTs, apmUserId, workName, episode });
      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: resultText,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: resultText } },
          { type: "context", elements: [
            { type: "mrkdwn", text: `📤 *원본 이관* — <@${body.user.id}> · ${now}` },
          ]},
          ...(succeeded.length ? [{ type: "actions", elements: [
            { type: "button", action_id: "resupply_notify_worker",
              text: { type: "plain_text", text: "📢 작업자에게 완료 안내" },
              style: "primary", value: notifyMeta },
          ]}] : []),
        ],
      });
    } catch (e) {
      console.error("resupply_upload_file 오류:", e.message);
      try {
        await client.chat.postMessage({
          channel: body.channel.id,
          thread_ts: body.message.thread_ts,
          text: `⚠️ 원본 이관 중 오류: ${e.message}`,
        });
      } catch (_) {}
    }
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
