"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  createInteractionGuard,
} = require("../interaction-guard");
const {
  INTERACTION_SURFACES,
} = require("../interaction-access-policy");

function makeSpy(implementation = async () => undefined) {
  const calls = [];
  const spy = async (...args) => {
    calls.push(args);
    return implementation(...args);
  };
  spy.calls = calls;
  return spy;
}

function makeApp() {
  const registrations = { action: [], view: [], event: [], message: [] };
  const app = {
    action(matcher, handler) { registrations.action.push({ matcher, handler }); },
    view(matcher, handler) { registrations.view.push({ matcher, handler }); },
    event(matcher, handler) { registrations.event.push({ matcher, handler }); },
    message(...args) {
      registrations.message.push({ matcher: args.slice(0, -1), handler: args.at(-1) });
    },
    registrations,
  };
  return app;
}

function makeClient() {
  return {
    chat: {
      postMessage: makeSpy(),
      postEphemeral: makeSpy(),
    },
  };
}

function createHarness({ records = [], permission } = {}) {
  const app = makeApp();
  const checkPermission = makeSpy(async userId => (
    permission ? permission(userId) : { allowed: userId === "U_OWNER" || userId === "U_ALLOWED" }
  ));
  const guarded = createInteractionGuard({
    app,
    draftStore: new Map(records),
    checkPermission,
    pmSlackId: "U_PM",
    triggerEmoji: "inquiry",
  });
  return { app, guarded, checkPermission };
}

function actionArgs({ user = "U_ALLOWED", value = "draft-1", client = makeClient(), ack } = {}) {
  return {
    ack: ack || makeSpy(),
    body: { user: { id: user }, actions: [{ value }] },
    client,
  };
}

function listJavaScriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") files.push(...listJavaScriptFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }
  return files;
}

