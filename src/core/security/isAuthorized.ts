import type { MessageEnvelope } from "../channel/MessageEnvelope.js";

export interface AccessControlConfig {
  allowChats: string[];
  allowUsers: string[];
}

export function buildScopedId(platform: MessageEnvelope["platform"], id: string): string {
  return `${platform}:${id}`;
}

function buildAuthorizedChatIds(message: MessageEnvelope): string[] {
  const chatIds = [
    buildScopedId(message.platform, message.chatId),
    message.chatId,
  ];

  if (message.platform !== "discord") {
    return chatIds;
  }

  const parts = message.chatId.split(":");
  if (parts.length !== 3) {
    return chatIds;
  }

  const parentChatId = parts.slice(0, 2).join(":");
  chatIds.push(buildScopedId(message.platform, parentChatId), parentChatId);
  return chatIds;
}

export function isAuthorizedMessage(message: MessageEnvelope, config: AccessControlConfig): boolean {
  const scopedUser = buildScopedId(message.platform, message.userId);
  const authorizedChatIds = buildAuthorizedChatIds(message);

  return (
    authorizedChatIds.some((chatId) => config.allowChats.includes(chatId)) ||
    config.allowUsers.includes(scopedUser) ||
    config.allowUsers.includes(message.userId)
  );
}
