"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  COMPLETION_NOTICE,
  PUBLICATION_RECOVERY,
  PUBLICATION_STATUS,
  publishFromCheckpoint,
} = require("../publication-coordinator");

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe("publication coordinator", () => {
  test("첫 await 전에 선점해 동시 클릭과 sent replay에서 append/main을 한 번만 실행한다", async () => {
    const publicationStateStore = new Map();
    const appendResult = deferred();
    let appendCalls = 0;
    let mainCalls = 0;
    let threadCalls = 0;
    const callbacks = {
      appendSheetRow: async () => {
        appendCalls++;
        return appendResult.promise;
      },
      postMainMessage: async () => {
        mainCalls++;
        return { ts: "main-ts" };
      },
      postThreadMessage: async () => { threadCalls++; return { ts: "thread-ts" }; },
    };

    const first = publishFromCheckpoint({
      publicationStateStore,
      publicationKey: "publication:1",
      ...callbacks,
    });
    const concurrent = await publishFromCheckpoint({
      publicationStateStore,
      publicationKey: "publication:1",
      ...callbacks,
    });
    assert.equal(concurrent.inProgress, true);

    appendResult.resolve(11);
    await first;
    const replay = await publishFromCheckpoint({
      publicationStateStore,
      publicationKey: "publication:1",
      ...callbacks,
    });

    assert.equal(replay.status, PUBLICATION_STATUS.SENT);
    assert.equal(replay.replay, true);
    assert.equal(appendCalls, 1);
    assert.equal(mainCalls, 1);
    assert.equal(threadCalls, 1);
  });

  test("main 게시 오류는 row를 보존한 review_required이고 replay에서 blind repost하지 않는다", async () => {
    const publicationStateStore = new Map();
    let appendCalls = 0;
    let mainCalls = 0;
    const callbacks = {
      appendSheetRow: async () => { appendCalls++; return 12; },
      postMainMessage: async () => { mainCalls++; throw new Error("response lost"); },
    };

    await assert.rejects(
      () => publishFromCheckpoint({
        publicationStateStore,
        publicationKey: "publication:review",
        ...callbacks,
      }),
      error => error.publicationRecovery === PUBLICATION_RECOVERY.REVIEW_REQUIRED
    );
    const replay = await publishFromCheckpoint({
      publicationStateStore,
      publicationKey: "publication:review",
      ...callbacks,
    });

    assert.equal(replay.status, PUBLICATION_STATUS.REVIEW_REQUIRED);
    assert.equal(replay.sheetRowIndex, 12);
    assert.equal(appendCalls, 1);
    assert.equal(mainCalls, 1);
  });

  for (const stage of ["sheet", "thread", "completion_notice"]) {
    test(`${stage} 요청이 서버 반영 뒤 응답 유실되면 review_required이고 replay가 재전송하지 않는다`, async () => {
      const publicationStateStore = new Map();
      const calls = { sheet: 0, main: 0, thread: 0, completion_notice: 0 };
      const callbacks = {
        appendSheetRow: async () => {
          calls.sheet++;
          if (stage === "sheet") throw new Error("side effect committed, response lost");
          return 13;
        },
        postMainMessage: async () => {
          calls.main++;
          return { ts: "main-ts" };
        },
        postThreadMessage: async () => {
          calls.thread++;
          if (stage === "thread") throw new Error("side effect committed, response lost");
          return { ts: "thread-ts" };
        },
        postCompletionNotice: async () => {
          calls.completion_notice++;
          if (stage === "completion_notice") throw new Error("side effect committed, response lost");
          return { ts: "notice-ts" };
        },
      };

      await assert.rejects(
        () => publishFromCheckpoint({
          publicationStateStore,
          publicationKey: `publication:unknown:${stage}`,
          ...callbacks,
        }),
        error => error.publicationRecovery === PUBLICATION_RECOVERY.REVIEW_REQUIRED
      );
      const replay = await publishFromCheckpoint({
        publicationStateStore,
        publicationKey: `publication:unknown:${stage}`,
        ...callbacks,
      });

      assert.equal(replay.status, PUBLICATION_STATUS.REVIEW_REQUIRED);
      assert.equal(calls[stage], 1);
    });
  }

  test("thread와 완료 안내는 ts가 없으면 성공으로 확정하지 않는다", async () => {
    for (const missingTsStage of ["thread", "completion_notice"]) {
      const publicationStateStore = new Map();
      const calls = { thread: 0, completion_notice: 0 };
      const callbacks = {
        appendSheetRow: async () => 14,
        postMainMessage: async () => ({ ts: "main-ts" }),
        postThreadMessage: async () => {
          calls.thread++;
          return missingTsStage === "thread" ? {} : { ts: "thread-ts" };
        },
        postCompletionNotice: async () => {
          calls.completion_notice++;
          return missingTsStage === "completion_notice" ? {} : { ts: "notice-ts" };
        },
      };

      await assert.rejects(
        () => publishFromCheckpoint({
          publicationStateStore,
          publicationKey: `publication:missing-ts:${missingTsStage}`,
          ...callbacks,
        }),
        error => error.publicationRecovery === PUBLICATION_RECOVERY.REVIEW_REQUIRED
      );
      await publishFromCheckpoint({
        publicationStateStore,
        publicationKey: `publication:missing-ts:${missingTsStage}`,
        ...callbacks,
      });
      assert.equal(calls[missingTsStage], 1);
    }
  });
});
