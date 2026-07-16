"use strict";

function isPublicationLocked(publicationStateStore, publicationKey) {
  return Boolean(publicationStateStore.get(publicationKey));
}

function buildTerminalPublicationBlocks(blocks, {
  label,
  status,
  actorUserId,
}) {
  const terminalText = status === "sent"
    ? `✅ *${label} 전송 완료*${actorUserId ? ` — <@${actorUserId}>` : ""}`
    : `⚠️ *${label} 운영자 확인 필요* — 결과가 불명확해 이 초안은 다시 전송할 수 없어.`;
  return [
    ...(blocks || []).filter(block => block.type !== "actions"),
    {
      type: "context",
      block_id: "publication_terminal_state",
      elements: [{ type: "mrkdwn", text: terminalText }],
    },
  ];
}

async function updateTerminalPublicationPreview({
  client,
  channel,
  ts,
  text,
  blocks,
  label,
  status,
  actorUserId,
}) {
  if (!channel || !ts || !client.chat?.update) return false;
  await client.chat.update({
    channel,
    ts,
    text: text || `${label} ${status === "sent" ? "전송 완료" : "운영자 확인 필요"}`,
    blocks: buildTerminalPublicationBlocks(blocks, { label, status, actorUserId }),
  });
  return true;
}

module.exports = {
  buildTerminalPublicationBlocks,
  isPublicationLocked,
  updateTerminalPublicationPreview,
};
