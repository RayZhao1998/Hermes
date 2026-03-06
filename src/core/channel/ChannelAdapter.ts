import type { MessageEnvelope, Platform } from "./MessageEnvelope.js";
import type { ChatCommandDefinition } from "../router/CommandRouter.js";
import type { ToolPermissionDecision, ToolPermissionRequest } from "./PermissionRequest.js";

export interface OutboundMessageHandle {
  chatId: string;
  messageId: string;
  threadId?: string;
}

export interface ChannelAdapter {
  platform: Platform;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<OutboundMessageHandle>;
  editMessage?(message: OutboundMessageHandle, text: string): Promise<OutboundMessageHandle>;
  setTyping?(chatId: string): Promise<void>;
  syncCommands?(chatId: string, commands: readonly ChatCommandDefinition[]): Promise<void>;
  requestPermission?(
    chatId: string,
    request: ToolPermissionRequest,
    signal?: AbortSignal,
  ): Promise<ToolPermissionDecision>;
  onMessage(handler: (msg: MessageEnvelope) => Promise<void>): void;
}
