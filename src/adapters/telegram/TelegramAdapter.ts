import { createMemoryState } from "@chat-adapter/state-memory";
import {
  createTelegramAdapter,
  type TelegramAdapter as ChatSdkTelegramAdapter,
} from "@chat-adapter/telegram";
import { Chat, type Logger as ChatSdkLogger, type Message, type Thread } from "chat";
import type { Logger } from "pino";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import type { ChannelAdapter } from "../../core/channel/ChannelAdapter.js";
import type { MessageEnvelope } from "../../core/channel/MessageEnvelope.js";
import { commandDefinitions } from "../../core/router/CommandRouter.js";

let globalProxyConfigured = false;

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

function configureGlobalFetchProxy(logger: Logger): void {
  if (globalProxyConfigured) {
    return;
  }

  const proxyUrl = resolveProxyUrl();
  if (!proxyUrl) {
    logger.info("Telegram API proxy not configured; using direct network");
    globalProxyConfigured = true;
    return;
  }

  setGlobalDispatcher(new EnvHttpProxyAgent());
  logger.info({ proxy: safeProxyHint(proxyUrl) }, "Global fetch proxy enabled for Chat SDK");
  globalProxyConfigured = true;
}

class PinoChatSdkLogger implements ChatSdkLogger {
  constructor(private readonly logger: Logger) {}

  child(prefix: string): ChatSdkLogger {
    return new PinoChatSdkLogger(this.logger.child({ chatSdk: prefix }));
  }

  debug(message: string, ...args: unknown[]): void {
    this.log("debug", message, args);
  }

  info(message: string, ...args: unknown[]): void {
    this.log("info", message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.log("warn", message, args);
  }

  error(message: string, ...args: unknown[]): void {
    this.log("error", message, args);
  }

  private log(level: "debug" | "info" | "warn" | "error", message: string, args: unknown[]): void {
    if (args.length === 0) {
      this.logger[level](message);
      return;
    }

    this.logger[level]({ args }, message);
  }
}

export class TelegramAdapter implements ChannelAdapter {
  readonly platform = "telegram" as const;

  private readonly token: string;
  private readonly telegram: ChatSdkTelegramAdapter;
  private readonly bot: Chat;
  private onMessageHandler?: (msg: MessageEnvelope) => Promise<void>;

  constructor(token: string, private readonly logger: Logger) {
    this.token = token;
    configureGlobalFetchProxy(logger);

    const chatLogger = new PinoChatSdkLogger(logger);

    this.telegram = createTelegramAdapter({
      botToken: token,
      mode: "polling",
      logger: chatLogger.child("telegram"),
    });

    this.bot = new Chat({
      userName: "hermes",
      adapters: {
        telegram: this.telegram,
      },
      state: createMemoryState(),
      logger: chatLogger.child("bot"),
    });

    this.bot.onNewMention(async (thread, message) => {
      await thread.subscribe();
      await this.forwardMessage(thread, message);
    });

    this.bot.onNewMessage(/[\s\S]*/u, async (thread, message) => {
      await thread.subscribe();
      await this.forwardMessage(thread, message);
    });

    this.bot.onSubscribedMessage(async (thread, message) => {
      await this.forwardMessage(thread, message);
    });
  }

  onMessage(handler: (msg: MessageEnvelope) => Promise<void>): void {
    this.onMessageHandler = handler;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    try {
      await this.telegram.postMessage(this.toThreadId(chatId), text);
      this.logger.info({ chatId, textPreview: text.slice(0, 80) }, "Telegram message sent via Chat SDK");
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: err, chatId }, "Telegram sendMessage failed");
      throw error;
    }
  }

  async setTyping(chatId: string): Promise<void> {
    try {
      await this.telegram.startTyping(this.toThreadId(chatId));
      this.logger.debug({ chatId }, "Telegram typing signal sent");
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      this.logger.warn({ error: err, chatId }, "Telegram typing signal failed");
    }
  }

  async start(): Promise<void> {
    await this.bot.initialize();
    try {
      await registerTelegramCommands(this.token, this.logger);
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      this.logger.warn({ error: err }, "Telegram bot commands registration failed");
    }
    this.logger.info(
      { runtimeMode: this.telegram.runtimeMode, username: this.telegram.userName || "unknown" },
      "Telegram adapter started via Chat SDK",
    );
  }

  async stop(): Promise<void> {
    await this.bot.shutdown();
    this.logger.info("Telegram adapter stopped");
  }

  private async forwardMessage(thread: Thread, message: Message): Promise<void> {
    const text = message.text ?? "";
    const { chatId } = this.telegram.decodeThreadId(thread.id);

    if (!text.trim()) {
      this.logger.debug({ chatId, messageId: message.id }, "Ignoring empty Telegram message");
      return;
    }

    const envelope: MessageEnvelope = {
      platform: "telegram",
      chatId,
      userId: message.author.userId,
      messageId: message.id,
      text,
      isCommand: text.trim().startsWith("/"),
      timestamp: message.metadata.dateSent.getTime(),
    };

    if (!this.onMessageHandler) {
      this.logger.warn({ chatId }, "No message handler is registered");
      return;
    }

    try {
      this.logger.info(
        { chatId: envelope.chatId, userId: envelope.userId, text: envelope.text },
        "Telegram text received via Chat SDK",
      );
      await this.onMessageHandler(envelope);
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: err }, "Telegram message handler failed");
      await this.sendMessage(envelope.chatId, `Internal error: ${err}`);
    }
  }

  private toThreadId(chatId: string): string {
    return this.telegram.encodeThreadId({ chatId });
  }
}

interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
}

export async function registerTelegramCommands(token: string, logger: Logger): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      commands: commandDefinitions.map(({ name, description }) => ({
        command: name,
        description,
      })),
    }),
  });

  const payload = (await response.json()) as TelegramApiResponse;
  if (!response.ok || !payload.ok) {
    throw new Error(payload.description ?? `HTTP ${response.status}`);
  }

  logger.info(
    { commands: commandDefinitions.map(({ name }) => name) },
    "Telegram bot commands registered",
  );
}
