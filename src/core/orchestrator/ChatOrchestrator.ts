import type { Logger } from "pino";
import type { ChannelAdapter } from "../channel/ChannelAdapter.js";
import type { MessageEnvelope } from "../channel/MessageEnvelope.js";
import { CommandRouter, type ParsedCommand } from "../router/CommandRouter.js";
import { InMemoryChatStateStore } from "../state/InMemoryChatStateStore.js";
import type { AccessControlConfig } from "../security/isAuthorized.js";
import { isAuthorizedMessage } from "../security/isAuthorized.js";
import { AgentProcessManager } from "../acp/AgentProcessManager.js";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

const UNAUTHORIZED_TEXT = "Unauthorized. This chat is not allowed to control Hermes.";
const NO_SESSION_TEXT = "No active session. Run /session first.";
const BUSY_TEXT = "A turn is already in progress. Use /cancel to interrupt it.";
const TYPING_REFRESH_MS = 4000;

type RenderEvent =
  | {
      kind: "chunk";
      text: string;
    }
  | {
      kind: "message";
      text: string;
    };

function extractTextBlock(content: unknown): string | undefined {
  if (!content || typeof content !== "object") {
    return undefined;
  }
  const block = content as { type?: unknown; text?: unknown };
  if (block.type === "text" && typeof block.text === "string") {
    return block.text;
  }
  return undefined;
}

