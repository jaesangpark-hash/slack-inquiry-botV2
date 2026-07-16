"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  COMPLETION_RECOVERY,
  COMPLETION_STATUS,
  finalizeCompletion,
} = require("../completion-coordinator");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("completion coordinator", () => {
  test("동시 A/B 중 B가 먼저 끝나도 Sheets, followup, UI를 각각 한 번만 실행한다", async () => {
    const completionStateStore = new Map();
    const persistence = deferred();
    const uiUpdate = deferred();
    let persistCalls = 0;
    let followupCalls = 0;
    let updateCalls = 0;
    const callbacks = {
      persistCompletion: async () => {
        persistCalls++;
        await persistence.promise;
      },
      postFollowup: async () => {
        followupCalls++;
        return { ts: "followup-ts" };
      },
      updateCompletionMessage: async () => {
        updateCalls++;
        await uiUpdate.promise;
      },
    };

    const first = finalizeCompletion({
      completionStateStore,
      completionStateKey: "completion:1",
      ...callbacks,
    });
    const secondResult = await finalizeCompletion({
      completionStateStore,
      completionStateKey: "completion:1",
      ...callbacks,
    });

    assert.equal(secondResult.inProgress, true);
    assert.equal(secondResult.status, COMPLETION_STATUS.PERSISTING);
    assert.equal(persistCalls, 1);
    assert.equal(followupCalls, 0);
    assert.equal(updateCalls, 0);

    persistence.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completionStateStore.get("completion:1").status, COMPLETION_STATUS.FOLLOWUP_POSTED);

    const thirdResult = await finalizeCompletion({
      completionStateStore,
      completionStateKey: "completion:1",
      ...callbacks,
    });
    assert.equal(thirdResult.inProgress, true);

    uiUpdate.resolve();
    await first;
    const replayResult = await finalizeCompletion({
      completionStateStore,
      completionStateKey: "completion:1",
      ...callbacks,
    });

    assert.equal(replayResult.replay, true);
    assert.equal(replayResult.status, COMPLETION_STATUS.COMPLETED);
    assert.equal(persistCalls, 1);
    assert.equal(followupCalls, 1);
    assert.equal(updateCalls, 1);
  });

  test("UI만 실패하면 확인된 followup ts를 재사용하고 UI만 재시도한다", async () => {
    const completionStateStore = new Map();
    let persistCalls = 0;
    let followupCalls = 0;
    let updateCalls = 0;
    const callbacks = {
      persistCompletion: async () => { persistCalls++; },
      postFollowup: async () => {
        followupCalls++;
        return { ts: "known-followup-ts" };
      },
      updateCompletionMessage: async ({ followupMessageTs }) => {
        updateCalls++;
        assert.equal(followupMessageTs, "known-followup-ts");
        if (updateCalls === 1) throw new Error("ui unavailable");
      },
    };

    await assert.rejects(
      () => finalizeCompletion({
        completionStateStore,
        completionStateKey: "completion:2",
        ...callbacks,
      }),
      error => error.completionRecovery === COMPLETION_RECOVERY.RETRY_UI_ONLY
    );
    assert.equal(completionStateStore.get("completion:2").status, COMPLETION_STATUS.FOLLOWUP_POSTED);

    await finalizeCompletion({
      completionStateStore,
      completionStateKey: "completion:2",
      ...callbacks,
    });

    assert.equal(persistCalls, 1);
    assert.equal(followupCalls, 1);
    assert.equal(updateCalls, 2);
    assert.equal(completionStateStore.get("completion:2").status, COMPLETION_STATUS.COMPLETED);
  });

  test("followup 응답이 실패하거나 ts가 없으면 review_required로 고정하고 blind repost하지 않는다", async () => {
    for (const postFollowup of [
      async () => { throw new Error("response lost"); },
      async () => ({}),
    ]) {
      const completionStateStore = new Map();
      let persistCalls = 0;
      let followupCalls = 0;
      let updateCalls = 0;
      const callbacks = {
        persistCompletion: async () => { persistCalls++; },
        postFollowup: async () => {
          followupCalls++;
          return postFollowup();
        },
        updateCompletionMessage: async () => { updateCalls++; },
      };

      await assert.rejects(
        () => finalizeCompletion({
          completionStateStore,
          completionStateKey: "completion:review",
          ...callbacks,
        }),
        error => error.completionRecovery === COMPLETION_RECOVERY.REVIEW_REQUIRED
      );
      const replay = await finalizeCompletion({
        completionStateStore,
        completionStateKey: "completion:review",
        ...callbacks,
      });

      assert.equal(replay.status, COMPLETION_STATUS.REVIEW_REQUIRED);
      assert.equal(replay.replay, true);
      assert.equal(persistCalls, 1);
      assert.equal(followupCalls, 1);
      assert.equal(updateCalls, 0);
    }
  });

  test("프로세스 재시작 뒤 followup marker를 reconcile하면 persist/post 없이 UI만 한 번 갱신한다", async () => {
    const completionStateStore = new Map();
    let persistCalls = 0;
    let followupCalls = 0;
    let updateCalls = 0;

    const result = await finalizeCompletion({
      completionStateStore,
      completionStateKey: "completion:restart",
      reconciledFollowupMessageTs: "existing-followup-ts",
      persistCompletion: async () => { persistCalls++; },
      postFollowup: async () => {
        followupCalls++;
        return { ts: "duplicate-followup-ts" };
      },
      updateCompletionMessage: async ({ followupMessageTs }) => {
        updateCalls++;
        assert.equal(followupMessageTs, "existing-followup-ts");
      },
    });

    assert.equal(result.status, COMPLETION_STATUS.COMPLETED);
    assert.equal(persistCalls, 0);
    assert.equal(followupCalls, 0);
    assert.equal(updateCalls, 1);
  });
});
