// 단일 책임: 스케줄 문의 관련 action/view 핸들러를 Bolt app에 등록한다

"use strict";

const {
  readKoreanProjectNameFromSelectionPayload,
} = require("../slack/title-selection-payload");
const { withinAckBudget } = require("../utils/ack-budget");

/**
 * @param {import("@slack/bolt").App} app
 * @param {{
 *   draftStore: Map,
 *   loadTitleRowsFromSheet: Function,
 *   matchWorkTitleFromSheet: Function,
 *   fetchDeliveryDate: Function,
 *   handleScheduleExt: Function,
 *   langRouting: { channelFor: Function, pmSlackIdFor: Function },
 * }} deps
 */
module.exports = function registerScheduleActions(app, deps) {
  const {
    draftStore,
    loadTitleRowsFromSheet,
    matchWorkTitleFromSheet,
    fetchDeliveryDate,
    handleScheduleExt,
    langRouting,
  } = deps;

  // 납품일 변경 요청의 목적지·수신 PM 은 작품의 언어가 정한다.
  // delivery.lang 은 납품 탭을 고른 언어 그 자체라 가장 믿을 만하다(fetchDeliveryDate 가 실어 보낸다).
  // 납품일을 못 찾아도 소환 이모지가 가리킨 언어로 떨어진다(AIA C3).
  const langOf = (data) => data?.delivery?.lang || data?.lang || data?.langPair || null;

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
    const langPair = langOf(data);
    const SCHEDULE_CHANNEL_ID = langRouting.channelFor("schedule", langPair);
    const lines = [
      `<@${langRouting.pmSlackIdFor(langPair)}>`, `안녕하세요.`, `아래 작품 납품일 변경이 가능할지 문의 드립니다.`,
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
            optional: true,
            element: { type: "plain_text_input", action_id: "title_ja_input",
              initial_value: pending.parsed?.work_title_ja || pending.parsed?.work_title_ko || "",
              placeholder: { type: "plain_text", text: "예: 本当は転生したくない 또는 미러월드" } }},
          { type: "input", block_id: "sched_pivoid_block", label: { type: "plain_text", text: "PIVO ID (작품명 대신 입력 가능)" },
            optional: true,
            element: { type: "plain_text_input", action_id: "value",
              placeholder: { type: "plain_text", text: "예: 82357" } }},
        ],
      },
    });
  });

  app.view("schedule_title_modal", async ({ ack, body, view, client }) => {
    const { pendingId } = JSON.parse(view.private_metadata || "{}");
    const pending = draftStore.get(pendingId);
    const titleInput   = view.state.values.title_ja_block?.title_ja_input?.value?.trim() || "";
    const pivoInput    = view.state.values.sched_pivoid_block?.value?.value?.trim() || "";

    // 둘 다 비면 창 안에서 막는다. 종전엔 빈 값으로 제출돼 작품 없는 초안이 만들어졌다.
    if (!titleInput && !pivoInput) {
      await ack({ response_action: "errors", errors: { title_ja_block: "작품명이나 PIVO ID 중 하나는 입력해줘." } });
      return;
    }
    // PIVO 를 먼저 보되 **틀렸다고 제목을 버리지 않는다**. 종전엔 PIVO 가 틀리면 제목을 적어도
    // 무시돼서 작품을 못 찾았다(2026-10-28 AIA 리뷰).
    const lookup = (async () => {
      const byPivo = pivoInput ? await matchWorkTitleFromSheet({ pivoId: pivoInput }).catch(() => null) : null;
      if (byPivo) return byPivo;
      return titleInput ? await matchWorkTitleFromSheet(titleInput, titleInput).catch(() => null) : null;
    })();
    // ★3초 안에 ack 하지 못하면 Slack 이 제 오류창을 띄우고 입력도 날아간다. 캐시가 식은
    //   날엔 시트 조회만으로 그 시간을 넘길 수 있어, 예산을 넘기면 창부터 닫는다.
    const { timedOut, value } = await withinAckBudget(lookup);
    let matchedTitle = value;
    const notFoundMsg = () => (titleInput
      ? `PIVO ID ${pivoInput} 도, 작품명 「${titleInput}」 도 못 찾았어.`
      : `PIVO ID ${pivoInput} 에 해당하는 작품을 못 찾았어. 작품명으로도 넣어볼 수 있어.`);

    if (!timedOut) {
      // ★PIVO 를 적었는데 못 찾은 경우만 창 안에서 막는다. 닫고 나서 "못 찾았어"라고 하면
      //   처음부터 다시 열어야 한다.
      //   제목만 적고 못 찾은 건 막지 않는다 — 마스터에 없는 작품도 원문 이름으로 스케줄
      //   요청을 넣을 수 있어야 한다(title-meaning-r3 에 고정된 기존 동작).
      if (!matchedTitle && pivoInput) {
        await ack({ response_action: "errors", errors: { sched_pivoid_block: notFoundMsg() } });
        return;
      }
      await ack();
    } else {
      await ack();
      matchedTitle = await lookup;   // 창은 닫았으니 조회는 뒤에서 마저 기다린다
      if (!matchedTitle && pivoInput) {
        // 창이 이미 닫혀 인라인 오류를 못 쓴다 — 같은 내용을 DM 으로 알린다.
        await client.chat.postMessage({ channel: body.user.id, text: notFoundMsg() })
          .catch(e => console.error("[schedule_title_modal] PIVO 미발견 DM 실패:", e?.message ?? e));
        // ★예산 안 분기와 같게 여기서 멈춘다. 안 멈추면 빈 작품명으로 납품일 조회·초안 생성까지
        //   진행하고, 아래에서 pending 을 지워 「직접 입력」 재시도 경로까지 사라진다(AIA C1).
        return;
      }
    }
    if (!pending) return;
    const koreanProjectName = matchedTitle?.koreanProjectName || null;
    const displayWorkName = koreanProjectName || titleInput || matchedTitle?.japaneseDisplayTitle || "";
    const originalWorkTitle = titleInput || pending.parsed?.work_title_ja || null;
    const delivery     = pending.parsed?.episode
      ? await fetchDeliveryDate(displayWorkName, pending.parsed.episode, matchedTitle?.lang || "zh-ja" /* 납품 탭은 이모지가 아니라 확정된 작품이 고른다 */, koreanProjectName).catch(() => null)
      : null;
    if (delivery) {
      await client.chat.postMessage({ channel: body.user.id, text: `*${delivery.workName} ${delivery.episodeLabel}* 납품일: *${delivery.allSame ? delivery.deliveryDate : delivery.episodes?.map(e=>`${e.episode}화:${e.deliveryDate}`).join(", ")}*` });
    } else {
      await client.chat.postMessage({ channel: body.user.id, text: `납품 시트에서 *${displayWorkName}* 를 찾지 못했어. 직접 확인해줘.` });
    }
    await handleScheduleExt(client, body.user.id, {
      ...pending.parsed,
      ownerUserId: pending.ownerUserId || pending.parsed?.ownerUserId || null,
      displayWorkName,
      originalWorkTitle,
      koreanProjectName,
      work_title_ja: pending.parsed?.work_title_ja || originalWorkTitle,
      work_title_ko: koreanProjectName,
    }, matchedTitle, delivery, pending.sourceLink || "");
    draftStore.delete(pendingId);
  });

  // ── 토큰 매칭 후보 선택 버튼 ─────────────────────────────
  app.action(/^schedule_token_pick_\d+$/, async ({ ack, body, client }) => {
    await ack();
    const selection = JSON.parse(body.actions[0].value || "{}");
    const { pendingId, pivoId, lang: pickedLang } = selection;
    const koreanProjectName = readKoreanProjectNameFromSelectionPayload(selection);
    const pending = draftStore.get(pendingId);
    if (!pending) return;

    const rows = await loadTitleRowsFromSheet();
    // ★pivoId 가 빈 후보(마스터에 PIVO 가 없는 작품)를 누르면 "" === "" 로 PIVO 칸이 빈
    //   첫 행 — 전혀 다른 작품 — 이 걸린다. 빈 값일 땐 조회 자체를 하지 않는다.
    const matchedTitle = (pivoId && rows.find(row => row.pivoId === pivoId))
      || { koreanProjectName, pivoId, lang: pickedLang || null };
    const workNameKo   = matchedTitle.koreanProjectName || koreanProjectName;
    // 버튼이 실어 온 lang 이 1순위 — 소환 이모지로 이미 언어가 갈린 결과다.
    const delivery     = pending.parsed?.episode
      ? await fetchDeliveryDate(workNameKo, pending.parsed.episode, pickedLang || matchedTitle?.lang || "zh-ja", workNameKo).catch(() => null)
      : null;

    if (delivery) {
      await client.chat.postMessage({ channel: body.user.id,
        text: `납품 시트 확인 완료 — *${delivery.episodeLabel}* 납품일: *${delivery.allSame ? delivery.deliveryDate : delivery.episodes?.map(e=>`${e.episode}화:${e.deliveryDate}`).join(", ")}*` });
    } else {
      await client.chat.postMessage({ channel: body.user.id, text: `납품 시트에서 *${workNameKo}* 를 찾지 못했어. 직접 확인해줘.` });
    }
    await handleScheduleExt(client, body.user.id, {
      ...pending.parsed,
      ownerUserId: pending.ownerUserId || pending.parsed?.ownerUserId || null,
      work_title_ko: workNameKo,
    }, matchedTitle, delivery, pending.sourceLink || "");
    draftStore.delete(pendingId);
  });
};
