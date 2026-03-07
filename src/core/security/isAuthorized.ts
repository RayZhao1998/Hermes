import type { MessageEnvelope } from "../channel/MessageEnvelope.js";

export interface AccessControlConfig {
  allowChats: string[];
  allowUsers: string[];
}

export function buildScopedId(platform: MessageEnvelope["platform"], id: string): string {
  return `${platform}:${id}`;
}

export function isAuthorizedMessage(message: MessageEnvelope, config: AccessControlConfig): boolean {
  const scopedChat = buildScopedId(message.platform, message.chatId);
  const scopedUser = buildScopedId(message.platform, message.userId);

  return (
    config.allowChats.includes(scopedChat) ||
    config.allowChats.includes(message.chatId) ||
    config.allowUsers.includes(scopedUser) ||
    config.allowUsers.includes(message.userId)
  );
}
