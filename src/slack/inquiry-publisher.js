"use strict";

const { requirePositiveSheetRowIndex } = require("../sheets/sheet-row-index");
const {
  PUBLICATION_RECOVERY,
  publishFromCheckpoint,
} = require("./publication-coordinator");

function createInquiryPublisher({
  appendInquiryHistory,
  updateInquiryHistorySourceLink = async () => {},
  draftStore,
  buildFinalMainMessage,
  buildThreadMessage,
  targetChannelId,
  logEvent = () => {},
}) {
  return async function postInquiryToTargetChannel(client, draft, submitterId, {
    completionNoticeText = null,
  } = {}) {
    if (!draft.draftId) {
      throw new Error("문의 publication key를 만들 draftId가 없어.");
    }
    const publicationKey = `inquiry_publication:${draft.draftId}`;
    try {
      const publication = await publishFromCheckpoint({
        publicationStateStore: draftStore,
        publicationKey,
        intentSnapshot: {
          kind: "inquiry",
          draftId: draft.draftId,
          draftVersion: draft.draftVersion || 1,
          submitterId,
          targetChannelId,
          workName: draft.workName || null,
          workNameKo: draft.workNameKo || null,
          episode: draft.episode || null,
          inquiryType: draft.inquiryType || null,
          inquiryContent: draft.inquiryContent || null,
          summary: draft.summary || null,
          actionRequired: draft.actionRequired || null,
          sourceLink: draft.sourceLink || null,
          originalChannelId: draft.originalChannelId || null,
          originalTs: draft.originalTs || null,
        },
        appendSheetRow: async () => requirePositiveSheetRowIndex(
          await appendInquiryHistory(draft, submitterId),
          "문의 이력"
        ),
        onSheetRowConfirmed: historyRowIndex => {
          const currentDraft = draftStore.get(draft.draftId) || draft;
          draftStore.set(draft.draftId, { ...currentDraft, historyRowIndex });
        },
        postMainMessage: async ({ sheetRowIndex: historyRowIndex }) => {
          const message = buildFinalMainMessage({
            submitterId,
            workName: draft.workName,
            workNameKo: draft.workNameKo,
            episode: draft.episode,
            inquiryType: draft.inquiryType,
            inquiryContent: draft.inquiryContent,
            actionRequired: draft.actionRequired,
            draftId: draft.draftId,
            historyRowIndex,
            originalChannelId: draft.originalChannelId,
            originalTs: draft.originalTs,
            sourceLink: draft.sourceLink,
          });
          const startedAt = Date.now();
          const postResult = await client.chat.postMessage({ channel: targetChannelId, ...message });
          logEvent("inquiry", "/slack/inquiry-sent", Date.now() - startedAt, true);
          return postResult;
        },
        postThreadMessage: ({ mainMessageTs }) => client.chat.postMessage({
          channel: targetChannelId,
          thread_ts: mainMessageTs,
          text: buildThreadMessage({ summary: draft.summary, sourceLink: draft.sourceLink }),
        }),
        ...(completionNoticeText ? {
          postCompletionNotice: () => client.chat.postMessage({
            channel: draft.dmChannelId || submitterId,
            text: completionNoticeText,
          }),
        } : {}),
      });

      // 히스토리 시트 "원문 링크"를 원본 위치(작업자 채널 등) 대신 문의봇이 보낸 이 스레드로 갱신
      // — 원본은 스레드 첫 댓글에 이미 남아있어 정보 손실 없음, 시트에서 클릭했을 때 실제 대응 스레드로 이동하게 함
      if (publication.sheetRowIndex && publication.mainMessageTs && publication.replay !== true) {
        try {
          const permalinkRes = await client.chat.getPermalink({
            channel: targetChannelId,
            message_ts: publication.mainMessageTs,
          });
          await updateInquiryHistorySourceLink(publication.sheetRowIndex, permalinkRes.permalink);
        } catch (e) {
          console.error("[postInquiry] 히스토리 링크 갱신 실패:", e.message);
        }
      }

      return {
        ts: publication.mainMessageTs,
        publicationStatus: publication.status,
        replay: publication.replay === true,
        intentConflict: publication.intentConflict === true,
      };
    } catch (error) {
      console.error(`[postInquiry] ${error.publicationStage || "publication"} 실패:`, error.message);
      const notificationChannel = draft.dmChannelId || submitterId;
      if (notificationChannel) {
        const guidance = error.publicationRecovery === PUBLICATION_RECOVERY.REVIEW_REQUIRED
          ? "main 문의가 실제 게시됐는지 운영자가 확인해야 해. 전송 버튼을 다시 누르지 말아줘."
          : "확인된 단계는 보존했어. 같은 전송 버튼을 누르면 실패 단계부터 다시 진행해.";
        try {
          await client.chat.postMessage({
            channel: notificationChannel,
            text: `⚠️ 문의 게시를 완료하지 못했어. ${guidance} (${error.message})`,
          });
        } catch (notificationError) {
          console.error("[postInquiry] 실패 안내 게시 오류:", notificationError.message);
        }
      }
      throw error;
    }
  };
}

module.exports = createInquiryPublisher;
