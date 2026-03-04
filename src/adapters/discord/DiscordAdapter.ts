import type { Logger } from "pino";
import type { ChannelAdapter } from "../../core/channel/ChannelAdapter.js";
import type { MessageEnvelope } from "../../core/channel/MessageEnvelope.js";

// V2 placeholder: keeps channel abstraction stable while Discord is not enabled yet.
export class DiscordAdapter implements ChannelAdapter {
  readonly platform = "discord" as const;

  constructor(private readonly logger: Logger) {}

  onMessage(_handler: (msg: MessageEnvelope) => Promise<void>): void {
    // TODO(V2): wire Discord gateway events.
  }

  async sendMessage(_chatId: string, _text: string): Promise<void> {
    throw new Error("Discord adapter is not implemented in V1.");
  }

  async start(): Promise<void> {
    this.logger.info("Discord adapter placeholder loaded (disabled in V1)");
  }

  async stop(): Promise<void> {
    this.logger.info("Discord adapter placeholder stopped");
  }
}
