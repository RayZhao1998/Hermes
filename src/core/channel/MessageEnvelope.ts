export type Platform = "telegram" | "discord";

export interface MessageEnvelope {
  platform: Platform;
  chatId: string;
  userId: string;
  messageId: string;
  text: string;
  isCommand: boolean;
  timestamp: number;
}
