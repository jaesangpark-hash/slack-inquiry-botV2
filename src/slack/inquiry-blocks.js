// 단일 책임: Slack 문의 관련 블록/메시지 포매터 (문의 초안·재수급·요약 빌더)
"use strict";

// ── 우선순위 이모지 매핑 ─────────────────────────────────────
const PRIORITY_EMOJI = { 높음: "🔴", 보통: "🟡", 낮음: "🟢" };

/**
 * @param {{ pmSlackId: string, fixedMentionUserIds: string[] }} deps
 */
module.exports = function createInquiryBlocks({ pmSlackId, fixedMentionUserIds }) {

  // ── 재수급 reason 조립 ────────────────────────────────────
  // matchedTitle: 시트 매칭 결과 { ko, jaDisplay } | null
  // fileParsed: parseFileInquiry 결과
  function buildFileInquiryReason(fileParsed, matchedTitle) {
    const workName = matchedTitle?.projectName || fileParsed.work_title_ko || fileParsed.work_title_ja || null;
    const episode  = fileParsed.episode ? `${fileParsed.episode}화` : null;
    const rawReason = fileParsed.reason_raw || null;

    // 작품명+화수+사유 조합, 없는 항목은 생략
    const parts = [];
    if (workName) parts.push(workName);
    if (episode)  parts.push(episode);
    const prefix = parts.length ? parts.join(" ") + " " : "";

    return rawReason ? `${prefix}${rawReason}` : (prefix ? `${prefix}원본 재수급 요청` : "원본 재수급 요청");
  }

  // ── 원본 파일 재수급 UI ───────────────────────────────────
  function buildFileInquiryBlocks(draft) {
    const fileNums = draft.fileNumbers?.length ? draft.fileNumbers.join(", ") : "-";
    const apmDisplay = draft.apmUserId
      ? `<@${draft.apmUserId}>`
      : draft.apmName
        ? `${draft.apmName} ⚠️ Slack ID 미매핑`
        : "-";
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: "*📦 원본 재수급 요청 초안*" }},
      { type: "section", text: { type: "mrkdwn", text:
        `*작품명:* ${draft.workName||"-"}\n*회차:* ${draft.episode ? draft.episode+"화" : "-"}\n*납품일:* ${draft.deliveryDate||"-"}\n*파일/페이지 번호:* ${fileNums}\n*재수급 사유:* ${draft.reason||"-"}\n*APM:* ${apmDisplay}` }},
      { type: "context", elements: [
        { type: "mrkdwn", text: "💬 내용 확인이 필요한 문의라면 `문의봇` 이라고 입력해줘." },
      ]},
    ];
    // APM 미매핑 시 직접 입력 안내 추가
    if (!draft.apmUserId) {
      blocks.push({ type: "context", elements: [
        { type: "mrkdwn", text: `⚠️ APM *${draft.apmName || "미확인"}* 의 Slack ID를 찾지 못했어. 수정 버튼에서 직접 입력하거나 담당자를 확인해줘.` },
      ]});
    }
    blocks.push({ type: "actions", block_id: "file_inquiry_actions", elements: [
      { type: "button", action_id: "open_file_inquiry_modal", text: { type: "plain_text", text: "수정" }, style: "primary", value: draft.draftId },
      { type: "button", action_id: "send_file_inquiry_now", text: { type: "plain_text", text: "전송" }, style: "danger", value: draft.draftId,
        confirm: { title: { type: "plain_text", text: "전송할까?" }, text: { type: "mrkdwn", text: "PM 채널에 재수급 요청을 전송해." }, confirm: { type: "plain_text", text: "전송" }, deny: { type: "plain_text", text: "취소" } }},
    ]});
    return blocks;
  }

  function buildFileInquiryMessage(draft, submitterId) {

    const fileNums = draft.fileNumbers?.length
      ? draft.fileNumbers.join(", ")
      : "-";

    // APM 표시 — apmUserId 있으면 멘션, 없으면 이름 텍스트, 둘 다 없으면 봇 실행자
    const apmText = draft.apmUserId
      ? `<@${draft.apmUserId}>`
      : draft.apmName || `<@${submitterId}>`;

    const meta = JSON.stringify({
      originalChannelId: draft.originalChannelId || null,
      originalTs: draft.originalTs || null,
      // 미매핑 시 null — 완료 처리 시 APM DM 전송 생략
      apmUserId: draft.apmUserId || null,
      workName: draft.workName || "-",
      episode: draft.episode || "-",
      resupplyRowIndex: draft.resupplyRowIndex || null,
    });

    const msgText = [
      `<@${pmSlackId}>`,
      `안녕하세요.`,
      `아래 작품 원본 파일 재수급을 요청 드립니다.`,
      `- 담당자 : <@${submitterId}>`,
      `- APM : ${apmText}`,
      `- 작품명 : ${draft.workName || "-"}`,
      `- 회차 : ${draft.episode ? draft.episode + "화" : "-"}`,
      `- 파일/페이지 번호 : ${fileNums}`,
      `- 납품일 : ${draft.deliveryDate || "-"}`,
      `- 재수급 사유 : ${draft.reason || "-"}`,
    ].join("\n");

    return {
      text: msgText,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: msgText
          }
        },
        {
          type: "actions",
          block_id: "resupply_actions",
          elements: [
            {
              type: "button",
              action_id: "file_resupply_done",
              text: {
                type: "plain_text",
                text: "✅ 재수급 완료"
              },
              style: "primary",
              value: meta,
              confirm: {
                title: {
                  type: "plain_text",
                  text: "재수급 완료 처리할까요?"
                },
                text: {
                  type: "mrkdwn",
                  text: "원문 스레드에 완료 댓글을 달고 담당자를 멘션합니다."
                },
                confirm: {
                  type: "plain_text",
                  text: "완료 처리"
                },
                deny: {
                  type: "plain_text",
                  text: "취소"
                }
              }
            }
          ]
        }
      ]
    };
  }

  function buildDraftPreviewBlocks(draft) {
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: `*문의 초안*` }},
      { type: "section", text: { type: "mrkdwn", text: `*작품명:* ${draft.workName||"-"}${draft.workNameKo && draft.workNameKo !== draft.workName ? `　(${draft.workNameKo})` : ""}\n*회차:* ${draft.episode ? draft.episode+"화" : "-"}\n*납품일:* ${draft.deliveryDate||"-"}\n*문의 유형:* ${draft.inquiryType||"-"}` }},
    ];

    // 스레드 맥락이 있으면 요약만, 없으면 전체 내용 표시
    if (draft.hasThreadContext) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: `*요약:*\n${draft.summary||"-"}` }});
      blocks.push({ type: "section", text: { type: "mrkdwn", text: `*필요 액션:*\n${draft.actionRequired||"-"}` }});
      blocks.push({ type: "context", elements: [
        { type: "mrkdwn", text: "💬 스레드 전체 맥락을 분석했어. 상세 내용은 원문 링크에서 확인해줘." },
      ]});
    } else {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${draft.sourceLang === "ko" ? "문의 내용" : "번역 내용"}:*\n${draft.inquiryContent||"-"}` }});
      blocks.push({ type: "section", text: { type: "mrkdwn", text: `*요약:*\n${draft.summary||"-"}` }});
      blocks.push({ type: "section", text: { type: "mrkdwn", text: `*필요 액션:*\n${draft.actionRequired||"-"}` }});
    }

    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*원문 링크:*\n${draft.sourceLink||"-"}` }});

    // 작업 관련 문의일 경우 재수급봇 유도 문구 추가
    if (draft.inquiryType === "작업 관련 문의") {
      blocks.push({ type: "context", elements: [
        { type: "mrkdwn", text: "📦 원본 재수급이 필요하다고 판단되면 `재수급봇` 이라고 입력해줘." },
      ]});
    }

    blocks.push({ type: "actions", block_id: "draft_actions", elements: [
      { type: "button", action_id: "open_inquiry_modal", text: { type: "plain_text", text: "수정" }, style: "primary", value: draft.draftId },
      { type: "button", action_id: "send_inquiry_now", text: { type: "plain_text", text: "바로 전송" }, style: "danger", value: draft.draftId,
        confirm: { title: { type: "plain_text", text: "전송할까?" }, text: { type: "mrkdwn", text: "현재 초안을 지정 채널에 전송해." }, confirm: { type: "plain_text", text: "전송" }, deny: { type: "plain_text", text: "취소" } }},
    ]});

    return blocks;
  }

  function buildDraftPreviewText(draft) {
    return [`*문의 초안*`, "", `• 작품명: ${draft.workName||"-"}${draft.workNameKo && draft.workNameKo !== draft.workName ? `  (${draft.workNameKo})` : ""}`, `• 회차: ${draft.episode ? draft.episode+"화" : "-"}`, `• 문의 유형: ${draft.inquiryType||"-"}`, `• 요약: ${draft.summary||"-"}`, `• 필요 액션: ${draft.actionRequired||"-"}`, `• 원문 링크: ${draft.sourceLink||"-"}`].join("\n");
  }

  function buildFinalMainMessage({ submitterId, workName, workNameKo, episode, inquiryType, inquiryContent, actionRequired, draftId, historyRowIndex }) {
    const mentions = fixedMentionUserIds.map(id => `<@${id}>`).join(" ");
    const fallbackText = `${workName||"-"} | ${inquiryType||"-"} | <@${submitterId}>`;
    // historyRowIndex를 버튼 값에 직접 박아둔다 — draftStore(인메모리)는 프로세스 재시작 시 사라지므로,
    // 완료 클릭이 며칠 뒤에 일어나도 시트 체크박스 처리가 가능하도록 메시지 자체에 영속시킨다.
    const meta = JSON.stringify({ submitterId, draftId: draftId || null, historyRowIndex: historyRowIndex || null });
    return {
      text: fallbackText,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `${mentions}` }},
        { type: "divider" },
        { type: "section", fields: [
          { type: "mrkdwn", text: `*작품명*\n${workName||"-"}` },
          { type: "mrkdwn", text: `*회차*\n${episode ? episode+"화" : "-"}` },
          { type: "mrkdwn", text: `*문의 유형*\n${inquiryType||"-"}` },
          { type: "mrkdwn", text: `*담당자*\n<@${submitterId}>` },
        ]},
        { type: "divider" },
        { type: "section", text: { type: "mrkdwn", text: `*문의 내용*\n${inquiryContent||"-"}` }},
        { type: "divider" },
        { type: "section", text: { type: "mrkdwn", text: `⚡ *필요 액션*\n${actionRequired||"-"}` }},
        { type: "divider" },
        { type: "actions", elements: [
          { type: "button", action_id: "inquiry_done", text: { type: "plain_text", text: "✅ 완료" }, style: "primary", value: meta,
            confirm: { title: { type: "plain_text", text: "완료 처리할까요?" }, text: { type: "mrkdwn", text: "APM에게 답변 작성 버튼이 전달됩니다." }, confirm: { type: "plain_text", text: "완료" }, deny: { type: "plain_text", text: "취소" } }},
        ]},
      ],
    };
  }

  function buildThreadMessage({ summary, sourceLink }) {
    return `📋 *요약*\n${summary||"-"}\n\n🔗 *원문 링크*\n${sourceLink||"-"}`;
  }

  // ── 복수 문의 요약 메시지 ────────────────────────────────
  function buildInquirySummaryMessage(analysis, { icon, label, guide }, titleInfo = {}) {
    const workLine    = titleInfo.workName ? `*작품명:* ${titleInfo.workName}` : null;
    const episodeLine = titleInfo.episode  ? `*회차:* ${titleInfo.episode}화`  : null;
    const infoLines   = [workLine, episodeLine].filter(Boolean);
    return [
      `*${icon} ${label}*`,
      ``,
      ...(infoLines.length ? [...infoLines, ``] : []),
      `*번역 내용:*\n${analysis.translated_ko || "-"}`,
      ``,
      `*요약:* ${analysis.summary_ko || "-"}`,
      `*필요 액션:* ${analysis.action_required || "-"}`,
      ``,
      guide,
      `→ \`재수급봇\` / \`스케줄봇\` / \`문의봇\` / \`파일순서봇\` / \`태스크생성봇\``,
    ].join("\n");
  }

  function buildMultipleInquirySummary(analysis, titleInfo = {}) {
    return buildInquirySummaryMessage(analysis, {
      icon:  "⚠️",
      label: "복수 문의 감지",
      guide: "복수 문의가 감지됐어. 필요한 봇을 직접 소환해줘.",
    }, titleInfo);
  }

  function buildOtherInquirySummary(analysis, titleInfo = {}) {
    return buildInquirySummaryMessage(analysis, {
      icon:  "❓",
      label: "유형 미분류 문의",
      guide: "유형을 특정할 수 없어. 필요한 봇을 직접 소환해줘.",
    }, titleInfo);
  }

  return {
    PRIORITY_EMOJI,
    buildFileInquiryReason,
    buildFileInquiryBlocks,
    buildFileInquiryMessage,
    buildDraftPreviewBlocks,
    buildDraftPreviewText,
    buildFinalMainMessage,
    buildThreadMessage,
    buildInquirySummaryMessage,
    buildMultipleInquirySummary,
    buildOtherInquirySummary,
  };
};