function collectRegisteredSurfaceKeys() {
  const sourceRoot = path.resolve(__dirname, "../..");
  const keys = new Set();
  const registrationPattern = /app\.(action|view|event)\(\s*("[^"]+"|'[^']+'|\/[^\n,]+\/)/g;

  for (const filePath of listJavaScriptFiles(sourceRoot)) {
    const source = fs.readFileSync(filePath, "utf8");
    for (const match of source.matchAll(registrationPattern)) {
      const kind = match[1];
      const rawMatcher = match[2];
      const registrationKey = rawMatcher.startsWith("/")
        ? rawMatcher
        : rawMatcher.slice(1, -1);
      keys.add(`${kind}:${registrationKey}`);
    }
    if (/app\.message\(/.test(source)) keys.add("message:human_dm");
  }
  return [...keys].sort();
}

describe("interaction access policy", () => {
  test("소스에 등록된 surface 99개가 정책표와 중복·누락 없이 일치한다", () => {
    assert.equal(INTERACTION_SURFACES.length, 99);
    const policyKeys = INTERACTION_SURFACES.map(
      rule => `${rule.kind}:${rule.registrationKey}`
    );
    assert.equal(new Set(policyKeys).size, policyKeys.length);
    assert.deepEqual(collectRegisteredSurfaceKeys(), [...policyKeys].sort());
  });

  test("정책표에 없는 action은 등록 단계에서 실패한다", () => {
    const { guarded } = createHarness();
    assert.throws(
      () => guarded.action("unclassified_action", async () => {}),
      /미분류 Slack surface/
    );
  });
});

describe("interactive authorization", () => {
  test("ENTRY_APM 허용 시 ack를 먼저 한 번만 하고 핸들러를 실행한다", async () => {
    const order = [];
    const app = makeApp();
    const guarded = createInteractionGuard({
      app,
      draftStore: new Map(),
      checkPermission: async () => { order.push("permission"); return { allowed: true }; },
      pmSlackId: "U_PM",
      triggerEmoji: "inquiry",
    });
    guarded.action("direct_resupply_btn", async ({ ack }) => {
      order.push("handler");
      await ack();
    });
    const ack = makeSpy(async () => { order.push("ack"); });
    await app.registrations.action[0].handler(actionArgs({ ack }));
    assert.deepEqual(order, ["ack", "permission", "handler"]);
    assert.equal(ack.calls.length, 1);
  });

  test("ENTRY_APM 거부 시 ack 후 핸들러를 막고 사용자에게 알린다", async () => {
    const { app, guarded } = createHarness({ permission: () => ({ allowed: false }) });
    let handled = 0;
    guarded.action("direct_resupply_btn", async () => { handled++; });
    const client = makeClient();
    const args = actionArgs({ user: "U_DENIED", client });
    await app.registrations.action[0].handler(args);
    assert.equal(args.ack.calls.length, 1);
    assert.equal(handled, 0);
    assert.equal(client.chat.postMessage.calls.length, 1);
  });

  test("OWNER_APM은 허용 APM과 저장된 ownerUserId가 같으면 실행한다", async () => {
    const { app, guarded } = createHarness({
      records: [["draft-1", { ownerUserId: "U_OWNER" }]],
    });
    let handled = 0;
    guarded.action("send_inquiry_now", async () => { handled++; });
    await app.registrations.action[0].handler(actionArgs({ user: "U_OWNER" }));
    assert.equal(handled, 1);
  });

  test("OWNER_APM은 다른 허용 APM의 초안 접근을 거부한다", async () => {
    const { app, guarded } = createHarness({
      records: [["draft-1", { ownerUserId: "U_OWNER" }]],
      permission: () => ({ allowed: true }),
    });
    let handled = 0;
    guarded.action("send_inquiry_now", async () => { handled++; });
    await app.registrations.action[0].handler(actionArgs({ user: "U_OTHER" }));
    assert.equal(handled, 0);
  });

  test("OWNER_APM은 레거시 레코드에 ownerUserId가 없으면 fail-closed한다", async () => {
    const { app, guarded } = createHarness({
      records: [["draft-1", { workName: "legacy" }]],
      permission: () => ({ allowed: true }),
    });
    let handled = 0;
    guarded.action("send_inquiry_now", async () => { handled++; });
    await app.registrations.action[0].handler(actionArgs({ user: "U_OWNER" }));
    assert.equal(handled, 0);
  });

  test("COMPLETION은 초안 소유 APM에게 허용한다", async () => {
    const { app, guarded } = createHarness({
      records: [["draft-1", { ownerUserId: "U_OWNER" }]],
    });
    let handled = 0;
    guarded.action("retake_close", async () => { handled++; });
    await app.registrations.action[0].handler(actionArgs({ user: "U_OWNER" }));
    assert.equal(handled, 1);
  });

  test("COMPLETION은 지정 PM에게도 허용한다", async () => {
    const { app, guarded } = createHarness({
      records: [["draft-1", { ownerUserId: "U_OWNER" }]],
      permission: () => ({ allowed: false }),
    });
    let handled = 0;
    guarded.action("retake_close", async () => { handled++; });
    await app.registrations.action[0].handler(actionArgs({ user: "U_PM" }));
    assert.equal(handled, 1);
  });

  test("PM_ONLY는 지정 PM만 허용한다", async () => {
    const { app, guarded } = createHarness({ permission: () => ({ allowed: true }) });
    let handled = 0;
    guarded.action("schext_pm_delivery_confirm", async () => { handled++; });
    await app.registrations.action[0].handler(actionArgs({ user: "U_OTHER" }));
    await app.registrations.action[0].handler(actionArgs({ user: "U_PM" }));
    assert.equal(handled, 1);
  });

  test("WORKER_TARGET은 저장된 대상 작업자에게 허용한다", async () => {
    const { app, guarded } = createHarness({
      records: [["draft-1", { ownerUserId: "U_OWNER", targetWorkerSlackIds: "U_W1,U_W2" }]],
    });
    let handled = 0;
    guarded.action("wr_worker_reply", async () => { handled++; });
    await app.registrations.action[0].handler(actionArgs({ user: "U_W2" }));
    assert.equal(handled, 1);
  });

  test("WORKER_TARGET은 대상이 아닌 작업자를 거부한다", async () => {
    const { app, guarded } = createHarness({
      records: [["draft-1", { ownerUserId: "U_OWNER", targetWorkerSlackIds: ["U_W1"] }]],
    });
    let handled = 0;
    guarded.action("wr_worker_reply", async () => { handled++; });
    await app.registrations.action[0].handler(actionArgs({ user: "U_W9" }));
    assert.equal(handled, 0);
  });
});

describe("event and message scope", () => {
  test("실제 Bolt envelope와 event가 함께 와도 설정된 reaction을 허용한다", async () => {
    const { app, guarded } = createHarness();
    let handled = 0;
    guarded.event("reaction_added", async () => { handled++; });
    const event = { reaction: "inquiry", user: "U_ALLOWED", item: { channel: "C1" } };
    await app.registrations.event[0].handler({
      body: { type: "event_callback", event },
      event,
      client: makeClient(),
    });
    assert.equal(handled, 1);
  });

  test("실제 Bolt reaction envelope에서 비허용 사용자를 거부한다", async () => {
    const { app, guarded } = createHarness({ permission: () => ({ allowed: false }) });
    let handled = 0;
    const client = makeClient();
    guarded.event("reaction_added", async () => { handled++; });
    const event = { reaction: "inquiry", user: "U_DENIED", item: { channel: "C1" } };
    await app.registrations.event[0].handler({
      body: { type: "event_callback", event },
      event,
      client,
    });
    assert.equal(handled, 0);
    assert.equal(client.chat.postEphemeral.calls.length, 1);
  });

  test("다른 reaction은 권한 확인·핸들러·거부 알림을 모두 건너뛴다", async () => {
    const { app, guarded, checkPermission } = createHarness();
    let handled = 0;
    const client = makeClient();
    guarded.event("reaction_added", async () => { handled++; });
    const event = { reaction: "thumbsup", user: "U_ALLOWED", item: { channel: "C1" } };
    await app.registrations.event[0].handler({
      body: { type: "event_callback", event },
      event,
      client,
    });
    assert.equal(checkPermission.calls.length, 0);
    assert.equal(handled, 0);
    assert.equal(client.chat.postEphemeral.calls.length, 0);
  });

  test("실제 Bolt envelope와 message가 함께 와도 사람 DM만 처리한다", async () => {
    const { app, guarded, checkPermission } = createHarness();
    let handled = 0;
    const client = makeClient();
    guarded.message(async () => { handled++; });
    const invoke = message => app.registrations.message[0].handler({
      body: { type: "event_callback", event: message },
      message,
      client,
    });

    await invoke({ user: "U_ALLOWED", channel: "D1", channel_type: "im" });
    await invoke({ user: "U_ALLOWED", channel: "D1", channel_type: "im", bot_id: "B1" });
    await invoke({ user: "U_ALLOWED", channel: "D1", channel_type: "im", subtype: "message_changed" });
    await invoke({ user: "U_ALLOWED", channel: "C1", channel_type: "channel" });

    assert.equal(checkPermission.calls.length, 1);
    assert.equal(handled, 1);
    assert.equal(client.chat.postMessage.calls.length, 0);
  });
});
