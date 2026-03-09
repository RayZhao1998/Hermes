import { setTimeout as delay } from "node:timers/promises";
import { createMemoryState } from "@chat-adapter/state-memory";
import {
  createDiscordAdapter,
  type DiscordAdapter as ChatSdkDiscordAdapter,
} from "@chat-adapter/discord";
import {
  Chat,
  type Logger as ChatSdkLogger,
  type Message,
  type Thread,
} from "chat";
import type { Logger } from "pino";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import type { ChannelAdapter, OutboundMessageHandle } from "../../core/channel/ChannelAdapter.js";
import type { MessageEnvelope } from "../../core/channel/MessageEnvelope.js";

const GATEWAY_LISTENER_DURATION_MS = 10 * 60 * 1000;
const GATEWAY_RESTART_DELAY_MS = 1000;
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
    logger.info("Discord API proxy not configured; using direct network");
    globalProxyConfigured = true;
    return;
  }

  setGlobalDispatcher(new EnvHttpProxyAgent());
  logger.info({ proxy: safeProxyHint(proxyUrl) }, "Global fetch proxy enabled for Discord");
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

export function normalizeDiscordCommandText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("!") || trimmed.length < 2 || /^!\s/u.test(trimmed)) {
    return text;
  }
  return `/${trimmed.slice(1)}`;
}

export function toDiscordThreadId(chatId: string): string {
  return `discord:${chatId}`;
}

export function fromDiscordThreadId(threadId: string): string {
  const parts = threadId.split(":");
  if (parts[0] !== "discord" || parts.length < 3) {
    throw new Error(`Invalid Discord thread ID: ${threadId}`);
  }
  return parts.slice(1).join(":");
}

export class DiscordAdapter implements ChannelAdapter {
  readonly platform = "discord" as const;

  private readonly discord: ChatSdkDiscordAdapter;
  private readonly bot: Chat;
  private readonly gatewayLogger: Logger;
  private readonly gatewayListenerDurationMs: number;
  private onMessageHandler?: (msg: MessageEnvelope) => Promise<void>;
  private currentGatewayAbort?: AbortController;
  private activeGatewayPromise?: Promise<unknown>;
  private gatewayLoopPromise?: Promise<void>;
  private stopped = false;

  constructor(
    token: string,
    private readonly logger: Logger,
    applicationId?: string,
    publicKey?: string,
    gatewayListenerDurationMs = GATEWAY_LISTENER_DURATION_MS,
  ) {
    this.gatewayLogger = logger.child({ component: "gateway" });
    this.gatewayListenerDurationMs = gatewayListenerDurationMs;
    configureGlobalFetchProxy(logger);

    const chatLogger = new PinoChatSdkLogger(logger);
    this.discord = createDiscordAdapter({
      botToken: token,
      applicationId,
      publicKey,
      logger: chatLogger.child("discord"),
      userName: "hermes",
    });

    this.bot = new Chat({
      userName: "hermes",
      adapters: {
        discord: this.discord,
      },
      state: createMemoryState(),
      logger: chatLogger.child("bot"),
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

  async sendMessage(chatId: string, text: string): Promise<OutboundMessageHandle> {
    const threadId = toDiscordThreadId(chatId);

    try {
      const result = await this.discord.postMessage(threadId, text);
      this.logger.info({ chatId, textPreview: text.slice(0, 80) }, "Discord message sent via Chat SDK");
      return {
        chatId,
        messageId: result.id,
        threadId,
      };
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: err, chatId }, "Discord sendMessage failed");
      throw error;
    }
  }

  async editMessage(message: OutboundMessageHandle, text: string): Promise<OutboundMessageHandle> {
    const threadId = message.threadId ?? toDiscordThreadId(message.chatId);

    try {
      const result = await this.discord.editMessage(threadId, message.messageId, text);
      this.logger.info(
        { chatId: message.chatId, messageId: message.messageId, textPreview: text.slice(0, 80) },
        "Discord message edited via Chat SDK",
      );
      return {
        chatId: message.chatId,
        messageId: result.id,
        threadId,
      };
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: err, chatId: message.chatId, messageId: message.messageId }, "Discord editMessage failed");
      throw error;
    }
  }

  async setTyping(chatId: string): Promise<void> {
    try {
      await this.discord.startTyping(toDiscordThreadId(chatId));
      this.logger.debug({ chatId }, "Discord typing signal sent");
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      this.logger.warn({ error: err, chatId }, "Discord typing signal failed");
    }
  }

  async start(): Promise<void> {
    if (this.gatewayLoopPromise) {
      return;
    }

    this.stopped = false;
    await this.bot.initialize();
    await this.launchGatewayListener();
    this.gatewayLoopPromise = this.runGatewayLoop();
    this.logger.info("Discord adapter started via Chat SDK");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.currentGatewayAbort?.abort();
    await this.activeGatewayPromise?.catch(() => undefined);
    await this.gatewayLoopPromise?.catch(() => undefined);
    this.gatewayLoopPromise = undefined;
    this.activeGatewayPromise = undefined;
    this.currentGatewayAbort = undefined;
    await this.bot.shutdown();
    this.logger.info("Discord adapter stopped");
  }

  private async forwardMessage(thread: Thread, message: Message): Promise<void> {
    const originalText = message.text ?? "";
    const normalizedText = normalizeDiscordCommandText(originalText);
    const chatId = fromDiscordThreadId(thread.id);

    if (!originalText.trim()) {
      this.logger.debug({ chatId, messageId: message.id }, "Ignoring empty Discord message");
      return;
    }

    const envelope: MessageEnvelope = {
      platform: "discord",
      chatId,
      userId: message.author.userId,
      messageId: message.id,
      text: normalizedText,
      isCommand: normalizedText.trim().startsWith("/"),
      timestamp: message.metadata.dateSent.getTime(),
    };

    if (!this.onMessageHandler) {
      this.logger.warn({ chatId }, "No message handler is registered");
      return;
    }

    try {
      this.logger.info(
        { chatId: envelope.chatId, userId: envelope.userId, text: envelope.text },
        "Discord text received via Chat SDK",
      );
      await this.onMessageHandler(envelope);
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: err }, "Discord message handler failed");
      await this.sendMessage(envelope.chatId, `Internal error: ${err}`);
    }
  }

  private async runGatewayLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.activeGatewayPromise;
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        this.gatewayLogger.warn({ error: err }, "Discord gateway listener exited with error");
      }

      if (this.stopped) {
        break;
      }

      await delay(GATEWAY_RESTART_DELAY_MS);
      if (this.stopped) {
        break;
      }

      try {
        await this.launchGatewayListener();
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        this.gatewayLogger.error({ error: err }, "Failed to restart Discord gateway listener");
      }
    }
  }

  private async launchGatewayListener(): Promise<void> {
    const controller = new AbortController();
    let listenerPromise: Promise<unknown> | undefined;

    const response = await this.discord.startGatewayListener(
      {
        waitUntil(task) {
          listenerPromise = task;
        },
      },
      this.gatewayListenerDurationMs,
      controller.signal,
    );

    if (!response.ok) {
      const body = await response.text().catch(() => response.statusText);
      throw new Error(`Discord gateway listener failed to start (${response.status}): ${body}`);
    }

    if (!listenerPromise) {
      throw new Error("Discord gateway listener did not provide a background task.");
    }

    this.currentGatewayAbort = controller;
    this.activeGatewayPromise = listenerPromise;
    this.gatewayLogger.info({ durationMs: this.gatewayListenerDurationMs }, "Discord gateway listener started");
  }
}
