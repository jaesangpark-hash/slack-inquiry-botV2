"use strict";

class ConfirmedMutationFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfirmedMutationFailure";
    this.code = "CONFIRMED_MUTATION_FAILURE";
    this.safeToRetry = true;
  }
}

class UnknownMutationOutcome extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "UnknownMutationOutcome";
    this.code = "UNKNOWN_MUTATION_OUTCOME";
    this.reviewRequired = true;
  }
}

class IncompleteMutationTargets extends Error {
  constructor(message, missingTargets) {
    super(message);
    this.name = "IncompleteMutationTargets";
    this.code = "INCOMPLETE_MUTATION_TARGETS";
    this.missingTargets = missingTargets;
    this.safeToRetry = true;
  }
}

class AmbiguousMutationTargets extends Error {
  constructor(message, ambiguousTargets) {
    super(message);
    this.name = "AmbiguousMutationTargets";
    this.code = "AMBIGUOUS_MUTATION_TARGETS";
    this.ambiguousTargets = ambiguousTargets;
    this.safeToRetry = true;
  }
}

function mutationFailureCount(data) {
  return Number(
    data?.실패 ??
    data?.failedCount ??
    data?.failureCount ??
    data?.실패건수 ??
    0
  );
}

function mutationFailureIds(data) {
  const value = data?.failedTaskUuids ??
    data?.실패UUID목록 ??
    data?.실패목록 ??
    [];
  return Array.isArray(value) ? value.map(String) : [];
}

/**
 * Totus 변경 응답을 한 계약으로 판독한다.
 * 명시적 거부·부분 실패는 안전 재시도 가능한 확정 실패로 분류한다.
 * @param {object} responseBody
 * @param {string} operationLabel
 * @returns {object}
 */
function decodeMutationResult(responseBody, operationLabel) {
  if (responseBody?.success === false) {
    throw new ConfirmedMutationFailure(
      responseBody.error?.message || responseBody.message || `${operationLabel} 실패`
    );
  }
  if (responseBody?.success !== true) {
    throw new UnknownMutationOutcome(`${operationLabel} 응답에서 성공 여부를 확인할 수 없어.`);
  }

  const failedCount = mutationFailureCount(responseBody.data);
  if (failedCount > 0) {
    const failedIds = mutationFailureIds(responseBody.data);
    const detail = failedIds.length ? ` (${failedIds.join(", ")})` : "";
    throw new ConfirmedMutationFailure(`${operationLabel} ${failedCount}건 실패${detail}`);
  }
  return responseBody;
}

/**
 * 리테이크 생성 성공 응답에서 확정된 새 태스크 UUID만 반환한다.
 * success=true여도 UUID가 없으면 서버 반영 여부를 알 수 없으므로 자동 재시도를 금지한다.
 * @param {object} responseBody
 * @param {string} operationLabel
 * @returns {string[]}
 */
function requireCreatedTaskUuids(responseBody, operationLabel) {
  decodeMutationResult(responseBody, operationLabel);
  const taskUuids = responseBody.data?.createdTaskUuids;
  if (!Array.isArray(taskUuids) || taskUuids.length === 0) {
    throw new UnknownMutationOutcome(
      `${operationLabel} 성공 응답에 생성 태스크 UUID가 없어 서버 반영 여부를 확인할 수 없어.`
    );
  }
  const normalizedTaskUuids = taskUuids.map(taskUuid =>
    typeof taskUuid === "string" ? taskUuid.trim() : ""
  );
  const hasInvalidUuid = normalizedTaskUuids.some(taskUuid => !taskUuid);
  const hasDuplicateUuid = new Set(normalizedTaskUuids).size !== normalizedTaskUuids.length;
  if (hasInvalidUuid || hasDuplicateUuid) {
    throw new UnknownMutationOutcome(
      `${operationLabel} 성공 응답의 생성 태스크 UUID가 비어 있거나 중복되어 서버 반영 결과를 확정할 수 없어.`
    );
  }
  return normalizedTaskUuids;
}

