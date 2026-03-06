import type { MessageEnvelope, Platform } from "./MessageEnvelope.js";
import type { ChatCommandDefinition } from "../router/CommandRouter.js";

export interface ChannelAdapter {
  platform: Platform;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<void>;
  setTyping?(chatId: string): Promise<void>;
  syncCommands?(chatId: string, commands: readonly ChatCommandDefinition[]): Promise<void>;
  onMessage(handler: (msg: MessageEnvelope) => Promise<void>): void;
}
