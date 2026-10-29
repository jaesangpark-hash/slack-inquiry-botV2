// 단일 책임: Slack 문의 관련 블록/메시지 포매터 (문의 초안·재수급·요약 빌더)
"use strict";

// ── 우선순위 이모지 매핑 ─────────────────────────────────────
const PRIORITY_EMOJI = { 높음: "🔴", 보통: "🟡", 낮음: "🟢" };

/**
 * 수신자는 언어쌍마다 다르다(중일/한일 담당 APM 이 다름). 그래서 고정값이 아니라
 * **언어쌍을 받아 되돌려 주는 함수**를 주입받는다 — 표는 config/lang-routing.js 한 곳에 있다.
 *
 * @param {{ pmSlackIdFor: (langPair: string|null) => string,
 *            mentionUserIdsFor: (langPair: string|null) => string[] }} deps
 */
module.exports = function createInquiryBlocks({ pmSlackIdFor, mentionUserIdsFor }) {

  // ── 재수급 reason 조립 ────────────────────────────────────
  // matchedTitle: 시트 매칭 결과 { koreanProjectName, japaneseDisplayTitle } | null
  // fileParsed: parseFileInquiry 결과
  function buildFileInquiryReason(fileParsed, matchedTitle) {
    const workName = matchedTitle?.koreanProjectName || fileParsed.work_title_ko || fileParsed.work_title_ja || null;
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
      sourceLink: draft.sourceLink || null,
      // 미매핑 시 null — 완료 처리 시 APM DM 전송 생략
      apmUserId: draft.apmUserId || null,
      submitterId,
      ownerUserId: draft.ownerUserId || submitterId,
      workName: draft.workName || "-",
      episode: draft.episode || "-",
      resupplyRowIndex: draft.resupplyRowIndex || null,
    });

    // 재수급 요청을 받는 PM 도 언어쌍마다 다르다. draft.lang 은 매칭된 작품이 정한 값이라
    // 이모지 신호가 없는 DM 소환에서도 맞는다. 모르면(null) 공통 PM 으로 간다.
    const msgText = [
      `<@${pmSlackIdFor(draft.lang || null)}>`,
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

  // ★초안은 **보낼 것 그대로** 여야 한다.
  //   종전엔 초안과 최종 메시지가 각자 레이아웃을 들고 있어 서로 어긋났다(재상 님 실측 2026-10-28):
  //     · 스레드 맥락 건은 초안에 「문의 내용」이 아예 없는데 채널엔 스레드 전문이 통째로 나갔다
  //     · 요약·원문 링크는 초안엔 본문에, 실제론 첫 댓글에 있었다
  //     · 작품명 보조줄(FIX·原題·고객사용)은 초안에 없었다
  //   그래서 초안을 최종 빌더로 그려 낸다 — 레이아웃이 한 벌뿐이라 구조적으로 못 어긋난다.
  function buildDraftPreviewBlocks(draft) {
    const main = buildFinalMainMessage({
      ...draft,
      submitterId: draft.ownerUserId || draft.userId || "",
      langPair:    draft.lang || null,
      hasThreadContext: draft.hasThreadContext === true,
    });
    // 최종 블록에서 완료 버튼만 뺀다. 멘션 줄은 남긴다 — 누구에게 가는지 보고 전송하는 게 맞다
    // (초안은 APM 과 봇 둘뿐인 DM 이라 멘션 대상에게 알림이 가지 않는다).
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: "*문의 초안* — 아래 그대로 전송돼" }},
      ...main.blocks.filter(blk => blk.type !== "actions"),
      { type: "section", text: { type: "mrkdwn", text: `*↳ 첫 댓글로 따라붙는 내용*\n${buildThreadMessage({
        summary: draft.summary, sourceLink: draft.sourceLink,
        inquiryContent: draft.inquiryContent, hasThreadContext: draft.hasThreadContext === true,
      })}` }},
    ];

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

  function buildFinalMainMessage({
    submitterId,
    workName,
    workNameKo,
    workNameJaFixed,
    workNameJaDisplay,
    workNameZh,
    episode,
    deliveryDate,
    inquiryType,
    inquiryContent,
    summary,
    actionRequired,
    // 스레드 맥락 건이면 inquiryContent 가 **스레드 전체 번역문**이다. 그대로 본문에 박으면
    // 채널에 덤프가 올라가 읽히지 않는다 — 본문엔 요약을 쓰고 전문은 첫 댓글로 내린다.
    hasThreadContext = false,
    draftId,
    historyRowIndex,
    originalChannelId,
    originalTs,
    sourceLink,
    // 이 문의가 어느 언어쌍인지. 수신자를 고르는 데 쓴다 — 모르면(null) 공통 수신자.
    langPair = null,
  }) {
    const mentions = mentionUserIdsFor(langPair).map(id => `<@${id}>`).join(" ");
    const fallbackText = `${workName||"-"} | ${inquiryType||"-"} | <@${submitterId}>`;
    // historyRowIndex를 버튼 값에 직접 박아둔다 — draftStore(인메모리)는 프로세스 재시작 시 사라지므로,
    // 완료 클릭이 며칠 뒤에 일어나도 시트 체크박스 처리가 가능하도록 메시지 자체에 영속시킨다.
    const meta = JSON.stringify({
      submitterId,
      ownerUserId: submitterId,
      draftId: draftId || null,
      historyRowIndex: historyRowIndex || null,
      originalChannelId: originalChannelId || null,
      originalTs: originalTs || null,
      sourceLink: sourceLink || null,
    });
    return {
      text: fallbackText,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `${mentions}` }},
        { type: "divider" },
        { type: "section", fields: [
          // PM이 고객사·작업자와 소통할 때 매번 찾아야 했던 FIX 타이틀(일본어 확정명)과 원제(중국어)를
          // 같이 뿌린다. 둘 다 '출판사 드라이브 링크' 시트(E·B열)에서 이미 매칭 단계에 읽고 있던 값이다.
          // 시트 매칭이 안 돼 직접 입력한 건은 workName(일본어)과 workNameKo(한국어)가 다르다.
          // 종전엔 초안에만 한국어가 괄호로 붙고 실제 메시지엔 빠졌다 — 둘 다 붙인다.
          { type: "mrkdwn", text: `*작품명*\n${workName||"-"}${
            workNameKo && workNameKo !== workName ? `　(${workNameKo})` : ""
          }${titleExtraLines({ workNameJaFixed, workNameJaDisplay, workNameZh, workName, langPair })}` },
          { type: "mrkdwn", text: `*회차*\n${episode ? episode+"화" : "-"}` },
          { type: "mrkdwn", text: `*납품일*\n${deliveryDate||"-"}` },
          { type: "mrkdwn", text: `*문의 유형*\n${inquiryType||"-"}` },
          // 초안 단계에선 소환한 APM 이 그대로 담당자가 되지만, 값이 비면 `<@>` 라는 깨진 멘션이 찍힌다.
          { type: "mrkdwn", text: `*담당자*\n${submitterId ? `<@${submitterId}>` : "-"}` },
        ]},
        { type: "divider" },
        { type: "section", text: { type: "mrkdwn", text: `*문의 내용*\n${bodyText(
          { inquiryContent, summary, hasThreadContext }
        )}` }},
        ...(hasThreadContext ? [{ type: "context", elements: [
          { type: "mrkdwn", text: "💬 스레드 전체를 요약했어. 전문은 첫 댓글, 원본은 원문 링크." },
        ]}] : []),
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

  // 작품명 아래에 붙일 보조 줄 — **타이틀이 맡는 역할이 언어쌍마다 달라** 한 벌로 못 쓴다(R7).
  //
  //   중일 — 작품명은 한국어 프로젝트명, 原題는 중국어, 일본어는 FIX(E열) 없으면 가제(D열).
  //          시트 233행 중 FIX가 채워진 건 211행이라 22행은 가제로 내려간다.
  //   한일 — 작품명이 곧 **원제(한국어)** 이고, 그게 작업자가 부르는 이름이다(재상 님 2026-10-29).
  //          고객사와 쓰는 건 일본어 쪽 — FIX(D열) 먼저, 없으면 가제(E열).
  //          실측 1,300행: FIX 1,219 · 가제 1,193 · FIX 없이 가제만 43 · 둘 다 없음 38.
  //          원제 칸(F열)이 작품명과 같은 값이라 「原題」 줄은 따로 내지 않는다.
  //
  // 값이 없거나 작품명과 같으면 생략해서 줄만 늘리지 않는다.
  const TITLE_EXTRA = Object.freeze({
    "zh-ja": ({ fixed, kari, zh, workName }) => {
      const lines = [];
      const ja = fixed || kari;
      if (ja && ja !== workName) lines.push(`${fixed ? "FIX" : "仮"}: ${ja}`);
      if (zh && zh !== workName) lines.push(`原題: ${zh}`);
      return lines;
    },
    "ko-ja": ({ fixed, kari, workName }) => {
      const ja = fixed || kari;
      if (!ja || ja === workName) return [];
      // 어느 쪽이 고객사에 쓰는 이름인지 라벨로 박는다 — APM 이 매번 되묻지 않게.
      return [`고객사용: ${ja} (${fixed ? "FIX" : "仮"})`];
    },
  });

  function titleExtraLines({ workNameJaFixed, workNameJaDisplay, workNameZh, workName, langPair }) {
    // 언어를 모르면 종전(중일) 표기. 작품을 못 찾아 직접 입력한 건이 여기로 온다.
    const render = TITLE_EXTRA[langPair] || TITLE_EXTRA["zh-ja"];
    const lines = render({
      fixed: String(workNameJaFixed || "").trim(),
      kari:  String(workNameJaDisplay || "").trim(),
      zh:    String(workNameZh || "").trim(),
      workName,
    });
    return lines.length ? `\n${lines.join("\n")}` : "";
  }

  // 본문에 들어갈 글. 스레드 맥락 건은 inquiryContent 가 스레드 전체 번역문이라 요약을 쓴다.
  // 요약이 비었을 때만 어쩔 수 없이 전문으로 떨어진다 — 빈 칸을 내보내느니 길게 내보낸다.
  function bodyText({ inquiryContent, summary, hasThreadContext }) {
    if (hasThreadContext) return summary || inquiryContent || "-";
    return inquiryContent || "-";
  }

  // 첫 댓글. 본문이 요약이면 여기에 전문을 싣고, 본문이 전문이면 여기에 요약을 싣는다 —
  // 어느 쪽이든 두 가지가 한 스레드에 다 남는다(정보 손실 없음).
  function buildThreadMessage({ summary, sourceLink, inquiryContent, hasThreadContext = false }) {
    const head = hasThreadContext
      ? `📋 *전체 내용*\n${inquiryContent || summary || "-"}`
      : `📋 *요약*\n${summary || "-"}`;
    return `${head}\n\n🔗 *원문 링크*\n${sourceLink||"-"}`;
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
