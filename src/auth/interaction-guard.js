"use strict";

const { ACCESS, getAccessPolicy } = require("./interaction-access-policy");
const { isTriggerReaction } = require("../utils/trigger");

const RECORD_ID_FIELDS = Object.freeze([
  "draftId",
  "pendingId",
  "multiPendingId",
  "retryId",
  "recordId",
]);

function normalizeWorkerIds(value) {
  if (Array.isArray(value)) return value.map(String).map(id => id.trim()).filter(Boolean);
  if (typeof value !== "string") return [];
  return value.split(",").map(id => id.trim()).filter(Boolean);
}

function parseMetadata(rawValue) {
  if (typeof rawValue !== "string" || !rawValue) return {};
  try {
    const parsed = JSON.parse(rawValue);
    return parsed && typeof parsed === "object" ? parsed : { recordId: rawValue };
  } catch (_) {
    return { recordId: rawValue };
  }
}

function findStoredRecord(metadata, draftStore) {
  if (!draftStore || !metadata) return null;
  for (const field of RECORD_ID_FIELDS) {
    const recordId = metadata[field];
    if (typeof recordId !== "string" || !recordId) continue;
    const record = draftStore.get(recordId);
    if (record) return record;
  }
  return null;
}

/**
 * Bolt listener 종류별 실제 사용자 위치에서 Slack user ID를 읽는다.
 * @param {"action"|"view"|"event"|"message"} kind
 * @param {{ body?: object, event?: object, message?: object }} args
 * @returns {string|null}
 */
function extractActorUserId(kind, { body, event, message }) {
  if (kind === "action" || kind === "view") return body?.user?.id || null;
  if (kind === "event") return event?.user || body?.event?.user || null;
  if (kind === "message") return message?.user || body?.event?.user || null;
  return null;
}

function interactionReference({ kind, body, event, message, draftStore }) {
  const rawValue = body?.actions?.[0]?.value ?? body?.view?.private_metadata ?? "";
  const metadata = parseMetadata(rawValue);
  const record = findStoredRecord(metadata, draftStore);
  return {
    actorUserId: extractActorUserId(kind, { body, event, message }),
    metadata,
    record,
    ownerUserId: record?.ownerUserId || metadata.ownerUserId || metadata.submitterId || null,
    targetWorkerIds: normalizeWorkerIds(record?.targetWorkerSlackIds),
  };
}

async function authorize({ access, reference, checkPermission, pmSlackId }) {
  const { actorUserId, ownerUserId, targetWorkerIds } = reference;
  if (access === ACCESS.PM_ONLY) return !!actorUserId && actorUserId === pmSlackId;
  if (access === ACCESS.WORKER_TARGET) {
    return !!actorUserId && targetWorkerIds.includes(actorUserId);
  }

  const permission = await checkPermission(actorUserId);
  if (access === ACCESS.ENTRY_APM) return !!permission?.allowed;
  if (access === ACCESS.OWNER_APM) {
    return !!permission?.allowed && !!ownerUserId && actorUserId === ownerUserId;
  }
  if (access === ACCESS.COMPLETION) {
    return (!!actorUserId && actorUserId === pmSlackId) ||
      (!!permission?.allowed && !!ownerUserId && actorUserId === ownerUserId);
  }
  return false;
}

function isHumanDirectMessage(message) {
  return !!message?.user && !message.subtype && !message.bot_id && message.channel_type === "im";
}

function isInteractionInScope({ kind, event, message, triggerEmoji }) {
  if (kind === "event") {
    return !!event && isTriggerReaction(event.reaction, triggerEmoji);
  }
  if (kind === "message") return isHumanDirectMessage(message);
  return true;
}

function denialText(access) {
  if (access === ACCESS.PM_ONLY) return "⚠️ 지정된 PM 담당자만 처리할 수 있어.";
  if (access === ACCESS.WORKER_TARGET) return "⚠️ 이 요청을 받은 작업자만 답변할 수 있어.";
  return "⚠️ 이 요청을 실행할 권한이 없거나 초안 소유자를 확인할 수 없어.";
}

async function notifyDenied({ kind, client, body, event, message, access }) {
  const actorUserId = extractActorUserId(kind, { body, event, message });
  if (!actorUserId || !client?.chat) return;
  const text = denialText(access);

  if (kind === "event" && event?.item?.channel && client.chat.postEphemeral) {
    await client.chat.postEphemeral({
      channel: event.item.channel,
      user: actorUserId,
      text,
    }).catch(() => {});
    return;
  }

  const channel = message?.channel || actorUserId;
  if (client.chat.postMessage) {
    await client.chat.postMessage({ channel, text }).catch(() => {});
  }
}

function createInteractionGuard({ app, draftStore, checkPermission, pmSlackId, triggerEmoji }) {
  function requirePolicy(kind, matcher) {
    const policy = getAccessPolicy(kind, matcher);
    if (!policy) {
      const key = matcher instanceof RegExp ? matcher.toString() : String(matcher);
      throw new Error(`[interaction-guard] 미분류 Slack surface: ${kind}:${key}`);
    }
    return policy;
  }

  async function runGuarded({ kind, policy, args, handler, acknowledge }) {
    let acknowledged = false;
    const ackOnce = async (...ackArgs) => {
      if (!acknowledge || acknowledged) return undefined;
      acknowledged = true;
      return args.ack(...ackArgs);
    };

    if (acknowledge) await ackOnce();
    if (!isInteractionInScope({
      kind,
      event: args.event,
      message: args.message,
      triggerEmoji,
    })) return undefined;

    const reference = interactionReference({
      kind,
      body: args.body,
      event: args.event,
      message: args.message,
      draftStore,
    });
    const allowed = await authorize({
      access: policy.policy,
      reference,
      checkPermission,
      pmSlackId,
    });
    if (!allowed) {
      await notifyDenied({
        kind,
        client: args.client,
        body: args.body,
        event: args.event,
        message: args.message,
        access: policy.policy,
      });
      return undefined;
    }

    return handler(acknowledge ? { ...args, ack: ackOnce } : args);
  }

  function registerInteractive(kind, matcher, handler) {
    const policy = requirePolicy(kind, matcher);
    return app[kind](matcher, args => runGuarded({
      kind,
      policy,
      args,
      handler,
      acknowledge: true,
    }));
  }

  return new Proxy(app, {
    get(target, property, receiver) {
      if (property === "action") {
        return (matcher, handler) => registerInteractive("action", matcher, handler);
      }
      if (property === "view") {
        return (matcher, handler) => registerInteractive("view", matcher, handler);
      }
      if (property === "event") {
        return (matcher, handler) => {
          const policy = requirePolicy("event", matcher);
          return target.event(matcher, args => runGuarded({
            kind: "event", policy, args, handler, acknowledge: false,
          }));
        };
      }
      if (property === "message") {
        return (...registrationArgs) => {
          const handler = registrationArgs[registrationArgs.length - 1];
          const matchArgs = registrationArgs.slice(0, -1);
          const policy = requirePolicy("message", "human_dm");
          return target.message(...matchArgs, args => runGuarded({
            kind: "message", policy, args, handler, acknowledge: false,
          }));
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

module.exports = {
  authorize,
  createInteractionGuard,
  extractActorUserId,
  isHumanDirectMessage,
  isInteractionInScope,
  interactionReference,
  normalizeWorkerIds,
};
