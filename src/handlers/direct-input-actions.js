// 단일 책임: 직접입력·문의완료·드래프트편집 관련 action/view 핸들러를 Bolt app에 등록한다

"use strict";

/**
 * @param {import("@slack/bolt").App} app
 * @param {{
 *   draftStore: Map,
 *   buildDraftPreviewBlocks: Function,
 *   buildDraftPreviewText: Function,
 *   buildFileInquiryBlocks: Function,
 *   matchWorkTitleFromSheet: Function,
 *   fetchDeliveryDate: Function,
 *   handleFileOrderInquiry: Function,
 *   handleScheduleExt: Function,
 *   generateDraftId: Function,
 *   resolveApmUserId: Function,
 *   postInquiryToTargetChannel: Function,
 *   TARGET_CHANNEL_ID: string,
 *   handleWorkerRelay: Function,
 *   checkInquiryDone: Function,
 * }} deps
 */
module.exports = function registerDirectInputActions(app, deps) {
  const {
    draftStore,
    buildDraftPreviewBlocks,
    buildDraftPreviewText,
    buildFileInquiryBlocks,
    matchWorkTitleFromSheet,
    fetchDeliveryDate,
    handleFileOrderInquiry,
    handleScheduleExt,
    generateDraftId,
    resolveApmUserId,
    postInquiryToTargetChannel,
    TARGET_CHANNEL_ID,
    handleWorkerRelay,
    checkInquiryDone,
  } = deps;

  // ── 문의봇 완료 버튼 ─────────────────────────────────────
  app.action("inquiry_done", async ({ ack, body, client }) => {
    await ack();
    try {
      const meta = JSON.parse(body.actions[0].value || "{}");
      const { submitterId, draftId } = meta;
      const draft = draftId ? draftStore.get(draftId) : null;

      // PM 채널 메시지 완료 처리 (버튼 제거 + 완료 context 추가)
      await client.chat.update({
        channel: body.channel.id, ts: body.message.ts,
        text: body.message.text,
        blocks: [
          ...body.message.blocks.filter(b => b.type !== "actions"),
          { type: "context", elements: [
            { type: "mrkdwn", text: `✅ *완료 처리됨* — <@${body.user.id}> · ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}` },
          ]},
        ],
      });

      // 히스토리 시트 완료 체크박스 처리
      const historyRowIndex = draft?.historyRowIndex || null;
      if (historyRowIndex && typeof checkInquiryDone === "function") {
        await checkInquiryDone(historyRowIndex);
      }

      // PM 채널 메시지 스레드에 답변 작성 버튼 댓글 추가
      if (submitterId) {
        const replyMeta = JSON.stringify({
          originalChannelId: draft?.originalChannelId || null,
          originalTs:        draft?.originalTs        || null,
          sourceLink:        draft?.sourceLink        || null,
          submitterId:       submitterId,
        });
        await client.chat.postMessage({
          channel: body.channel.id,
          thread_ts: body.message.ts,
          text: `<@${submitterId}> 답변 작성 버튼입니다.`,
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: `<@${submitterId}> 원문 스레드에 답변을 남겨줘.` }},
            { type: "actions", elements: [
              { type: "button", action_id: "open_inquiry_reply_modal", text: { type: "plain_text", text: "✏️ 답변 작성" }, style: "primary", value: replyMeta },
            ]},
          ],
        });
      }
    } catch (e) { console.error("inquiry_done 오류:", e.message); }
  });

  // ── 문의봇 답변 작성 모달 ────────────────────────────────
  app.action("open_inquiry_reply_modal", async ({ ack, body, client }) => {
    await ack();
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal", callback_id: "submit_inquiry_reply_modal",
        private_metadata: body.actions[0].value,
        title:  { type: "plain_text", text: "원문 스레드 답변" },
        submit: { type: "plain_text", text: "답변 전송" },
        close:  { type: "plain_text", text: "취소" },
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "원문 스레드에 남길 답변을 작성해줘." }},
          { type: "input", block_id: "reply_block", label: { type: "plain_text", text: "답변 내용" },
            element: { type: "plain_text_input", action_id: "reply_input", multiline: true, placeholder: { type: "plain_text", text: "작업자에게 전달할 내용을 입력해줘." } }},
        ],
      },
    });
  });

  app.view("submit_inquiry_reply_modal", async ({ ack, body, view, client }) => {
    await ack();
    const meta = JSON.parse(view.private_metadata || "{}");
    const { originalChannelId, originalTs } = meta;
    const replyText = view.state.values.reply_block?.reply_input?.value?.trim() || "";
    if (!replyText) return;

    if (originalChannelId && originalTs) {
      // 원문 작성자 자동 멘션: 부모 메시지 fetch → user 꺼내기
      let mentionPrefix = "";
      try {
        const hist = await client.conversations.history({
          channel: originalChannelId,
          oldest: originalTs,
          latest: originalTs,
          inclusive: true,
          limit: 1,
        });
        const originalUserId = hist.messages?.[0]?.user;
        if (originalUserId) mentionPrefix = `<@${originalUserId}> `;
      } catch (e) {
        console.warn("[reply] 원문 작성자 조회 실패 (멘션 없이 전송):", e.message);
      }

      await client.chat.postMessage({
        channel: originalChannelId,
        thread_ts: originalTs,
        text: `${mentionPrefix}${replyText}`,
      });
      await client.chat.postMessage({ channel: body.user.id, text: "✅ 원문 스레드에 답변을 남겼어." });
    } else {
      await client.chat.postMessage({ channel: body.user.id, text: "⚠️ 원문 스레드 정보를 찾을 수 없어. 직접 답변해줘." });
    }
  });

  // ── DM 직접 소환: 재수급봇 ────────────────────────────────
  app.action("direct_resupply_btn", async ({ ack, body, client }) => {
    await ack();
    let btnData = {};
    try { btnData = JSON.parse(body.actions?.[0]?.value || "{}"); } catch {}
    const preWork    = btnData.workName || "";
    const preEpisode = btnData.episode  || "";
    const sourceLink = btnData.sourceLink || body.actions?.[0]?.value || "";
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal", callback_id: "direct_resupply_modal",
        private_metadata: JSON.stringify({ sourceLink }),
        title:  { type: "plain_text", text: "원본 재수급 요청" },
        submit: { type: "plain_text", text: "초안 생성" },
        close:  { type: "plain_text", text: "취소" },
        blocks: [
          { type: "input", block_id: "dr_work_block", label: { type: "plain_text", text: "작품명" },
            element: { type: "plain_text_input", action_id: "value", ...(preWork ? { initial_value: preWork } : { placeholder: { type: "plain_text", text: "예: 祭品新娘拐恶龙 / 서우전" } }) } },
          { type: "input", block_id: "dr_episode_block", label: { type: "plain_text", text: "회차 (숫자만)" },
            element: { type: "plain_text_input", action_id: "value", ...(preEpisode ? { initial_value: preEpisode } : { placeholder: { type: "plain_text", text: "예: 39" } }) } },
          { type: "input", block_id: "dr_files_block", label: { type: "plain_text", text: "파일/페이지 번호 (쉼표로 구분, 없으면 공백)" }, optional: true,
            element: { type: "plain_text_input", action_id: "value", placeholder: { type: "plain_text", text: "예: 5, 6, 7" } } },
          { type: "input", block_id: "dr_reason_block", label: { type: "plain_text", text: "재수급 사유" }, optional: true,
            element: { type: "plain_text_input", action_id: "value", placeholder: { type: "plain_text", text: "예: 파일 손상" } } },
          { type: "input", block_id: "dr_link_block", label: { type: "plain_text", text: "원문 링크" }, optional: true,
            element: { type: "plain_text_input", action_id: "value", ...(sourceLink ? { initial_value: sourceLink } : { placeholder: { type: "plain_text", text: "https://slack.com/archives/..." } }) } },
        ],
      },
    });
  });

  app.view("direct_resupply_modal", async ({ ack, body, view, client }) => {
    await ack();
    const { sourceLink: _preLink } = JSON.parse(view.private_metadata || "{}");
    const v        = view.state.values;
    const workName = v.dr_work_block?.value?.value?.trim() || "";
    const episode  = v.dr_episode_block?.value?.value?.trim() || "-";
    const fileNums = (v.dr_files_block?.value?.value || "").split(",").map(s => s.trim()).filter(Boolean);
    const reason   = v.dr_reason_block?.value?.value?.trim() || "원본 재수급 요청";
    const sourceLink = v.dr_link_block?.value?.value?.trim() || _preLink || "";

    const matchedTitle = await matchWorkTitleFromSheet(workName, workName).catch(() => null);
    const workNameKoRes = matchedTitle?.projectName || workName;
    const deliveryQueryName = matchedTitle?.projectName || workName;
    console.log("[resupply-manual] matchedTitle:", JSON.stringify({ ko: matchedTitle?.ko, projectName: matchedTitle?.projectName }), "| episode:", episode);
    const deliveryRes   = deliveryQueryName && episode && episode !== "-"
      ? await fetchDeliveryDate(deliveryQueryName, episode, "zh-ja", matchedTitle?.projectName || null).catch((e) => { console.error("[resupply-manual] fetchDelivery 오류:", e.message); return null; })
      : null;
    console.log("[resupply-manual] deliveryRes:", JSON.stringify(deliveryRes));
    const deliveryDateRes = deliveryRes
      ? (deliveryRes.allSame ? deliveryRes.deliveryDate : deliveryRes.episodes?.map(e=>`${e.episode}화:${e.deliveryDate}`).join(", "))
      : "-";
    const draftId = generateDraftId();
    const draft = {
      draftId, dmChannelId: body.user.id,
      originalChannelId: null, originalTs: null,
      sourceLink: sourceLink || "",
      workName:    workNameKoRes,
      episode,
      fileNumbers: fileNums,
      reason:      reason,
      deliveryDate: deliveryDateRes,

    // ✅ 추가
    apmName: deliveryRes?.apm || null,
    apmUserId: resolveApmUserId(deliveryRes?.apm || null),
  };

    draftStore.set(draftId, draft);
    await client.chat.postMessage({ channel: body.user.id, text: "원본 재수급 요청 초안", blocks: buildFileInquiryBlocks(draft) });
  });

  // ── DM 직접 소환: 스케줄봇 ────────────────────────────────
  app.action("direct_schedule_btn", async ({ ack, body, client }) => {
    await ack();
    let btnData = {};
    try { btnData = JSON.parse(body.actions?.[0]?.value || "{}"); } catch {}
    const preWork    = btnData.workName || "";
    const preEpisode = btnData.episode  || "";
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal", callback_id: "direct_schedule_modal",
        title:  { type: "plain_text", text: "스케줄 조회/변경" },
        submit: { type: "plain_text", text: "조회" },
        close:  { type: "plain_text", text: "취소" },
        blocks: [
          { type: "input", block_id: "ds_work_block", label: { type: "plain_text", text: "작품명" },
            element: { type: "plain_text_input", action_id: "value", ...(preWork ? { initial_value: preWork } : { placeholder: { type: "plain_text", text: "예: 本当は転生したくない / 미러월드" } }) } },
          { type: "input", block_id: "ds_episode_block", label: { type: "plain_text", text: "회차 (숫자만, 범위는 예: 236-238)" },
            element: { type: "plain_text_input", action_id: "value", ...(preEpisode ? { initial_value: preEpisode } : { placeholder: { type: "plain_text", text: "예: 49 또는 236-238" } }) } },
          { type: "input", block_id: "ds_extdays_block", label: { type: "plain_text", text: "연장 일수 (숫자만)" },
            element: { type: "plain_text_input", action_id: "value", placeholder: { type: "plain_text", text: "예: 3" } } },
        ],
      },
    });
  });

  app.view("direct_schedule_modal", async ({ ack, body, view, client }) => {
    await ack();
    const v        = view.state.values;
    const workName = v.ds_work_block?.value?.value?.trim() || "";
    const episode  = v.ds_episode_block?.value?.value?.trim() || "";
    const extDays  = parseInt(v.ds_extdays_block?.value?.value?.trim() || "", 10) || null;

    const matchedTitle = await matchWorkTitleFromSheet(workName, workName).catch(() => null);
    const workNameKo   = matchedTitle?.projectName || workName;
    const delivery     = episode
      ? await fetchDeliveryDate(workNameKo, episode, "zh-ja", matchedTitle?.projectName || null).catch(() => null)
      : null;

    if (delivery) {
      await client.chat.postMessage({ channel: body.user.id,
        text: `납품 시트 확인 완료 — *${delivery.episodeLabel}* 납품일: *${delivery.allSame ? delivery.deliveryDate : delivery.episodes.map(e=>`${e.episode}화:${e.deliveryDate}`).join(", ")}*` });
    } else {
      await client.chat.postMessage({ channel: body.user.id, text: `납품 시트에서 *${workNameKo}* ${episode}화를 찾지 못했어. 직접 확인해줘.` });
    }

    const parsed = {
      work_title_ja: workName, work_title_ko: workNameKo,
      episode,
      worker_type: "불명",
      requested_date: null,
      extend_days: extDays,
      isDirectCall: true,
      originalChannelId: null, originalTs: null,
    };
    await handleScheduleExt(client, body.user.id, parsed, matchedTitle, delivery, "");
  });

  // ── DM 직접 소환: 문의봇 ──────────────────────────────────
  app.action("direct_inquiry_btn", async ({ ack, body, client }) => {
    await ack();
    let btnData = {};
    try { btnData = JSON.parse(body.actions?.[0]?.value || "{}"); } catch {}
    const sourceLink = btnData.sourceLink || body.actions?.[0]?.value || "";
    const preWork    = btnData.workName || "";
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal", callback_id: "direct_inquiry_modal",
        private_metadata: JSON.stringify({ sourceLink }),
        title:  { type: "plain_text", text: "일반 문의 초안 작성" },
        submit: { type: "plain_text", text: "초안 생성" },
        close:  { type: "plain_text", text: "취소" },
        blocks: [
          { type: "input", block_id: "di_work_block", label: { type: "plain_text", text: "작품명 (일본어 또는 한국어)" },
            element: { type: "plain_text_input", action_id: "value", ...(preWork ? { initial_value: preWork } : { placeholder: { type: "plain_text", text: "예: 鬼滅の刃 / 귀멸의 칼날" } }) } },
          { type: "input", block_id: "di_episode_block", label: { type: "plain_text", text: "회차 (숫자만)" }, optional: true,
            element: { type: "plain_text_input", action_id: "value", placeholder: { type: "plain_text", text: "예: 118" } } },
          { type: "input", block_id: "di_type_block", label: { type: "plain_text", text: "문의 유형" },
            element: { type: "static_select", action_id: "value",
              initial_option: { text: { type: "plain_text", text: "기타" }, value: "기타" },
              options: ["스케줄 문의","원본 파일 순서","원본 파일 확인","번역문 누락","번역문 확인","번역문 수정","작업 관련 문의","수정&리테이크","복수 문의","기타"]
                .map(v => ({ text: { type: "plain_text", text: v }, value: v })) } },
          { type: "input", block_id: "di_content_block", label: { type: "plain_text", text: "문의 내용" },
            element: { type: "plain_text_input", action_id: "value", multiline: true, placeholder: { type: "plain_text", text: "문의 내용을 입력해줘" } } },
          { type: "input", block_id: "di_summary_block", label: { type: "plain_text", text: "요약 (없으면 공백)" }, optional: true,
            element: { type: "plain_text_input", action_id: "value", multiline: true } },
          { type: "input", block_id: "di_action_block", label: { type: "plain_text", text: "필요 액션 (없으면 공백)" }, optional: true,
            element: { type: "plain_text_input", action_id: "value" } },
          { type: "input", block_id: "di_link_block", label: { type: "plain_text", text: "원문 링크" }, optional: true,
            element: { type: "plain_text_input", action_id: "value", ...(sourceLink ? { initial_value: sourceLink } : { placeholder: { type: "plain_text", text: "https://slack.com/archives/..." } }) } },
        ],
      },
    });
  });

  app.view("direct_inquiry_modal", async ({ ack, body, view, client }) => {
    await ack();
    const { sourceLink: _preLink2 } = JSON.parse(view.private_metadata || "{}");
    const v          = view.state.values;
    const workName   = v.di_work_block?.value?.value?.trim() || "";
    const workNameKo = workName; // 단일 필드 — 일본어 또는 한국어 입력값 그대로 사용
    const episode        = v.di_episode_block?.value?.value?.trim() || null;
    const inquiryType    = v.di_type_block?.value?.selected_option?.value || "기타";
    const inquiryContent = v.di_content_block?.value?.value?.trim() || "";
    const summary        = v.di_summary_block?.value?.value?.trim() || "";
    const actionRequired = v.di_action_block?.value?.value?.trim() || "내용 확인 후 회신 필요";
    const sourceLink     = v.di_link_block?.value?.value?.trim() || _preLink2 || "";

    const matchedTitle = await matchWorkTitleFromSheet(workName, workNameKo).catch(() => null);
    const draftId = generateDraftId();
    const draft = {
      draftId, userId: body.user.id, dmChannelId: body.user.id,
      progressMessageTs: null,
      sourceLink: sourceLink || "",
      originalText: "",
      workName:      matchedTitle?.projectName || workName,
      workNameKo:    matchedTitle?.ko || workNameKo,
      pivoId:        matchedTitle?.pivoId || null,
      episode:       episode || null,
      inquiryType, inquiryContent, summary, actionRequired, sourceLang: "ko",
      deliveryDate:  episode && matchedTitle?.projectName
        ? await fetchDeliveryDate(matchedTitle.projectName, episode, "zh-ja", matchedTitle.projectName).catch(() => null).then(d => d ? (d.allSame ? d.deliveryDate : d.episodes?.map(e=>`${e.episode}화:${e.deliveryDate}`).join(", ")) : "-")
        : "-",
    };
    draftStore.set(draftId, draft);
    await client.chat.postMessage({ channel: body.user.id, text: buildDraftPreviewText(draft), blocks: buildDraftPreviewBlocks(draft) });
  });

  // ── DM 직접 소환: 파일순서봇 ─────────────────────────────
  app.action("direct_fileorder_btn", async ({ ack, body, client }) => {
    await ack();
    let btnData = {};
    try { btnData = JSON.parse(body.actions?.[0]?.value || "{}"); } catch {}
    const preWork    = btnData.workName || "";
    const preEpisode = btnData.episode  || "";
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal", callback_id: "direct_fileorder_modal",
        private_metadata: JSON.stringify({ dmChannelId: body.user.id }),
        title:  { type: "plain_text", text: "파일 순서 수정" },
        submit: { type: "plain_text", text: "확인" },
        close:  { type: "plain_text", text: "취소" },
        blocks: [
          { type: "input", block_id: "dfo_work_block", label: { type: "plain_text", text: "작품명" },
            element: { type: "plain_text_input", action_id: "value", ...(preWork ? { initial_value: preWork } : { placeholder: { type: "plain_text", text: "예: 祭品新娘拐恶龙 / ゾンビさん" } }) } },
          { type: "input", block_id: "dfo_episode_block", label: { type: "plain_text", text: "화수 (숫자만)" },
            element: { type: "plain_text_input", action_id: "value", ...(preEpisode ? { initial_value: preEpisode } : { placeholder: { type: "plain_text", text: "예: 60" } }) } },
        ],
      },
    });
  });

  app.view("direct_fileorder_modal", async ({ ack, body, view, client }) => {
    await ack();
    const { dmChannelId } = JSON.parse(view.private_metadata || "{}");
    const v        = view.state.values;
    const workName = v.dfo_work_block?.value?.value?.trim() || "";
    const episode  = v.dfo_episode_block?.value?.value?.trim() || "";
    const dmTarget = dmChannelId || body.user.id;

    if (!workName || !episode) {
      await client.chat.postMessage({ channel: dmTarget, text: "작품명과 화수를 모두 입력해줘." });
      return;
    }

    const matchedTitle       = await matchWorkTitleFromSheet(workName, workName).catch(() => null);
    const resolvedWorkNameKo = matchedTitle?.projectName || workName;

    await handleFileOrderInquiry(
      client, dmTarget,
      { title_ja: workName, title_ko: resolvedWorkNameKo, episode },
      { url: "", channelId: null, ts: null, requesterUserId: null },
      workName,
    );
  });

  // ── 작품명 직접 입력 (일반 문의) ─────────────────────────
  app.action("open_manual_title_modal", async ({ ack, body, client }) => {
    await ack();
    const pending = draftStore.get(body.actions?.[0]?.value);
    if (!pending) return;
    await client.views.open({ trigger_id: body.trigger_id, view: {
      type: "modal", callback_id: "manual_title_modal", private_metadata: JSON.stringify({ pendingId: body.actions[0].value }),
      title: { type: "plain_text", text: "작품명 직접 입력" }, submit: { type: "plain_text", text: "이 이름으로 초안 생성" }, close: { type: "plain_text", text: "취소" },
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*AI 추출 작품명:* \`${pending.titleJa||"없음"}\`` }},
        { type: "input", block_id: "manual_work_name_ja", label: { type: "plain_text", text: "작품명 (일본어)" }, element: { type: "plain_text_input", action_id: "value", initial_value: pending.titleJa||"", placeholder: { type: "plain_text", text: "예: 鬼滅の刃" } }},
        { type: "input", block_id: "manual_work_name_ko", label: { type: "plain_text", text: "작품명 (한국어, 없으면 공백)" }, optional: true, element: { type: "plain_text_input", action_id: "value", placeholder: { type: "plain_text", text: "예: 귀멸의 칼날" } }},
      ],
    }});
  });

  app.view("manual_title_modal", async ({ ack, body, view, client }) => {
    await ack();
    const { pendingId } = JSON.parse(view.private_metadata || "{}");
    const pending = draftStore.get(pendingId);
    if (!pending) return;
    const vals = view.state.values;
    const workNameJa = vals.manual_work_name_ja?.value?.value?.trim() || pending.titleJa || "";
    const workNameKo = vals.manual_work_name_ko?.value?.value?.trim() || "";
    const matchedManual = await matchWorkTitleFromSheet(workNameJa, workNameKo).catch(() => null);
    const draftId = generateDraftId();
    const draft = { draftId, userId: pending.userId, dmChannelId: pending.dmChannelId, progressMessageTs: pending.progressTs, sourceLink: pending.sourceLink, originalText: pending.originalText, workName: matchedManual?.projectName || workNameJa, workNameKo: matchedManual?.ko || workNameKo, pivoId: matchedManual?.pivoId || null, inquiryType: pending.inquiryType||"기타", inquiryContent: pending.inquiryContent||"", summary: pending.summary||"", actionRequired: pending.actionRequired||"", sourceLang: pending.sourceLang||"ja" };
    draftStore.set(draftId, draft);
    draftStore.delete(pendingId);
    await client.chat.postMessage({ channel: draft.dmChannelId, text: buildDraftPreviewText(draft), blocks: buildDraftPreviewBlocks(draft) });
  });

  // ── 문의봇 후보 작품 선택 버튼 ───────────────────────────
  app.action(/^inquiry_cand_pick_\d+$/, async ({ ack, body, client }) => {
    await ack();
    const { pendingId, pivoId, projectName } = JSON.parse(body.actions[0].value || "{}");
    const pending = draftStore.get(pendingId);
    if (!pending) return;

    const matchedTitle = { projectName, pivoId };
    const draftId = generateDraftId();
    const draft = {
      draftId,
      userId:             pending.userId,
      dmChannelId:        pending.dmChannelId,
      progressMessageTs:  pending.progressTs,
      sourceLink:         pending.sourceLink,
      originalText:       pending.originalText,
      workName:           projectName,
      workNameKo:         projectName,
      pivoId:             pivoId || null,
      inquiryType:        pending.inquiryType    || "기타",
      inquiryContent:     pending.inquiryContent || "",
      summary:            pending.summary        || "",
      actionRequired:     pending.actionRequired || "",
      sourceLang:         pending.sourceLang     || "ja",
    };
    draftStore.set(draftId, draft);
    draftStore.delete(pendingId);
    await client.chat.postMessage({ channel: draft.dmChannelId, text: buildDraftPreviewText(draft), blocks: buildDraftPreviewBlocks(draft) });
  });

  // ── 릴레이/문의 경계 폴백: 작업자 릴레이 선택 ───────────────
  // router ③-b가 stash한 route_pending 맥락으로 handleWorkerRelay 재실행 (원문 스레드 맥락 보존)
  app.action("route_pick_relay", async ({ ack, body, client }) => {
    await ack();
    const pendingId = body.actions?.[0]?.value;
    const pending = pendingId ? draftStore.get(pendingId) : null;
    if (!pending || pending.type !== "route_pending") {
      await client.chat.postMessage({ channel: body.user.id, text: "대기 중인 문의를 찾지 못했어. 다시 소환해줘." });
      return;
    }
    draftStore.delete(pendingId);
    await client.chat.update({ channel: body.channel.id, ts: body.message.ts,
      text: "📨 작업자 릴레이로 처리할게.",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "📨 *작업자 릴레이*로 처리 중..." }}] });
    await handleWorkerRelay(
      client, pending.dmChannel, pending.analysis,
      { url: pending.sourceLink, channelId: pending.channelId, ts: pending.ts },
      pending.relayText, pending.requesterUserId, pending.relayImageUrls,
    );
  });

  // ── 릴레이/문의 경계 폴백: PM 문의(문의봇) 선택 ─────────────
  // 분석 결과로 PM 문의 draft 생성 (inquiryType은 "작업 관련 문의"로 확정). 원문 스레드 정보 보존 → 답변 버튼 동작
  app.action("route_pick_inquiry", async ({ ack, body, client }) => {
    await ack();
    const pendingId = body.actions?.[0]?.value;
    const pending = pendingId ? draftStore.get(pendingId) : null;
    if (!pending || pending.type !== "route_pending") {
      await client.chat.postMessage({ channel: body.user.id, text: "대기 중인 문의를 찾지 못했어. 다시 소환해줘." });
      return;
    }
    draftStore.delete(pendingId);
    const a = pending.analysis;
    const matchedTitle = await matchWorkTitleFromSheet(a.title_ja, a.title_ko).catch(() => null);
    const draftId = generateDraftId();
    const draft = {
      draftId,
      userId:            body.user.id,
      dmChannelId:       pending.dmChannel,
      progressMessageTs: null,
      sourceLink:        pending.sourceLink,
      originalText:      pending.originalText,
      originalChannelId: pending.channelId,
      originalTs:        pending.ts,
      workName:      matchedTitle?.projectName || a.title_ko || a.title_ja || "",
      workNameKo:    matchedTitle?.ko || "",
      pivoId:        matchedTitle?.pivoId || null,
      episode:       a.episode || null,
      inquiryType:   "작업 관련 문의",
      inquiryContent: a.translated_ko   || "",
      summary:        a.summary_ko      || "",
      actionRequired: a.action_required || "",
      sourceLang:     a.source_lang     || "ja",
    };
    draftStore.set(draftId, draft);
    await client.chat.update({ channel: body.channel.id, ts: body.message.ts,
      text: "📝 PM 문의로 처리할게.",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "📝 *PM 문의(문의봇)*로 처리 중..." }}] });
    await client.chat.postMessage({ channel: pending.dmChannel, text: buildDraftPreviewText(draft), blocks: buildDraftPreviewBlocks(draft) });
  });

  // ── 수정 모달 ─────────────────────────────────────────────
  app.action("open_inquiry_modal", async ({ ack, body, client }) => {
    await ack();
    const draft = draftStore.get(body.actions?.[0]?.value);
    if (!draft) { await client.chat.postMessage({ channel: body.user.id, text: "초안을 찾지 못했어." }); return; }
    await client.views.open({ trigger_id: body.trigger_id, view: {
      type: "modal", callback_id: "submit_inquiry_modal", private_metadata: JSON.stringify({ draftId: body.actions[0].value }),
      title: { type: "plain_text", text: "문의 수정" }, submit: { type: "plain_text", text: "전송" }, close: { type: "plain_text", text: "취소" },
      blocks: [
        { type: "input", block_id: "work_name_block", label: { type: "plain_text", text: "작품명 (일본어)" }, element: { type: "plain_text_input", action_id: "work_name_input", initial_value: draft.workName||"" }},
        { type: "input", block_id: "work_name_ko_block", label: { type: "plain_text", text: "작품명 (한국어)" }, optional: true, element: { type: "plain_text_input", action_id: "work_name_ko_input", initial_value: draft.workNameKo||"" }},
        { type: "input", block_id: "episode_block", label: { type: "plain_text", text: "회차 (숫자만)" }, optional: true, element: { type: "plain_text_input", action_id: "episode_input", initial_value: draft.episode||"" }},
        { type: "input", block_id: "inquiry_type_block", label: { type: "plain_text", text: "문의 유형" }, element: { type: "plain_text_input", action_id: "inquiry_type_input", initial_value: draft.inquiryType||"" }},
        { type: "input", block_id: "inquiry_content_block", label: { type: "plain_text", text: "문의 내용" }, element: { type: "plain_text_input", action_id: "inquiry_content_input", multiline: true, initial_value: draft.inquiryContent||"" }},
        { type: "input", block_id: "summary_block", label: { type: "plain_text", text: "요약" }, element: { type: "plain_text_input", action_id: "summary_input", multiline: true, initial_value: draft.summary||"" }},
        { type: "input", block_id: "action_block", label: { type: "plain_text", text: "필요 액션" }, element: { type: "plain_text_input", action_id: "action_input", initial_value: draft.actionRequired||"" }},
        { type: "input", block_id: "link_block", label: { type: "plain_text", text: "원문 링크" }, element: { type: "plain_text_input", action_id: "link_input", initial_value: draft.sourceLink||"" }},
      ],
    }});
  });

  app.action("send_inquiry_now", async ({ ack, body, client }) => {
    await ack();
    const draft = draftStore.get(body.actions?.[0]?.value);
    if (!draft) { await client.chat.postMessage({ channel: body.user.id, text: "초안을 찾지 못했어." }); return; }
    await postInquiryToTargetChannel(client, draft, body.user.id);
    await client.chat.postMessage({ channel: body.user.id, text: `<#${TARGET_CHANNEL_ID}> 에 전송 완료!` });
  });

  app.view("submit_inquiry_modal", async ({ ack, body, view, client }) => {
    await ack();
    const { draftId } = JSON.parse(view.private_metadata || "{}");
    const draft = draftStore.get(draftId);
    if (!draft) { await client.chat.postMessage({ channel: body.user.id, text: "초안을 찾지 못했어." }); return; }
    const v = view.state.values;
    draft.workName       = v.work_name_block?.work_name_input?.value?.trim()             || "";
    draft.workNameKo     = v.work_name_ko_block?.work_name_ko_input?.value?.trim()       || "";
    draft.episode        = v.episode_block?.episode_input?.value?.trim()                 || "";
    draft.inquiryType    = v.inquiry_type_block?.inquiry_type_input?.value?.trim()       || "";
    draft.inquiryContent = v.inquiry_content_block?.inquiry_content_input?.value?.trim() || "";
    draft.summary        = v.summary_block?.summary_input?.value?.trim()                 || "";
    draft.actionRequired = v.action_block?.action_input?.value?.trim()                   || "";
    draft.sourceLink     = v.link_block?.link_input?.value?.trim()                       || "";
    draftStore.set(draftId, draft);
    await postInquiryToTargetChannel(client, draft, body.user.id);
    await client.chat.update({ channel: draft.dmChannelId, ts: draft.progressMessageTs, text: buildDraftPreviewText(draft), blocks: buildDraftPreviewBlocks(draft) });
    await client.chat.postMessage({ channel: body.user.id, text: `수정 내용으로 <#${TARGET_CHANNEL_ID}> 에 전송 완료!` });
  });
};