function toCompactText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!value) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateForChat(text: string, max = 2000): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n...(truncated)`;
}

async function sendChunkedMessage(channel: ChannelAdapter, chatId: string, text: string): Promise<void> {
  const telegramSafeLimit = 3500;
  let remaining = text;
  while (remaining.length > telegramSafeLimit) {
    await channel.sendMessage(chatId, remaining.slice(0, telegramSafeLimit));
    remaining = remaining.slice(telegramSafeLimit);
  }
  if (remaining.length > 0) {
    await channel.sendMessage(chatId, remaining);
  }
}

function extractToolContentMessages(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const messages: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const typed = item as {
      type?: unknown;
      content?: unknown;
      path?: unknown;
      terminalId?: unknown;
    };

    if (typed.type === "content") {
      const text = extractTextBlock(typed.content);
      if (text) {
        messages.push(text);
      }
      continue;
    }
    if (typed.type === "diff" && typeof typed.path === "string") {
      messages.push(`[diff] ${typed.path}`);
      continue;
    }
    if (typed.type === "terminal" && typeof typed.terminalId === "string") {
      messages.push(`[terminal] ${typed.terminalId}`);
    }
  }

  return messages;
}

function renderEventsFromUpdate(update: SessionUpdate): RenderEvent[] {
  const events: RenderEvent[] = [];
  const loose = update as unknown as {
    sessionUpdate?: string;
    content?: unknown;
    title?: unknown;
    status?: unknown;
    toolCallId?: unknown;
    rawOutput?: unknown;
  };

  if (loose.sessionUpdate === "agent_message_chunk" || loose.sessionUpdate === "assistant_message_chunk") {
    const text = extractTextBlock(loose.content);
    if (text) {
      events.push({ kind: "chunk", text });
    }
    return events;
  }

  if (loose.sessionUpdate === "tool_call") {
    if (typeof loose.title === "string") {
      const suffix = typeof loose.status === "string" ? ` (${loose.status})` : "";
      events.push({ kind: "message", text: `[tool] ${loose.title}${suffix}` });
    }
    for (const message of extractToolContentMessages(loose.content)) {
      events.push({ kind: "message", text: truncateForChat(message) });
    }
    return events;
  }

  if (loose.sessionUpdate === "tool_call_update") {
    if (typeof loose.title === "string" || typeof loose.status === "string") {
      const name = typeof loose.title === "string" ? loose.title : `tool:${String(loose.toolCallId ?? "unknown")}`;
      const suffix = typeof loose.status === "string" ? ` (${loose.status})` : "";
      events.push({ kind: "message", text: `[tool] ${name}${suffix}` });
    }
    for (const message of extractToolContentMessages(loose.content)) {
      events.push({ kind: "message", text: truncateForChat(message) });
    }
    const raw = toCompactText(loose.rawOutput);
    if (raw && raw.length > 0) {
      events.push({ kind: "message", text: truncateForChat(raw, 1200) });
    }
    return events;
  }

  return events;
}

export interface ChatOrchestratorOptions {
  channel: ChannelAdapter;
  stateStore: InMemoryChatStateStore;
  router: CommandRouter;
  agentManager: AgentProcessManager;
  accessControl: AccessControlConfig;
  logger: Logger;
}

export class ChatOrchestrator {
  private readonly channel: ChannelAdapter;
  private readonly stateStore: InMemoryChatStateStore;
  private readonly router: CommandRouter;
  private readonly agentManager: AgentProcessManager;
  private readonly accessControl: AccessControlConfig;
  private readonly logger: Logger;
  private readonly typingLastSentAtByChat = new Map<string, number>();

  constructor(options: ChatOrchestratorOptions) {
    this.channel = options.channel;
    this.stateStore = options.stateStore;
    this.router = options.router;
    this.agentManager = options.agentManager;
    this.accessControl = options.accessControl;
    this.logger = options.logger;
  }

  async start(): Promise<void> {
    this.channel.onMessage(async (message) => {
      await this.handleMessage(message);
    });
    await this.channel.start();
  }

  async stop(): Promise<void> {
    await this.channel.stop();
  }

  async handleMessage(message: MessageEnvelope): Promise<void> {
    this.logger.info(
      { platform: message.platform, chatId: message.chatId, userId: message.userId, text: message.text },
      "Inbound message",
    );
    if (!isAuthorizedMessage(message, this.accessControl)) {
      this.logger.warn({ chatId: message.chatId, userId: message.userId }, "Message rejected by whitelist");
      await this.channel.sendMessage(message.chatId, UNAUTHORIZED_TEXT);
      return;
    }

    const chatKey = `${message.platform}:${message.chatId}`;
    const state = this.stateStore.getOrCreate(chatKey, this.agentManager.getDefaultAgentId());
    const parsedCommand = this.router.parse(message.text);

    if (parsedCommand) {
      await this.handleCommand(chatKey, message, parsedCommand);
      return;
    }

    await this.handlePrompt(chatKey, message, state.activeAgentId, state.sessionId, state.activeTurnId);
  }

  private async handleCommand(chatKey: string, message: MessageEnvelope, command: ParsedCommand): Promise<void> {
    const state = this.stateStore.getOrCreate(chatKey, this.agentManager.getDefaultAgentId());

    switch (command.name) {
      case "agents": {
        const rows = this.agentManager.listAgents().map((agent) => {
          const marker = agent.id === state.activeAgentId ? "*" : " ";
          return `${marker} ${agent.id} - ${agent.status}`;
        });
        await this.channel.sendMessage(message.chatId, `Available agents:\n${rows.join("\n")}`);
        return;
      }
      case "agent": {
        const agentId = command.args[0];
        if (!agentId) {
          await this.channel.sendMessage(message.chatId, "Usage: /agent <id>");
          return;
        }
        if (!this.agentManager.hasAgent(agentId)) {
          await this.channel.sendMessage(message.chatId, `Unknown agent '${agentId}'. Run /agents to list.`);
          return;
        }
        if (state.activeTurnId) {
          await this.channel.sendMessage(message.chatId, BUSY_TEXT);
          return;
        }

        this.stateStore.setActiveAgent(chatKey, agentId);
        await this.channel.sendMessage(message.chatId, `Active agent switched to '${agentId}'. Session reset; run /session.`);
        return;
      }
      case "session": {
        if (state.activeTurnId) {
          await this.channel.sendMessage(message.chatId, BUSY_TEXT);
          return;
        }

        const client = await this.agentManager.getClient(state.activeAgentId);
        const sessionId = await client.newSession(this.agentManager.getAgentCwd(state.activeAgentId));
        this.stateStore.setSession(chatKey, sessionId);
        await this.channel.sendMessage(
          message.chatId,
          `Session created.\nAgent: ${state.activeAgentId}\nSession ID: ${sessionId}`,
        );
        return;
      }
      case "status": {
        await this.channel.sendMessage(
          message.chatId,
          [`Agent: ${state.activeAgentId}`, `Session: ${state.sessionId ?? "(none)"}`, `Turn: ${state.activeTurnId ?? "idle"}`].join(
            "\n",
          ),
        );
        return;
      }
      case "cancel": {
        if (!state.sessionId || !state.activeTurnId) {
          await this.channel.sendMessage(message.chatId, "No active turn to cancel.");
          return;
        }

        const client = await this.agentManager.getClient(state.activeAgentId);
        await client.cancel(state.sessionId);
        await this.channel.sendMessage(message.chatId, "Cancellation requested for current turn.");
        return;
      }
      default:
        return;
    }
  }

  private async handlePrompt(
    chatKey: string,
    message: MessageEnvelope,
    activeAgentId: string,
    sessionId?: string,
    activeTurnId?: string,
  ): Promise<void> {
    if (!sessionId) {
      await this.channel.sendMessage(message.chatId, NO_SESSION_TEXT);
      return;
    }

    if (activeTurnId) {
      await this.channel.sendMessage(message.chatId, BUSY_TEXT);
      return;
    }

    const turnId = `${Date.now()}-${message.messageId}`;
    this.stateStore.setActiveTurn(chatKey, turnId);

    const client = await this.agentManager.getClient(activeAgentId);
    let emittedContent = false;
    let chunkBuffer = "";

    const flushChunkBuffer = async (): Promise<void> => {
      if (!chunkBuffer) {
        return;
      }
      emittedContent = true;
      const payload = chunkBuffer;
      chunkBuffer = "";
      await sendChunkedMessage(this.channel, message.chatId, payload);
    };

    const unsubscribe = client.onSessionUpdate(sessionId, async (update) => {
      await this.setTypingIfSupported(message.chatId);
      const events = renderEventsFromUpdate(update);
      for (const event of events) {
        if (event.kind === "chunk") {
          chunkBuffer += event.text;
          continue;
        }
        emittedContent = true;
        await flushChunkBuffer();
        await this.channel.sendMessage(message.chatId, event.text);
      }
    });

    try {
      await this.setTypingIfSupported(message.chatId);
      await client.prompt(sessionId, message.text);
      await flushChunkBuffer();
      if (!emittedContent) {
        await this.channel.sendMessage(
          message.chatId,
          "No textual updates were emitted by the agent during this turn.",
        );
      }
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: err, chatKey, sessionId, agentId: activeAgentId }, "Prompt execution failed");
      await this.channel.sendMessage(message.chatId, `Prompt failed: ${err}`);
    } finally {
      unsubscribe();

      const latest = this.stateStore.get(chatKey);
      if (latest?.activeTurnId === turnId) {
        this.stateStore.setActiveTurn(chatKey, undefined);
      }
      this.typingLastSentAtByChat.delete(message.chatId);
    }
  }

  private async setTypingIfSupported(chatId: string): Promise<void> {
    if (!this.channel.setTyping) {
      return;
    }

    const now = Date.now();
    const lastSentAt = this.typingLastSentAtByChat.get(chatId) ?? 0;
    if (now - lastSentAt < TYPING_REFRESH_MS) {
      return;
    }

    this.typingLastSentAtByChat.set(chatId, now);
    try {
      await this.channel.setTyping(chatId);
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      this.logger.debug({ chatId, error: err }, "Failed to send typing signal");
    }
  }
}
