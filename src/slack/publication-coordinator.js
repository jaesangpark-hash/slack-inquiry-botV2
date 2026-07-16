"use strict";

const { createHash } = require("node:crypto");
const {
  checkEntryGate,
  readState,
  reserveInProgress,
  runCheckpointStages,
  writeState,
} = require("./mutation-checkpoint");

const PUBLICATION_STATUS = Object.freeze({
  WRITING_SHEET: "writing_sheet",
  SHEET_CONFIRMED: "sheet_confirmed",
  POSTING_MAIN: "posting_main",
  MAIN_POSTED: "main_posted",
  POSTING_THREAD: "posting_thread",
  THREAD_POSTED: "thread_posted",
  POSTING_COMPLETION_NOTICE: "posting_completion_notice",
  SENT: "sent",
  REVIEW_REQUIRED: "review_required",
});

const COMPLETION_NOTICE = Object.freeze({
  PENDING: "pending",
  POSTED: "posted",
  NOT_REQUIRED: "not_required",
});

const PUBLICATION_RECOVERY = Object.freeze({
  RETRY_FROM_CHECKPOINT: "retry_from_checkpoint",
  REVIEW_REQUIRED: "review_required",
});

function createPublicationError(message, recovery, stage, cause) {
  const error = new Error(message);
  error.publicationRecovery = recovery;
  error.publicationStage = stage;
  error.cause = cause;
  return error;
}

function normalizeIntentValue(value) {
  if (Array.isArray(value)) return value.map(normalizeIntentValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, normalizeIntentValue(value[key])])
    );
  }
  return value === undefined ? null : value;
}

function fingerprintPublicationIntent(intentSnapshot) {
  if (!intentSnapshot) return null;
  return createHash("sha256")
    .update(JSON.stringify(normalizeIntentValue(intentSnapshot)))
    .digest("hex");
}

/**
 * 시트 append → main 게시 → thread 게시 → 완료 안내를 checkpoint부터 이어서 실행한다.
 * 확인된 sheet row와 main ts는 같은 프로세스의 재시도에서 다시 만들지 않는다.
 */