/**
 * 회차별로 확정한 리테이크 태스크 UUID가 전체 작업에서 서로 다른지 확인한다.
 * 외부 생성 뒤 identity가 충돌한 상태이므로 안전 재시도 가능한 실패로 분류하지 않는다.
 * @param {Record<string, string[]>} createdTaskUuidsByEpisode
 * @param {string} operationLabel
 */
function assertGloballyUniqueCreatedTaskUuids(createdTaskUuidsByEpisode, operationLabel) {
  const episodeByTaskUuid = new Map();
  for (const [episode, taskUuids] of Object.entries(createdTaskUuidsByEpisode || {})) {
    if (!Array.isArray(taskUuids) || taskUuids.length === 0) {
      throw new UnknownMutationOutcome(
        `${operationLabel} ${episode}화의 생성 태스크 UUID 목록을 확인할 수 없어.`
      );
    }
    for (const rawTaskUuid of taskUuids) {
      const taskUuid = typeof rawTaskUuid === "string" ? rawTaskUuid.trim() : "";
      if (!taskUuid) {
        throw new UnknownMutationOutcome(
          `${operationLabel} ${episode}화의 생성 태스크 UUID가 비어 있어 결과를 확정할 수 없어.`
        );
      }
      const previousEpisode = episodeByTaskUuid.get(taskUuid);
      if (previousEpisode !== undefined) {
        throw new UnknownMutationOutcome(
          `${operationLabel} ${previousEpisode}화와 ${episode}화가 같은 생성 태스크 UUID(${taskUuid})를 반환했어. Totus에서 회차별 생성 결과를 확인해야 해.`
        );
      }
      episodeByTaskUuid.set(taskUuid, episode);
    }
  }
}

/**
 * 외부 변경 전에 기대 대상과 실제 조회 대상을 비교한다.
 * @param {string[]} expectedTargets
 * @param {string[]} actualTargets
 * @param {string} operationLabel
 */
function assertCompleteMutationTargets(expectedTargets, actualTargets, operationLabel) {
  const actualSet = new Set(actualTargets.map(String));
  const missingTargets = [...new Set(expectedTargets.map(String))]
    .filter(target => !actualSet.has(target));
  if (!missingTargets.length) return;
  throw new IncompleteMutationTargets(
    `${operationLabel} 대상이 누락됐어: ${missingTargets.join(", ")}. 외부 변경은 시작하지 않았어.`,
    missingTargets
  );
}

function assertNoAmbiguousMutationTargets(ambiguousTargets, operationLabel) {
  const uniqueTargets = [...new Set(ambiguousTargets.map(String))];
  if (!uniqueTargets.length) return;
  throw new AmbiguousMutationTargets(
    `${operationLabel} 대상 후보가 여러 개야: ${uniqueTargets.join(", ")}. 외부 변경은 시작하지 않았어.`,
    uniqueTargets
  );
}

function toUnknownMutationOutcome(error, operationLabel) {
  if (error?.code === "UNKNOWN_MUTATION_OUTCOME") return error;
  return new UnknownMutationOutcome(
    `${operationLabel} 요청 뒤 응답을 확인하지 못했어. Totus에서 생성 여부를 확인해야 해.`,
    { cause: error }
  );
}

function isUnknownMutationOutcome(error) {
  return error?.code === "UNKNOWN_MUTATION_OUTCOME";
}

module.exports = {
  AmbiguousMutationTargets,
  ConfirmedMutationFailure,
  IncompleteMutationTargets,
  UnknownMutationOutcome,
  assertGloballyUniqueCreatedTaskUuids,
  assertCompleteMutationTargets,
  assertNoAmbiguousMutationTargets,
  decodeMutationResult,
  isUnknownMutationOutcome,
  requireCreatedTaskUuids,
  toUnknownMutationOutcome,
};
