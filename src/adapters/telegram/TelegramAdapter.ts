import { Telegraf } from "telegraf";
import type { Logger } from "pino";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { ChannelAdapter } from "../../core/channel/ChannelAdapter.js";
import type { MessageEnvelope } from "../../core/channel/MessageEnvelope.js";

function resolveProxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy ??
    process.env.ALL_PROXY ??
    process.env.all_proxy
  );
}

function safeProxyHint(proxyUrl: string): string {
  try {
    const parsed = new URL(proxyUrl);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "configured";
  }
}

export class TelegramAdapter implements ChannelAdapter {
  readonly platform = "telegram" as const;

  private readonly bot: Telegraf;
  private onMessageHandler?: (msg: MessageEnvelope) => Promise<void>;
  private launchPromise?: Promise<void>;

  constructor(token: string, private readonly logger: Logger) {
    const proxyUrl = resolveProxyUrl();
    this.bot = proxyUrl
      ? new Telegraf(token, {
          telegram: {
            agent: new HttpsProxyAgent(proxyUrl),
          },
        })
      : new Telegraf(token);

    if (proxyUrl) {
      this.logger.info({ proxy: safeProxyHint(proxyUrl) }, "Telegram API proxy enabled");
    } else {
      this.logger.info("Telegram API proxy not configured; using direct network");
    }
    this.bot.catch((error) => {
      const err = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: err }, "Telegraf global error");
    });

    this.bot.on("text", async (ctx) => {
      const text = ctx.message.text ?? "";
      const envelope: MessageEnvelope = {
        platform: "telegram",
        chatId: String(ctx.chat.id),
        userId: String(ctx.from.id),
        messageId: String(ctx.message.message_id),
        text,
        isCommand: text.trim().startsWith("/"),
        timestamp: ctx.message.date * 1000,
      };

      if (!this.onMessageHandler) {
        this.logger.warn({ chatId: envelope.chatId }, "No message handler is registered");
        return;
      }

      try {
        this.logger.info({ chatId: envelope.chatId, userId: envelope.userId, text }, "Telegram text received");
        await this.onMessageHandler(envelope);
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        this.logger.error({ error: err }, "Telegram message handler failed");
        await this.sendMessage(envelope.chatId, `Internal error: ${err}`);
      }
    });
  }

  onMessage(handler: (msg: MessageEnvelope) => Promise<void>): void {
    this.onMessageHandler = handler;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(chatId, text);
      this.logger.info({ chatId, textPreview: text.slice(0, 80) }, "Telegram message sent");
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: err, chatId }, "Telegram sendMessage failed");
      throw error;
    }
  }

  async start(): Promise<void> {
    const me = await this.bot.telegram.getMe();
    this.logger.info({ username: me.username, id: me.id }, "Telegram getMe ok");

    this.launchPromise = this.bot
      .launch({
        dropPendingUpdates: false,
      })
      .catch((error) => {
        const err = error instanceof Error ? error.message : String(error);
        this.logger.error({ error: err }, "Telegram polling failed");
        throw error;
      });

    this.logger.info("Telegram adapter started (long polling background)");
  }

  async stop(): Promise<void> {
    if (this.launchPromise) {
      this.bot.stop("SIGTERM");
      await this.launchPromise.catch(() => {
        // already logged in start()
      });
      this.launchPromise = undefined;
    }
    this.logger.info("Telegram adapter stopped");
  }
}