async function publishFromCheckpoint({
  publicationStateStore,
  publicationKey,
  appendSheetRow,
  postMainMessage,
  postThreadMessage,
  postCompletionNotice,
  onSheetRowConfirmed = () => {},
  intentSnapshot = null,
}) {
  const savedState = readState(publicationStateStore, publicationKey);
  const requestedIntentFingerprint = fingerprintPublicationIntent(intentSnapshot);
  if (savedState?.intentFingerprint
      && requestedIntentFingerprint
      && savedState.intentFingerprint !== requestedIntentFingerprint) {
    return {
      ...savedState,
      replay: true,
      intentConflict: true,
      requestedIntentFingerprint,
    };
  }

  const entryGate = checkEntryGate({
    savedState,
    isTerminal: state => state.status === PUBLICATION_STATUS.SENT
      || state.status === PUBLICATION_STATUS.REVIEW_REQUIRED,
    isInProgress: state => !!state.inProgress,
    buildReplayResult: state => ({ ...state, replay: true }),
    buildInProgressResult: state => ({ ...state, inProgress: true }),
  });
  if (entryGate.done) return entryGate.result;

  let state = savedState || {
    status: PUBLICATION_STATUS.WRITING_SHEET,
    sheetRowIndex: null,
    mainMessageTs: null,
    threadPosted: typeof postThreadMessage !== "function",
    completionNotice: typeof postCompletionNotice === "function"
      ? COMPLETION_NOTICE.PENDING
      : COMPLETION_NOTICE.NOT_REQUIRED,
    intentVersion: 1,
    intentSnapshot: intentSnapshot ? normalizeIntentValue(intentSnapshot) : null,
    intentFingerprint: requestedIntentFingerprint,
    startedAt: new Date().toISOString(),
  };
  state = reserveInProgress({ stateStore: publicationStateStore, stateKey: publicationKey, state });

  const stages = [
    {
      isDone: s => !!s.sheetRowIndex,
      beforeExecute: () => ({ status: PUBLICATION_STATUS.WRITING_SHEET }),
      execute: () => appendSheetRow(),
      confirm: (s, sheetRowIndex) => {
        if (!Number.isInteger(sheetRowIndex) || sheetRowIndex <= 0) {
          throw new Error("게시 이력 시트 행 번호를 확인할 수 없어.");
        }
        return { status: PUBLICATION_STATUS.SHEET_CONFIRMED, sheetRowIndex };
      },
      afterConfirm: (s, sheetRowIndex) => onSheetRowConfirmed(sheetRowIndex),
      onOutcomeUnknown: () => ({
        status: PUBLICATION_STATUS.REVIEW_REQUIRED,
        inProgress: false,
        reviewReason: "sheet_append_outcome_unknown",
      }),
      buildError: error => createPublicationError(
        `시트 기록 결과를 확정할 수 없어: ${error.message}`,
        PUBLICATION_RECOVERY.REVIEW_REQUIRED,
        "sheet",
        error
      ),
    },
    {
      isDone: s => !!s.mainMessageTs,
      beforeExecute: () => ({ status: PUBLICATION_STATUS.POSTING_MAIN }),
      execute: s => postMainMessage({ sheetRowIndex: s.sheetRowIndex }),
      confirm: (s, mainResult) => {
        if (!mainResult?.ts) {
          throw new Error("main 메시지 ts를 확인할 수 없어.");
        }
        return { status: PUBLICATION_STATUS.MAIN_POSTED, mainMessageTs: mainResult.ts };
      },
      onOutcomeUnknown: () => ({
        status: PUBLICATION_STATUS.REVIEW_REQUIRED,
        inProgress: false,
        reviewReason: "main_message_outcome_unknown",
      }),
      buildError: error => createPublicationError(
        `main 메시지 게시 결과를 확정할 수 없어: ${error.message}`,
        PUBLICATION_RECOVERY.REVIEW_REQUIRED,
        "main",
        error
      ),
    },
    {
      isDone: s => !!s.threadPosted,
      beforeExecute: () => ({ status: PUBLICATION_STATUS.POSTING_THREAD }),
      execute: s => postThreadMessage({
        mainMessageTs: s.mainMessageTs,
        sheetRowIndex: s.sheetRowIndex,
      }),
      confirm: (s, threadResult) => {
        if (!threadResult?.ts) {
          throw new Error("thread 메시지 ts를 확인할 수 없어.");
        }
        return {
          status: PUBLICATION_STATUS.THREAD_POSTED,
          threadPosted: true,
          threadMessageTs: threadResult.ts,
        };
      },
      onOutcomeUnknown: () => ({
        status: PUBLICATION_STATUS.REVIEW_REQUIRED,
        inProgress: false,
        reviewReason: "thread_message_outcome_unknown",
      }),
      buildError: error => createPublicationError(
        `thread 메시지 게시 결과를 확정할 수 없어: ${error.message}`,
        PUBLICATION_RECOVERY.REVIEW_REQUIRED,
        "thread",
        error
      ),
    },
    {
      isDone: s => s.completionNotice !== COMPLETION_NOTICE.PENDING,
      beforeExecute: () => ({ status: PUBLICATION_STATUS.POSTING_COMPLETION_NOTICE }),
      execute: s => postCompletionNotice({
        mainMessageTs: s.mainMessageTs,
        sheetRowIndex: s.sheetRowIndex,
      }),
      confirm: (s, completionNoticeResult) => {
        if (!completionNoticeResult?.ts) {
          throw new Error("완료 안내 메시지 ts를 확인할 수 없어.");
        }
        return {
          completionNotice: COMPLETION_NOTICE.POSTED,
          completionNoticeMessageTs: completionNoticeResult.ts,
        };
      },
      onOutcomeUnknown: () => ({
        status: PUBLICATION_STATUS.REVIEW_REQUIRED,
        inProgress: false,
        reviewReason: "completion_notice_outcome_unknown",
      }),
      buildError: error => createPublicationError(
        `완료 안내 게시 결과를 확정할 수 없어: ${error.message}`,
        PUBLICATION_RECOVERY.REVIEW_REQUIRED,
        "completion_notice",
        error
      ),
    },
  ];

  state = await runCheckpointStages({
    state,
    stages,
    stateStore: publicationStateStore,
    stateKey: publicationKey,
  });

  state = writeState(publicationStateStore, publicationKey, {
    ...state,
    status: PUBLICATION_STATUS.SENT,
    inProgress: false,
    sentAt: new Date().toISOString(),
  });
  return state;
}

module.exports = {
  COMPLETION_NOTICE,
  PUBLICATION_RECOVERY,
  PUBLICATION_STATUS,
  fingerprintPublicationIntent,
  publishFromCheckpoint,
};
