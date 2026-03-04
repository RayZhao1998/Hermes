import type { MessageEnvelope } from "../channel/MessageEnvelope.js";

export interface AccessControlConfig {
  allowedChatIds: string[];
  allowedUserIds: string[];
}

export function buildScopedId(platform: MessageEnvelope["platform"], id: string): string {
  return `${platform}:${id}`;
}

export function isAuthorizedMessage(message: MessageEnvelope, config: AccessControlConfig): boolean {
  const scopedChat = buildScopedId(message.platform, message.chatId);
  const scopedUser = buildScopedId(message.platform, message.userId);

  return (
    config.allowedChatIds.includes(scopedChat) ||
    config.allowedChatIds.includes(message.chatId) ||
    config.allowedUserIds.includes(scopedUser) ||
    config.allowedUserIds.includes(message.userId)
  );
}
