import { createMemoryState } from "@chat-adapter/state-memory";
import {
  createTelegramAdapter,
  type TelegramAdapter as ChatSdkTelegramAdapter,
} from "@chat-adapter/telegram";
import {
  Actions,
  Button,
  Card,
  CardText,
  Chat,
  type ActionEvent,
  type ButtonElement,
  type CardElement,
  type Logger as ChatSdkLogger,
  type Message,
  type Thread,
} from "chat";
import type { Logger } from "pino";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import type {
  ChannelAdapter,
  OutboundMessageHandle,
  SelectionPicker,
  SelectionPickerAction,
} from "../../core/channel/ChannelAdapter.js";
import type { MessageEnvelope } from "../../core/channel/MessageEnvelope.js";
import type { ToolPermissionDecision, ToolPermissionRequest } from "../../core/channel/PermissionRequest.js";
import {
  commandDefinitions,
  type ChatCommandDefinition,
} from "../../core/router/CommandRouter.js";
import {
  isTelegramSafeCommandName,
  toTelegramCommandAlias,
} from "../../core/router/AgentCommandNamespace.js";

let globalProxyConfigured = false;
const PERMISSION_ACTION_ID = "hermes_permission";
const SELECTION_ACTION_ID = "hermes_selection";

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

interface PendingPermissionApproval {
  chatId: string;
  toolTitle: string;
  toolText: string;
  message: OutboundMessageHandle;
  tokens: string[];
  optionLabels: Map<string, string>;
  resolve: (decision: ToolPermissionDecision) => void;
  settled: boolean;
  abortListener?: () => void;
  signal?: AbortSignal;
}

interface PermissionTokenInfo {
  approvalId: string;
  optionId: string;
}

function styleForPermissionOption(kind: string): "primary" | "danger" | "default" {
  if (kind.startsWith("allow")) {
    return "primary";
  }
  if (kind.startsWith("reject")) {
    return "danger";
  }
  return "default";
}

function renderPermissionCard(toolText: string, actions: ButtonElement[]): CardElement {
  return Card({
    children: [
      CardText(toolText),
      CardText("Approval required before execution."),
      Actions(actions),
    ],
  });
}

function encodeSelectionValue(action: SelectionPickerAction, optionId: string): string {
  return JSON.stringify([action, optionId]);
}

function decodeSelectionValue(value: string): { action: SelectionPickerAction; optionId: string } | null {
  try {
    const parsed = JSON.parse(value) as [unknown, unknown];
    const [action, optionId] = parsed;
    if (
      (action === "workspace" || action === "agent" || action === "mode" || action === "model")
      && typeof optionId === "string"
    ) {
      return { action, optionId };
    }
  } catch {
    return null;
  }
  return null;
}

function renderSelectionPickerCard(picker: SelectionPicker): CardElement {
  const lines = [
    picker.title,
    ...picker.options.map((option) => {
      const suffix = option.description ? ` - ${option.description}` : "";
      const selectedLabel = option.selected ? " (current)" : "";
      return `${option.label}${selectedLabel}${suffix}`;
    }),
  ];
  const actions = picker.options.map((option) => Button({
    id: SELECTION_ACTION_ID,
    value: encodeSelectionValue(picker.action, option.id),
    label: option.label,
    style: option.selected ? "primary" : "default",
  }));

  return Card({
    children: [
      CardText(lines.join("\n")),
      Actions(actions),
    ],
  });
}

function isTelegramMessageNotModifiedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("message is not modified");
}

export class TelegramAdapter implements ChannelAdapter {
  readonly platform = "telegram" as const;

  private readonly token: string;
  private readonly telegram: ChatSdkTelegramAdapter;
  private readonly bot: Chat;
  private readonly pendingApprovals = new Map<string, PendingPermissionApproval>();
  private readonly approvalTokens = new Map<string, PermissionTokenInfo>();
  private nextApprovalSequence = 1;
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

