// 단일 책임: 다단계 mutation(외부 side-effect) 순차 실행을 checkpoint 기반으로 재개 가능하게 하는
// 공유 골격을 제공한다. 진입 선점 게이트 + 단계별 checkpoint(완료분 skip) + outcome 분류(불명확 실패
// → terminal 전이) 만 다룬다. 파일 fan-out 집계·durable marker reconcile 등 site-고유 형상은 호출부 책임.
"use strict";

function readState(stateStore, stateKey) {
  return stateStore.get(stateKey);
}

function writeState(stateStore, stateKey, state) {
  stateStore.set(stateKey, state);
  return state;
}

/**
 * 진입 선점 게이트: 저장된 state로 이번 호출을 계속 진행할지 즉시 반환할지 결정한다.
 * - isTerminal(savedState) → true: 완료/검토대기 등 terminal 상태 → buildReplayResult로 replay 반환
 * - isInProgress(savedState) → true: 다른 실행이 이미 선점 중 → buildInProgressResult 반환
 * - 둘 다 아니면 { done: false } — 호출부가 진행을 이어간다
 * uiPending 등 site-고유 복구 분기는 buildReplayResult 콜백 안에서 표현한다(primitive는 모름).
 */
function checkEntryGate({ savedState, isTerminal, isInProgress, buildReplayResult, buildInProgressResult }) {
  if (savedState && isTerminal(savedState)) {
    return { done: true, result: buildReplayResult(savedState) };
  }
  if (savedState && isInProgress(savedState)) {
    return { done: true, result: buildInProgressResult(savedState) };
  }
  return { done: false };
}

/**
 * first-await 선점: 외부 호출(stage 실행)을 시작하기 전에 in-progress를 예약해
 * 동시 호출이 checkEntryGate의 isInProgress 분기로 drop되게 한다.
 */
function reserveInProgress({ stateStore, stateKey, state }) {
  return writeState(stateStore, stateKey, { ...state, inProgress: true });
}

/**
 * stage 배열을 순차 실행한다. 각 stage:
 *   - isDone(state): 이미 확정되어 skip해야 하면 true (같은 프로세스 재시도 시 중복 실행 0)
 *   - beforeExecute(state)?: 실행 직전 state에 병합할 patch(예: status 전이 표기)
 *   - execute(state): 외부 side-effect 수행 → raw 결과 반환
 *   - confirm(state, rawResult): 성공 확정 시 병합할 patch. 결과가 불충분(ts 없음 등)하면 throw
 *   - afterConfirm(state, rawResult)?: confirm patch가 저장된 뒤 실행하는 부수효과(옵션)
 *   - onOutcomeUnknown(state, error): execute/confirm이 실패하면 병합할 patch(terminal 전이 등)
 *   - buildError(error): 호출부로 throw할 에러(원인 error 포함)
 * 상태 저장소 모양은 stateStore/stateKey로 추상화 — Map 등 get/set 인터페이스를 가정한다.
 */
async function runCheckpointStages({ state, stages, stateStore, stateKey }) {
  let current = state;
  for (const stage of stages) {
    if (stage.isDone(current)) continue;
    if (stage.beforeExecute) {
      current = writeState(stateStore, stateKey, { ...current, ...stage.beforeExecute(current) });
    }
    try {
      const rawResult = await stage.execute(current);
      const patch = stage.confirm(current, rawResult);
      current = writeState(stateStore, stateKey, { ...current, ...patch });
      if (stage.afterConfirm) stage.afterConfirm(current, rawResult);
    } catch (error) {
      const patch = stage.onOutcomeUnknown(current, error);
      current = writeState(stateStore, stateKey, { ...current, ...patch });
      throw stage.buildError(error);
    }
  }
  return current;
}

module.exports = {
  checkEntryGate,
  readState,
  reserveInProgress,
  runCheckpointStages,
  writeState,
};
