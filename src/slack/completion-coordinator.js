"use strict";

const { createHash } = require("node:crypto");

const COMPLETION_STATUS = Object.freeze({
  PERSISTING: "persisting",
  PERSISTED: "persisted",
  FOLLOWUP_POSTED: "followup_posted",
  COMPLETED: "completed",
  REVIEW_REQUIRED: "review_required",
});

const COMPLETION_RECOVERY = Object.freeze({
  RETRY_PERSISTENCE: "retry_persistence",
  RETRY_UI_ONLY: "retry_ui_only",
  REVIEW_REQUIRED: "review_required",
});

function createCompletionError(message, recovery, cause) {
  const error = new Error(message);
  error.completionRecovery = recovery;
  error.cause = cause;
  return error;
}

function createCompletionFollowupMarker(completionStateKey) {
  const keyHash = createHash("sha256").update(completionStateKey).digest("hex").slice(0, 24);
  return `completion_followup_${keyHash}`;
}

function findMarkedFollowupMessage(messages, completionStateKey) {
  const marker = createCompletionFollowupMarker(completionStateKey);
  return (messages || []).find(message =>
    message?.ts && (message.blocks || []).some(block => block.block_id === marker)
  ) || null;
}

/**
 * 완료 처리를 시트 기록 → 후속 메시지 → 완료 UI 순서로 한 번만 진행한다.
 * 상태는 같은 프로세스에서 terminal tombstone으로 유지한다.
 */
async function finalizeCompletion({
  completionStateStore,
  completionStateKey,
  persistCompletion,
  postFollowup,
  updateCompletionMessage,
  reconciledFollowupMessageTs = null,
}) {
  let savedState = completionStateStore.get(completionStateKey);
  if (!savedState && reconciledFollowupMessageTs) {
    savedState = {
      status: COMPLETION_STATUS.FOLLOWUP_POSTED,
      followupMessageTs: reconciledFollowupMessageTs,
      reconciledAt: new Date().toISOString(),
    };
    completionStateStore.set(completionStateKey, savedState);
  }
  if (savedState?.status === COMPLETION_STATUS.COMPLETED
      || savedState?.status === COMPLETION_STATUS.REVIEW_REQUIRED) {
    return { status: savedState.status, replay: true };
  }
  if (savedState?.status === COMPLETION_STATUS.PERSISTING
      || savedState?.status === COMPLETION_STATUS.PERSISTED
      || savedState?.uiUpdateInProgress) {
    return { status: savedState.status, inProgress: true };
  }

  let state = savedState;
  if (!state) {
    state = {
      status: COMPLETION_STATUS.PERSISTING,
      startedAt: new Date().toISOString(),
    };
    completionStateStore.set(completionStateKey, state);
    try {
      await persistCompletion();
    } catch (error) {
      completionStateStore.delete(completionStateKey);
      throw createCompletionError(
        `운영 시트 완료 기록에 실패했어: ${error.message}`,
        COMPLETION_RECOVERY.RETRY_PERSISTENCE,
        error
      );
    }

    state = {
      ...state,
      status: COMPLETION_STATUS.PERSISTED,
      persistedAt: new Date().toISOString(),
    };
    completionStateStore.set(completionStateKey, state);

    try {
      const followupResult = await postFollowup();
      if (!followupResult?.ts) {
        throw new Error("후속 메시지 ts를 확인할 수 없어.");
      }
      state = {
        ...state,
        status: COMPLETION_STATUS.FOLLOWUP_POSTED,
        followupMessageTs: followupResult.ts,
        followupPostedAt: new Date().toISOString(),
      };
      completionStateStore.set(completionStateKey, state);
    } catch (error) {
      completionStateStore.set(completionStateKey, {
        ...state,
        status: COMPLETION_STATUS.REVIEW_REQUIRED,
        reviewReason: "followup_outcome_unknown",
        reviewRequiredAt: new Date().toISOString(),
      });
      throw createCompletionError(
        `후속 메시지 게시 결과를 확정할 수 없어: ${error.message}`,
        COMPLETION_RECOVERY.REVIEW_REQUIRED,
        error
      );
    }
  }

  state = {
    ...completionStateStore.get(completionStateKey),
    uiUpdateInProgress: true,
  };
  completionStateStore.set(completionStateKey, state);
  try {
    await updateCompletionMessage({ followupMessageTs: state.followupMessageTs });
  } catch (error) {
    completionStateStore.set(completionStateKey, {
      ...state,
      uiUpdateInProgress: false,
    });
    throw createCompletionError(
      `완료 UI 갱신에 실패했어: ${error.message}`,
      COMPLETION_RECOVERY.RETRY_UI_ONLY,
      error
    );
  }

  const completedState = {
    ...state,
    status: COMPLETION_STATUS.COMPLETED,
    uiUpdateInProgress: false,
    completedAt: new Date().toISOString(),
  };
  completionStateStore.set(completionStateKey, completedState);
  return { status: COMPLETION_STATUS.COMPLETED };
}

module.exports = {
  COMPLETION_RECOVERY,
  COMPLETION_STATUS,
  createCompletionFollowupMarker,
  findMarkedFollowupMessage,
  finalizeCompletion,
};
