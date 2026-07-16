// 단일 책임: 재수급·파일문의 관련 action/view 핸들러를 Bolt app에 등록한다

"use strict";

const {
  COMPLETION_RECOVERY,
  createCompletionFollowupMarker,
  findMarkedFollowupMessage,
  finalizeCompletion,
} = require("../slack/completion-coordinator");
const {
  PUBLICATION_RECOVERY,
  publishFromCheckpoint,
} = require("../slack/publication-coordinator");
const { requirePositiveSheetRowIndex } = require("../sheets/sheet-row-index");
const {
  isPublicationLocked,
  updateTerminalPublicationPreview,
} = require("../slack/publication-ui");

const RESUPPLY_NOTIFY_STATUS = Object.freeze({
  SENDING: "sending",
  SENT: "sent",
  REVIEW_REQUIRED: "review_required",
});

/**
 * @param {import("@slack/bolt").App} app
 * @param {{
 *   draftStore: Map,
 *   buildFileInquiryBlocks: Function,
 *   buildFileInquiryMessage: Function,
 *   appendResupplyRecord: Function,
 *   checkResupplyDone: Function,
 *   PM_REQUEST_CHANNEL_ID: string,
 * }} deps
 */
module.exports = function registerResupplyActions(app, deps) {
  const {
    draftStore,
    buildFileInquiryBlocks,
    buildFileInquiryMessage,
    appendResupplyRecord,
    updateResupplySourceLink,
    checkResupplyDone,
    PM_REQUEST_CHANNEL_ID,
    // 납품일·APM 조회 (선택 주입 — 미주입 시 조회 skip)
    matchWorkTitleFromSheet,
    fetchDeliveryDate,
    resolveApmUserId,
  } = deps;

  async function publishResupplyRequest({ draft, draftId, submitterId, client }) {
    const publicationKey = `resupply_publication:${draftId}`;
    try {
      const publication = await publishFromCheckpoint({
        publicationStateStore: draftStore,
        publicationKey,
        intentSnapshot: {
          kind: "resupply",
          draftId,
          draftVersion: draft.draftVersion || 1,
          submitterId,
          targetChannelId: PM_REQUEST_CHANNEL_ID,
          workName: draft.workName || null,
          episode: draft.episode || null,
          fileNumbers: draft.fileNumbers || [],
          reason: draft.reason || null,
          deliveryDate: draft.deliveryDate || null,
          apmUserId: draft.apmUserId || null,
          sourceLink: draft.sourceLink || null,
          originalChannelId: draft.originalChannelId || null,
          originalTs: draft.originalTs || null,
        },
        appendSheetRow: async () => requirePositiveSheetRowIndex(
          await appendResupplyRecord(draft, submitterId, client),
          "재수급"
        ),
        onSheetRowConfirmed: resupplyRowIndex => {
          const currentDraft = draftStore.get(draftId) || draft;
          draftStore.set(draftId, { ...currentDraft, resupplyRowIndex });
        },
        postMainMessage: ({ sheetRowIndex: resupplyRowIndex }) => {
          const messageDraft = { ...draft, resupplyRowIndex };
          return client.chat.postMessage({
            channel: PM_REQUEST_CHANNEL_ID,
            ...buildFileInquiryMessage(messageDraft, submitterId),
          });
        },
        ...(draft.sourceLink && draft.sourceLink !== "-" ? {
          postThreadMessage: ({ mainMessageTs }) => client.chat.postMessage({
            channel: PM_REQUEST_CHANNEL_ID,
            thread_ts: mainMessageTs,
            text: `🔗 원본 링크: ${draft.sourceLink}`,
          }),
        } : {}),
        postCompletionNotice: () => client.chat.postMessage({
          channel: draft.dmChannelId || submitterId,
          text: `✅ <#${PM_REQUEST_CHANNEL_ID}> 채널에 재수급 요청을 전송했어.`,
        }),
      });

      // 재수급 시트 "원문 링크"를 원본 위치 대신 PM 요청 채널의 이 게시물로 갱신
      if (
        publication.sheetRowIndex
        && publication.mainMessageTs
        && publication.replay !== true
        && typeof updateResupplySourceLink === "function"
      ) {
        try {
          const permalinkRes = await client.chat.getPermalink({
            channel: PM_REQUEST_CHANNEL_ID,
            message_ts: publication.mainMessageTs,
          });
          await updateResupplySourceLink(publication.sheetRowIndex, permalinkRes.permalink);
        } catch (e) {
          console.error("[resupply] 링크 갱신 실패:", e.message);
        }
      }

      return publication;
    } catch (error) {
      console.error(`[resupply] ${error.publicationStage || "publication"} 실패:`, error.message);
      const guidance = error.publicationRecovery === PUBLICATION_RECOVERY.REVIEW_REQUIRED
        ? "PM main 요청이 실제 게시됐는지 운영자가 확인해야 해. 전송 버튼을 다시 누르지 말아줘."
        : "확인된 단계는 보존했어. 같은 전송 버튼을 누르면 실패 단계부터 다시 진행해.";
      try {
        await client.chat.postMessage({
          channel: draft.dmChannelId || submitterId,
          text: `⚠️ 재수급 요청 게시를 완료하지 못했어. ${guidance} (${error.message})`,
        });
      } catch (notificationError) {
        console.error("[resupply] 실패 안내 게시 오류:", notificationError.message);
      }
      return {
        publicationStatus: error.publicationRecovery === PUBLICATION_RECOVERY.REVIEW_REQUIRED
          ? "review_required"
          : "retry_from_checkpoint",
        error,
      };
    }
  }

  app.action("open_file_inquiry_modal", async ({ ack, body, client }) => {
    await ack();
    const draftId = body.actions[0].value;
    const draft = draftStore.get(draftId);
    if (!draft) return;
    if (isPublicationLocked(draftStore, `resupply_publication:${draftId}`)) {
      await client.chat.postMessage({ channel: body.user.id, text: "⚠️ 이 재수급 요청은 이미 전송됐거나 확인 중이야. 내용을 바꾸려면 새 재수급 요청을 만들어줘." });
      return;
    }
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal", callback_id: "submit_file_inquiry_modal",
        private_metadata: JSON.stringify({
          draftId,
          draftVersion: draft.draftVersion || 1,
          previewChannelId: body.channel?.id || draft.dmChannelId || null,
          previewMessageTs: body.message?.ts || draft.progressMessageTs || null,
        }),
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
    const {
      draftId,
      draftVersion,
      previewChannelId,
      previewMessageTs,
    } = JSON.parse(view.private_metadata || "{}");
    const draft = draftStore.get(draftId);
    if (!draft) return;
    if (isPublicationLocked(draftStore, `resupply_publication:${draftId}`)
        || (draftVersion && (draft.draftVersion || 1) !== draftVersion)) {
      await client.chat.postMessage({ channel: body.user.id, text: "⚠️ 이 재수급 요청은 이미 전송됐거나 다른 수정본이 처리됐어. 변경 내용은 새 재수급 요청으로 만들어줘." });
      return;
    }
    const v = view.state.values;
    const updatedDraft = {
      ...draft,
      draftId,
      draftVersion: (draft.draftVersion || 1) + 1,
      workName: v.fi_work_block?.value?.value?.trim() || draft.workName,
      episode: v.fi_episode_block?.value?.value?.trim() || draft.episode,
      fileNumbers: (v.fi_files_block?.value?.value || "").split(",").map(s => s.trim()).filter(Boolean),
      reason: v.fi_reason_block?.value?.value?.trim() || draft.reason,
    };

    // 작품/회차 수정 반영 후 납품일·APM 재조회 (회차 형식 무관)
    if (matchWorkTitleFromSheet && fetchDeliveryDate && updatedDraft.episode && updatedDraft.episode !== "-") {
      const mt    = await matchWorkTitleFromSheet(updatedDraft.workName, updatedDraft.workName).catch(() => null);
      const qName = mt?.koreanProjectName || updatedDraft.workName;
      const dRes  = qName
        ? await fetchDeliveryDate(qName, updatedDraft.episode, "zh-ja", mt?.koreanProjectName || null).catch(() => null)
        : null;
      if (dRes) {
        updatedDraft.deliveryDate = dRes.allSame ? dRes.deliveryDate : dRes.episodes?.map(e => `${e.episode}화:${e.deliveryDate}`).join(", ");
        updatedDraft.apmName   = dRes.apm || updatedDraft.apmName || null;
        updatedDraft.apmUserId = (typeof resolveApmUserId === "function" ? resolveApmUserId(dRes.apm || null) : null) || updatedDraft.apmUserId || null;
      }
    }
    draftStore.set(draftId, updatedDraft);
    const publication = await publishResupplyRequest({ draft: updatedDraft, draftId, submitterId: body.user.id, client });
    if (publication?.intentConflict) {
      await client.chat.postMessage({ channel: body.user.id, text: "⚠️ 이 요청은 이미 다른 내용으로 전송됐어. 변경 내용은 새 재수급 요청으로 만들어줘." });
      return;
    }
    const status = publication?.status || publication?.publicationStatus;
    if (["sent", "review_required"].includes(status)) {
      await updateTerminalPublicationPreview({
        client,
        channel: previewChannelId || updatedDraft.dmChannelId,
        ts: previewMessageTs || updatedDraft.progressMessageTs,
        text: "재수급 요청 초안",
        blocks: buildFileInquiryBlocks(updatedDraft),
        label: "재수급 요청",
        status,
        actorUserId: body.user.id,
      }).catch(() => {});
    }
    // 링크 갱신·완료 안내는 publishResupplyRequest 내부(checkpoint)에서 처리됨
  });

  app.action("send_file_inquiry_now", async ({ ack, body, client }) => {
    await ack();
    const draftId = body.actions[0].value;
    const draft = draftStore.get(draftId);
    if (!draft) return;
    const publication = await publishResupplyRequest({ draft, draftId, submitterId: body.user.id, client });
    if (publication?.intentConflict) {
      await client.chat.postMessage({ channel: body.user.id, text: "⚠️ 이 요청은 이미 다른 내용으로 전송됐어. 변경 내용은 새 재수급 요청으로 만들어줘." });
      return;
    }
    const status = publication?.status || publication?.publicationStatus;
    if (["sent", "review_required"].includes(status)) {
      await updateTerminalPublicationPreview({
        client,
        channel: body.channel?.id,
        ts: body.message?.ts,
        text: body.message?.text,
        blocks: body.message?.blocks,
        label: "재수급 요청",
        status,
        actorUserId: body.user.id,
      }).catch(() => {});
    }
    // 링크 갱신·완료 안내는 publishResupplyRequest 내부(checkpoint)에서 처리됨
  });

  // ── 재수급 완료 버튼 ──────────────────────────────────────
  app.action("file_resupply_done", async ({ ack, body, client }) => {
    await ack();
    try {
      const meta = JSON.parse(body.actions[0].value || "{}");
      const { originalChannelId, originalTs, apmUserId, ownerUserId, workName, episode } = meta;
      if (!ownerUserId) {
        throw new Error("후속 작업 ownerUserId가 없어 완료 처리할 수 없어.");
      }
      const completionStateKey = `file_resupply_done:${body.channel.id}:${body.message.ts}`;
      const resupplyRowIndex = requirePositiveSheetRowIndex(
        meta.resupplyRowIndex,
        "재수급"
      );
      let reconciledFollowupMessageTs = null;
      if (!draftStore.has(completionStateKey) && client.conversations?.replies) {
        const replies = await client.conversations.replies({
          channel: body.channel.id,
          ts: body.message.ts,
          limit: 100,
        });
        reconciledFollowupMessageTs = findMarkedFollowupMessage(
          replies.messages,
          completionStateKey
        )?.ts || null;
      }

      await finalizeCompletion({
        completionStateStore: draftStore,
        completionStateKey,
        reconciledFollowupMessageTs,
        persistCompletion: async () => {
          if (typeof checkResupplyDone !== "function") {
            throw new Error("재수급 완료 시트 기록 기능이 연결되지 않았어.");
          }
          await checkResupplyDone(resupplyRowIndex);
        },
        postFollowup: async () => {
          const sharedMeta = JSON.stringify({
            originalChannelId,
            originalTs,
            apmUserId,
            ownerUserId,
            workName,
            episode,
            resupplyRowIndex,
          });
          return client.chat.postMessage({
            channel: body.channel.id,
            thread_ts: body.message.ts,
            text: `<@${ownerUserId}> 원본 수급이 완료되었습니다. 파일 이관 후 작업자에게 안내해줘.`,
            blocks: [
              { type: "section", block_id: createCompletionFollowupMarker(completionStateKey), text: { type: "mrkdwn", text: `<@${ownerUserId}> 원본 수급이 완료되었습니다.\n파일을 이 스레드에 올린 뒤 *원본 이관* 버튼을 눌러줘.` } },
              { type: "actions", elements: [
                { type: "button", action_id: "resupply_upload_file",
                  text: { type: "plain_text", text: "📤 원본 이관" },
                  value: sharedMeta },
              ]},
            ],
          });
        },
        updateCompletionMessage: () => client.chat.update({
          channel: body.channel.id,
          ts: body.message.ts,
          text: body.message.text,
          blocks: [
            ...body.message.blocks.filter(block => block.type === "section"),
            { type: "context", elements: [
              { type: "mrkdwn", text: `✅ *재수급 완료 처리됨* — <@${body.user.id}> · ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}` },
            ]},
          ],
        }),
      });
    } catch (e) {
      console.error("file_resupply_done 오류:", e.message);
      const guidance = e.completionRecovery === COMPLETION_RECOVERY.REVIEW_REQUIRED
        ? "후속 버튼 메시지가 실제 게시됐는지 운영자가 확인해야 해. 다시 누르지 말아줘."
        : e.completionRecovery === COMPLETION_RECOVERY.RETRY_UI_ONLY
          ? "시트와 후속 버튼은 확인됐고 완료 화면만 남았어. 원래 버튼을 다시 누르면 화면 갱신만 재시도해."
          : e.completionRecovery === COMPLETION_RECOVERY.RETRY_PERSISTENCE
            ? "시트 완료 기록을 확정하지 못했어. 원래 완료 버튼을 다시 눌러줘."
            : "완료 메타데이터와 시트 설정을 확인해줘.";
      await client.chat.postMessage({
        channel: body.channel.id,
        thread_ts: body.message.ts,
        text: `⚠️ 재수급 완료 처리를 확정하지 못했어. ${guidance} (${e.message})`,
      }).catch(() => {});
    }
  });

  // ── 원본 이관 버튼 ────────────────────────────────────────
  app.action("resupply_upload_file", async ({ ack, body, client }) => {
    await ack();
    const mutationKey = `resupply_upload:${body.channel.id}:${body.message.ts}`;
    const savedState = draftStore.get(mutationKey);
    if (savedState?.inProgress) return;
    if (savedState?.status === "review_required") {
      await client.chat.postMessage({
        channel: body.channel.id,
        thread_ts: body.message.thread_ts,
        text: "⚠️ 업로드 결과가 불명확한 파일이 있어 운영자 확인이 필요해. 원본 이관 버튼을 다시 누르지 말아줘.",
      }).catch(() => {});
      return;
    }

    let mutationState = {
      status: savedState?.status || "preparing",
      files: savedState?.files || {},
      inProgress: true,
      startedAt: savedState?.startedAt || new Date().toISOString(),
    };
    draftStore.set(mutationKey, mutationState);

    try {
      const meta = JSON.parse(body.actions[0].value || "{}");
      const { originalChannelId, originalTs, apmUserId, ownerUserId, workName, episode } = meta;
      const BASE  = process.env.PLATFORM_API_URL;
      const TOKEN = process.env.PLATFORM_API_TOKEN;

      // 1. 버튼이 속한 스레드에서 파일 스캔
      const repliesRes = await client.conversations.replies({
        channel: body.channel.id,
        ts: body.message.thread_ts,
      });
      const files = (repliesRes.messages || []).flatMap(m => m.files || []);

      if (!files.length) {
        draftStore.set(mutationKey, { ...mutationState, status: "ready", inProgress: false });
        await client.chat.postMessage({
          channel: body.channel.id,
          thread_ts: body.message.thread_ts,
          text: "⚠️ 스레드에 파일이 없어. 파일을 이 스레드에 첨부한 뒤 다시 눌러줘.",
        });
        return;
      }

      for (const file of files) {
        const fileId = file.id || `${file.name}:${file.size || ""}:${file.url_private_download || ""}`;
        if (!mutationState.files[fileId]) {
          mutationState.files[fileId] = {
            fileId,
            name: file.name,
            status: "pending",
          };
        }
      }
      draftStore.set(mutationKey, { ...mutationState, files: { ...mutationState.files } });

      // 2. projectUuid 조회
      const projRes  = await fetch(`${BASE}/api/v1/projects?name=${encodeURIComponent(workName || "")}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      // 비-JSON 응답(HTML 오류 페이지 등)은 파싱 전에 HTTP status·content-type을 담은 에러로 변환 (원인 판독성)
      const projCt = projRes.headers.get("content-type") || "";
      if (!projCt.includes("application/json")) {
        throw new Error(`TOTUS API 비-JSON 응답 (HTTP ${projRes.status}, content-type: ${projCt || "없음"}) — ${(await projRes.text()).slice(0, 200)}`);
      }
      const projJson = await projRes.json();
      if (!projJson.success || !projJson.data?.length) {
        draftStore.set(mutationKey, { ...mutationState, status: "ready", inProgress: false });
        await client.chat.postMessage({
          channel: body.channel.id,
          thread_ts: body.message.thread_ts,
          text: `⚠️ TOTUS에서 "${workName}" 프로젝트를 찾지 못했어. 작품명을 확인해줘.`,
        });
        return;
      }
      const projectUuid = projJson.data[0].uuid;

      // 3. 파일별 다운로드 → TOTUS 업로드. 확인된 성공과 결과 불명확 파일은 재전송하지 않는다.
      for (const file of files) {
        const fileId = file.id || `${file.name}:${file.size || ""}:${file.url_private_download || ""}`;
        const checkpoint = mutationState.files[fileId];
        if (["uploaded", "review_required"].includes(checkpoint.status)) continue;

        let buffer;
        try {
          const dlRes = await fetch(file.url_private_download, {
            headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
          });
          if (!dlRes.ok) throw new Error(`Slack 다운로드 실패 (${dlRes.status})`);
          buffer = Buffer.from(await dlRes.arrayBuffer());
        } catch (error) {
          mutationState.files[fileId] = {
            ...checkpoint,
            status: "failed",
            error: error.message,
          };
          draftStore.set(mutationKey, { ...mutationState, files: { ...mutationState.files } });
          continue;
        }

        mutationState.files[fileId] = { ...checkpoint, status: "uploading", error: null };
        draftStore.set(mutationKey, { ...mutationState, files: { ...mutationState.files } });
        try {
          const formData = new FormData();
          formData.append("file", new Blob([buffer], { type: file.mimetype || "application/octet-stream" }), file.name);
          formData.append("textLanguageCode", "LGC0003"); // 일본어 원본

          const uploadRes  = await fetch(`${BASE}/api/v1/projects/${projectUuid}/files`, {
            method: "POST",
            headers: { Authorization: `Bearer ${TOKEN}` },
            body: formData,
          });
          const upCt = uploadRes.headers.get("content-type") || "";
          if (!upCt.includes("application/json")) {
            throw new Error(`TOTUS API 비-JSON 응답 (HTTP ${uploadRes.status}, content-type: ${upCt || "없음"}) — ${(await uploadRes.text()).slice(0, 200)}`);
          }
          const uploadJson = await uploadRes.json();
          if (!uploadJson.success) {
            mutationState.files[fileId] = {
              ...checkpoint,
              status: "failed",
              error: uploadJson.error?.message || "업로드 실패",
            };
            draftStore.set(mutationKey, { ...mutationState, files: { ...mutationState.files } });
            continue;
          }

          mutationState.files[fileId] = {
            ...checkpoint,
            status: "uploaded",
            platformFileId: uploadJson.data?.uuid || uploadJson.data?.id || null,
            uploadedAt: new Date().toISOString(),
            error: null,
          };
          draftStore.set(mutationKey, { ...mutationState, files: { ...mutationState.files } });
          console.log(`[resupply-upload] 이관 완료: ${file.name} → ${projectUuid}`);
        } catch (error) {
          // upload POST를 시작한 뒤의 예외는 서버 반영 여부를 알 수 없으므로 terminal review다.
          mutationState.files[fileId] = {
            ...checkpoint,
            status: "review_required",
            error: error.message,
          };
          mutationState.status = "review_required";
          draftStore.set(mutationKey, {
            ...mutationState,
            files: { ...mutationState.files },
            inProgress: false,
          });
          console.error(`[resupply-upload] 결과 불명확: ${file.name}`, error.message);
          break;
        }
      }

      const fileStates = Object.values(mutationState.files);
      const succeeded = fileStates.filter(file => file.status === "uploaded");
      const failed = fileStates.filter(file => file.status === "failed");
      const reviewRequired = fileStates.filter(file => file.status === "review_required");
      mutationState = {
        ...mutationState,
        status: reviewRequired.length
          ? "review_required"
          : failed.length
            ? "partial_failure"
            : "completed",
        inProgress: false,
        finishedAt: new Date().toISOString(),
        files: { ...mutationState.files },
      };
      draftStore.set(mutationKey, mutationState);
      const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });

      let resultText = "";
      if (succeeded.length) resultText += `✅ 이관 완료: ${succeeded.map(r => r.name).join(", ")}`;
      if (failed.length)    resultText += `${succeeded.length ? "\n" : ""}❌ 실패: ${failed.map(r => `${r.name} (${r.error})`).join(", ")}`;
      if (reviewRequired.length) resultText += `${resultText ? "\n" : ""}⚠️ 결과 확인 필요: ${reviewRequired.map(r => r.name).join(", ")} — 운영자가 TOTUS를 확인해줘.`;

      const notifyMeta = JSON.stringify({
        originalChannelId,
        originalTs,
        apmUserId,
        ownerUserId,
        workName,
        episode,
        uploadCompletionConfirmed: true,
        uploadMutationKey: mutationKey,
      });
      const actionElements = [];
      if (failed.length && !reviewRequired.length) {
        actionElements.push({
          type: "button",
          action_id: "resupply_upload_file",
          text: { type: "plain_text", text: "🔄 실패 파일만 재시도" },
          value: body.actions[0].value,
        });
      }
      if (mutationState.status === "completed") {
        actionElements.push({
          type: "button", action_id: "resupply_notify_worker",
          text: { type: "plain_text", text: "📢 작업자에게 완료 안내" },
          style: "primary", value: notifyMeta,
        });
      }
      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: resultText,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: resultText } },
          { type: "context", elements: [
            { type: "mrkdwn", text: `📤 *원본 이관* — <@${body.user.id}> · ${now}` },
          ]},
          ...(actionElements.length ? [{ type: "actions", elements: actionElements }] : []),
        ],
      }).catch(error => {
        const current = draftStore.get(mutationKey) || mutationState;
        draftStore.set(mutationKey, { ...current, uiPending: true, uiError: error.message });
      });
    } catch (e) {
      const current = draftStore.get(mutationKey) || mutationState;
      if (current.status !== "review_required") {
        draftStore.set(mutationKey, { ...current, inProgress: false });
      }
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
      const {
        originalChannelId,
        originalTs,
        uploadCompletionConfirmed,
        uploadMutationKey,
      } = meta;
      const expectedUploadMutationKey = `resupply_upload:${body.channel.id}:${body.message.ts}`;
      const uploadState = draftStore.get(expectedUploadMutationKey);
      const hasUploadCompletionEvidence = uploadCompletionConfirmed === true
        && uploadMutationKey === expectedUploadMutationKey
        && (!uploadState || uploadState.status === "completed");

      if (!hasUploadCompletionEvidence) {
        await client.chat.postMessage({
          channel: body.user.id,
          text: "⚠️ 모든 파일의 업로드 완료 증거를 확인할 수 없어 작업자에게 안내하지 않았어. 원본 이관을 먼저 완료해줘.",
        });
        return;
      }

      if (!originalChannelId || !originalTs) {
        await client.chat.postMessage({ channel: body.user.id,
          text: "⚠️ 원본 문의 스레드 정보가 없어. 직접 안내해줘." });
        return;
      }

      const notifyStateKey = `resupply_notify:${body.channel.id}:${body.message.ts}`;
      let notifyState = draftStore.get(notifyStateKey);
      if (notifyState?.status === RESUPPLY_NOTIFY_STATUS.SENDING) return;
      if (notifyState?.status === RESUPPLY_NOTIFY_STATUS.REVIEW_REQUIRED) {
        await client.chat.postMessage({
          channel: body.user.id,
          text: "⚠️ 작업자 안내 게시 결과가 불명확해 운영자 확인이 필요해. 안내 버튼을 다시 누르지 말아줘.",
        });
        return;
      }
      if (notifyState?.status === RESUPPLY_NOTIFY_STATUS.SENT && !notifyState.uiPending) return;

      if (!notifyState) {
        notifyState = {
          status: RESUPPLY_NOTIFY_STATUS.SENDING,
          uploadMutationKey,
          startedAt: new Date().toISOString(),
        };
        draftStore.set(notifyStateKey, notifyState);

        let replies;
        try {
          replies = await client.conversations.replies({
            channel: originalChannelId,
            ts: originalTs,
            limit: 100,
          });
        } catch (error) {
          draftStore.delete(notifyStateKey);
          console.error("resupply_notify_worker marker 조회 오류:", error.message);
          await client.chat.postMessage({
            channel: body.user.id,
            text: `⚠️ 기존 작업자 안내를 확인하지 못해 새 안내를 게시하지 않았어. 잠시 뒤 다시 시도해줘. (${error.message})`,
          });
          return;
        }

        const reconciledMessage = findMarkedFollowupMessage(
          replies.messages,
          notifyStateKey
        );
        if (reconciledMessage) {
          notifyState = {
            ...notifyState,
            status: RESUPPLY_NOTIFY_STATUS.SENT,
            notificationMessageTs: reconciledMessage.ts,
            reconciledAt: new Date().toISOString(),
            uiPending: true,
          };
          draftStore.set(notifyStateKey, notifyState);
        } else {
          let mentionText = "";
          try {
            const msgRes = await client.conversations.history({
              channel: originalChannelId, oldest: originalTs, latest: originalTs, inclusive: true, limit: 1,
            });
            const originalUser = msgRes.messages?.find(m => m.ts === originalTs)?.user || null;
            if (originalUser) mentionText = `<@${originalUser}> `;
          } catch (historyError) {
            console.error("resupply_notify_worker 원본 작성자 조회 오류:", historyError.message);
          }

          const notificationText = `${mentionText}✅ 원본 파일 교체가 완료되었습니다. 확인 부탁드립니다.`;
          try {
            const notificationResult = await client.chat.postMessage({
              channel: originalChannelId,
              thread_ts: originalTs,
              text: notificationText,
              blocks: [{
                type: "section",
                block_id: createCompletionFollowupMarker(notifyStateKey),
                text: { type: "mrkdwn", text: notificationText },
              }],
            });
            if (!notificationResult?.ts) {
              throw new Error("작업자 안내 메시지 ts를 확인할 수 없어.");
            }
            notifyState = {
              ...notifyState,
              status: RESUPPLY_NOTIFY_STATUS.SENT,
              notificationMessageTs: notificationResult.ts,
              sentAt: new Date().toISOString(),
              uiPending: true,
            };
            draftStore.set(notifyStateKey, notifyState);
          } catch (error) {
            draftStore.set(notifyStateKey, {
              ...notifyState,
              status: RESUPPLY_NOTIFY_STATUS.REVIEW_REQUIRED,
              reviewReason: "notification_outcome_unknown",
              reviewRequiredAt: new Date().toISOString(),
              error: error.message,
            });
            console.error("resupply_notify_worker 게시 결과 불명확:", error.message);
            await client.chat.postMessage({
              channel: body.user.id,
              text: `⚠️ 작업자 안내 게시 결과를 확인할 수 없어 운영자 확인이 필요해. 안내 버튼을 다시 누르지 말아줘. (${error.message})`,
            }).catch(notificationError => {
              console.error("resupply_notify_worker 실패 안내 오류:", notificationError.message);
            });
            return;
          }
        }
      }

      try {
        await client.chat.update({
          channel: body.channel.id,
          ts: body.message.ts,
          text: body.message.text,
          blocks: [
            ...(body.message.blocks || []).filter(b => b.type === "section"),
            { type: "context", elements: [
              { type: "mrkdwn", text: `📢 *작업자 안내 완료* — <@${body.user.id}> · ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}` },
            ]},
          ],
        });
      } catch (error) {
        draftStore.set(notifyStateKey, {
          ...draftStore.get(notifyStateKey),
          status: RESUPPLY_NOTIFY_STATUS.SENT,
          uiPending: true,
          uiError: error.message,
        });
        console.error("resupply_notify_worker UI 갱신 오류:", error.message);
        return;
      }

      draftStore.set(notifyStateKey, {
        ...draftStore.get(notifyStateKey),
        status: RESUPPLY_NOTIFY_STATUS.SENT,
        uiPending: false,
        uiUpdatedAt: new Date().toISOString(),
      });
    } catch (e) { console.error("resupply_notify_worker 오류:", e.message); }
  });
};