    this.bot.onAction(PERMISSION_ACTION_ID, async (event) => {
      await this.handlePermissionAction(event);
    });
    this.bot.onAction(SELECTION_ACTION_ID, async (event) => {
      await this.handleSelectionAction(event);
    });
  }

  onMessage(handler: (msg: MessageEnvelope) => Promise<void>): void {
    this.onMessageHandler = handler;
  }

  async sendMessage(chatId: string, text: string): Promise<OutboundMessageHandle> {
    try {
      const result = await this.telegram.postMessage(this.toThreadId(chatId), text);
      this.logger.info({ chatId, textPreview: text.slice(0, 80) }, "Telegram message sent via Chat SDK");
      return {
        chatId,
        messageId: result.id,
        threadId: result.threadId || this.toThreadId(chatId),
      };
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: err, chatId }, "Telegram sendMessage failed");
      throw error;
    }
  }

  async editMessage(message: OutboundMessageHandle, text: string): Promise<OutboundMessageHandle> {
    const threadId = message.threadId || this.toThreadId(message.chatId);

    try {
      const result = await this.telegram.editMessage(threadId, message.messageId, text);
      this.logger.info(
        { chatId: message.chatId, messageId: message.messageId, textPreview: text.slice(0, 80) },
        "Telegram message edited via Chat SDK",
      );
      return {
        chatId: message.chatId,
        messageId: result.id,
        threadId: result.threadId || threadId,
      };
    } catch (error) {
      if (isTelegramMessageNotModifiedError(error)) {
        this.logger.debug(
          { chatId: message.chatId, messageId: message.messageId },
          "Skipping Telegram edit because the rendered content did not change",
        );
        return message;
      }
      const err = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: err, chatId: message.chatId, messageId: message.messageId }, "Telegram editMessage failed");
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

  async syncCommands(chatId: string, commands: readonly ChatCommandDefinition[]): Promise<void> {
    await registerTelegramCommands(this.token, this.logger, commands, {
      type: "chat",
      chat_id: chatId,
    });
  }

  async showSelectionPicker(chatId: string, picker: SelectionPicker): Promise<void> {
    await this.telegram.postMessage(this.toThreadId(chatId), renderSelectionPickerCard(picker));
  }

  async requestPermission(
    chatId: string,
    request: ToolPermissionRequest,
    signal?: AbortSignal,
  ): Promise<ToolPermissionDecision> {
    if (signal?.aborted) {
      return { outcome: "cancelled" };
    }

    const approvalId = this.allocateApprovalId();
    const tokens: string[] = [];
    const optionLabels = new Map<string, string>();
    const actions: ButtonElement[] = request.options.map((option, index) => {
      const token = this.allocateApprovalToken(approvalId, index);
      tokens.push(token);
      optionLabels.set(option.optionId, option.name);
      this.approvalTokens.set(token, {
        approvalId,
        optionId: option.optionId,
      });

      return Button({
        id: PERMISSION_ACTION_ID,
        value: token,
        label: option.name,
        style: styleForPermissionOption(option.kind),
      });
    });

    const toolTitle = request.title?.trim() || "Untitled tool call";
    const toolText = request.renderedText?.trim() || `[tool] ${toolTitle}${request.status ? ` (${request.status})` : ""}`;
    const message = request.message
      ? await this.updatePermissionMessage(request.message, renderPermissionCard(toolText, actions))
      : await this.postPermissionMessage(chatId, renderPermissionCard(toolText, actions));

    return await new Promise<ToolPermissionDecision>((resolve) => {
      const approval: PendingPermissionApproval = {
        chatId,
        toolTitle,
        toolText,
        message,
        tokens,
        optionLabels,
        resolve,
        settled: false,
        signal,
      };

      if (signal) {
        approval.abortListener = () => {
          void this.settlePendingApproval(approvalId, { outcome: "cancelled" }, "Permission request cancelled.");
        };
        signal.addEventListener("abort", approval.abortListener, { once: true });
      }

      this.pendingApprovals.set(approvalId, approval);

      if (signal?.aborted) {
        void this.settlePendingApproval(approvalId, { outcome: "cancelled" }, "Permission request cancelled.");
      }
    });
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

  private allocateApprovalId(): string {
    const value = this.nextApprovalSequence.toString(36);
    this.nextApprovalSequence += 1;
    return `p${value}`;
  }

  private allocateApprovalToken(approvalId: string, index: number): string {
    return `${approvalId}${index.toString(36)}`;
  }

  private async handlePermissionAction(event: ActionEvent): Promise<void> {
    const token = event.value;
    if (!token) {
      return;
    }

    const tokenInfo = this.approvalTokens.get(token);
    if (!tokenInfo) {
      return;
    }

    const approval = this.pendingApprovals.get(tokenInfo.approvalId);
    if (!approval || approval.settled) {
      return;
    }

    const label = approval.optionLabels.get(tokenInfo.optionId) ?? tokenInfo.optionId;
    await this.settlePendingApproval(
      tokenInfo.approvalId,
      { outcome: "selected", optionId: tokenInfo.optionId },
      `Permission resolved for ${approval.toolTitle}: ${label}`,
    );
  }

  private async handleSelectionAction(event: ActionEvent): Promise<void> {
    if (!event.value || !this.onMessageHandler) {
      return;
    }

    const selection = decodeSelectionValue(event.value);
    if (!selection) {
      return;
    }

    const { chatId } = this.telegram.decodeThreadId(event.threadId);
    await this.onMessageHandler({
      platform: "telegram",
      chatId,
      userId: event.user.userId,
      messageId: event.messageId,
      text: `/${selection.action} ${selection.optionId}`,
      isCommand: true,
      timestamp: Date.now(),
    });
  }

  private async settlePendingApproval(
    approvalId: string,
    decision: ToolPermissionDecision,
    suffixText: string,
  ): Promise<void> {
    const approval = this.pendingApprovals.get(approvalId);
    if (!approval || approval.settled) {
      return;
    }

    approval.settled = true;
    this.pendingApprovals.delete(approvalId);
    for (const token of approval.tokens) {
      this.approvalTokens.delete(token);
    }
    if (approval.signal && approval.abortListener) {
      approval.signal.removeEventListener("abort", approval.abortListener);
    }

    try {
      await this.editMessage(approval.message, `${approval.toolText}\n${suffixText}`);
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        { chatId: approval.chatId, messageId: approval.message.messageId, error: err },
        "Failed to update permission prompt message",
      );
    }

    approval.resolve(decision);
  }

  private async postPermissionMessage(chatId: string, card: CardElement): Promise<OutboundMessageHandle> {
    const rawMessage = await this.telegram.postMessage(this.toThreadId(chatId), card);
    return {
      chatId,
      messageId: rawMessage.id,
      threadId: rawMessage.threadId || this.toThreadId(chatId),
    };
  }

  private async updatePermissionMessage(
    message: OutboundMessageHandle,
    card: CardElement,
  ): Promise<OutboundMessageHandle> {
    const threadId = message.threadId || this.toThreadId(message.chatId);
    try {
      const result = await this.telegram.editMessage(threadId, message.messageId, card);
      return {
        chatId: message.chatId,
        messageId: result.id,
        threadId: result.threadId || threadId,
      };
    } catch (error) {
      if (isTelegramMessageNotModifiedError(error)) {
        this.logger.debug(
          { chatId: message.chatId, messageId: message.messageId },
          "Skipping Telegram permission-card edit because the rendered content did not change",
        );
        return message;
      }
      throw error;
    }
  }
}

interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
}

interface TelegramChatCommandScope {
  type: "chat";
  chat_id: string;
}

function toTelegramCommandDefinitions(
  commands: readonly ChatCommandDefinition[],
  logger: Logger,
): Array<{ command: string; description: string }> {
  const seen = new Set<string>();
  const normalized: Array<{ command: string; description: string }> = [];

  for (const command of commands) {
    const telegramCommandName = isTelegramSafeCommandName(command.name)
      ? command.name
      : toTelegramCommandAlias(command.name);

    if (!isTelegramSafeCommandName(telegramCommandName)) {
      logger.warn({ command: command.name }, "Skipping Telegram command with unsupported name");
      continue;
    }

    if (seen.has(telegramCommandName)) {
      continue;
    }

    seen.add(telegramCommandName);
    normalized.push({
      command: telegramCommandName,
      description: command.description.slice(0, 256),
    });
  }

  return normalized.slice(0, 100);
}

export async function registerTelegramCommands(
  token: string,
  logger: Logger,
  commands: readonly ChatCommandDefinition[] = commandDefinitions,
  scope?: TelegramChatCommandScope,
): Promise<void> {
  const telegramCommands = toTelegramCommandDefinitions(commands, logger);
  const response = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      commands: telegramCommands,
      ...(scope ? { scope } : {}),
    }),
  });

  const payload = (await response.json()) as TelegramApiResponse;
  if (!response.ok || !payload.ok) {
    throw new Error(payload.description ?? `HTTP ${response.status}`);
  }

  logger.info(
    { chatId: scope?.chat_id, commands: telegramCommands.map(({ command }) => command) },
    "Telegram bot commands registered",
  );
}
