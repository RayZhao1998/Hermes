import type { Logger } from "pino";
import type { AvailableCommand, SessionUpdate } from "@agentclientprotocol/sdk";
import type { ChannelAdapter } from "../channel/ChannelAdapter.js";
import type { MessageEnvelope } from "../channel/MessageEnvelope.js";
import {
  CommandRouter,
  mergeCommandDefinitions,
  type ParsedCommand,
} from "../router/CommandRouter.js";
import { InMemoryChatStateStore } from "../state/InMemoryChatStateStore.js";
import type { AccessControlConfig } from "../security/isAuthorized.js";
import { isAuthorizedMessage } from "../security/isAuthorized.js";
import { AgentProcessManager } from "../acp/AgentProcessManager.js";
import { extractAvailableCommands } from "../acp/ACPClient.js";

const UNAUTHORIZED_TEXT = "Unauthorized. This chat is not allowed to control Hermes.";
const NO_SESSION_TEXT = "No active session. Run /new first.";
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

interface ActiveTurnState {
  turnId: string;
  emittedContent: boolean;
  chunkBuffer: string;
}

interface SessionBinding {
  chatId: string;
  agentId: string;
  sessionId: string;
  unsubscribe: () => void;
  activeTurn?: ActiveTurnState;
}

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
  private readonly sessionBindings = new Map<string, SessionBinding>();

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
    for (const binding of this.sessionBindings.values()) {
      binding.unsubscribe();
    }
    this.sessionBindings.clear();
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
    const isNewChat = !this.stateStore.get(chatKey);
    const state = this.stateStore.getOrCreate(chatKey, this.agentManager.getDefaultAgentId());
    if (isNewChat) {
      await this.syncCommands(chatKey, message.chatId);
    }
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
          return `${marker} ${agent.id}`;
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

        this.releaseSessionBinding(chatKey);
        this.stateStore.setActiveAgent(chatKey, agentId);
        await this.syncCommands(chatKey, message.chatId);
        await this.channel.sendMessage(message.chatId, `Active agent switched to '${agentId}'. Session reset; run /new.`);
        return;
      }
      case "new": {
        if (state.activeTurnId) {
          await this.channel.sendMessage(message.chatId, BUSY_TEXT);
          return;
        }

        const client = await this.agentManager.getClient(state.activeAgentId);
        const sessionId = await client.newSession(this.agentManager.getAgentCwd(state.activeAgentId));
        this.stateStore.setSession(chatKey, sessionId);
        await this.bindSession(chatKey, message.chatId, state.activeAgentId, sessionId);
        await this.syncCommands(chatKey, message.chatId);
        await this.channel.sendMessage(
          message.chatId,
          `Session created.\nAgent: ${state.activeAgentId}\nSession ID: ${sessionId}`,
        );
        return;
      }
      case "status": {
        await this.channel.sendMessage(
          message.chatId,
          [
            `Agent: ${state.activeAgentId}`,
            `Session: ${state.sessionId ?? "(none)"}`,
            `Turn: ${state.activeTurnId ?? "idle"}`,
            `Commands: ${state.availableCommands.length === 0 ? "(none)" : state.availableCommands.map(({ name }) => `/${name}`).join(", ")}`,
          ].join("\n"),
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
    const sessionBinding = await this.bindSession(chatKey, message.chatId, activeAgentId, sessionId);
    sessionBinding.activeTurn = {
      turnId,
      emittedContent: false,
      chunkBuffer: "",
    };

    const client = await this.agentManager.getClient(activeAgentId);

    try {
      await this.setTypingIfSupported(message.chatId);
      await client.prompt(sessionId, message.text);
      await this.flushChunkBuffer(sessionBinding);
      if (!sessionBinding.activeTurn?.emittedContent) {
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
      if (sessionBinding.activeTurn?.turnId === turnId) {
        sessionBinding.activeTurn = undefined;
      }
      const latest = this.stateStore.get(chatKey);
      if (latest?.activeTurnId === turnId) {
        this.stateStore.setActiveTurn(chatKey, undefined);
      }
      this.typingLastSentAtByChat.delete(message.chatId);
    }
  }

  private async bindSession(
    chatKey: string,
    chatId: string,
    agentId: string,
    sessionId: string,
  ): Promise<SessionBinding> {
    const existing = this.sessionBindings.get(chatKey);
    if (existing && existing.sessionId === sessionId && existing.agentId === agentId) {
      return existing;
    }

    this.releaseSessionBinding(chatKey);

    const client = await this.agentManager.getClient(agentId);
    const binding: SessionBinding = {
      chatId,
      agentId,
      sessionId,
      unsubscribe: () => undefined,
    };

    binding.unsubscribe = client.onSessionUpdate(sessionId, async (update) => {
      await this.handleSessionUpdate(chatKey, binding, update);
    });

    this.sessionBindings.set(chatKey, binding);
    this.stateStore.setAvailableCommands(chatKey, client.getAvailableCommands(sessionId));
    return binding;
  }

  private releaseSessionBinding(chatKey: string): void {
    const existing = this.sessionBindings.get(chatKey);
    if (!existing) {
      return;
    }
    existing.unsubscribe();
    this.sessionBindings.delete(chatKey);
  }

  private async handleSessionUpdate(chatKey: string, binding: SessionBinding, update: SessionUpdate): Promise<void> {
    const availableCommands = extractAvailableCommands(update);
    if (availableCommands) {
      this.stateStore.setAvailableCommands(chatKey, availableCommands);
      await this.syncCommands(chatKey, binding.chatId);
    }

    if (!binding.activeTurn) {
      return;
    }

    await this.setTypingIfSupported(binding.chatId);
    const events = renderEventsFromUpdate(update);
    for (const event of events) {
      if (event.kind === "chunk") {
        binding.activeTurn.chunkBuffer += event.text;
        continue;
      }
      binding.activeTurn.emittedContent = true;
      await this.flushChunkBuffer(binding);
      await this.channel.sendMessage(binding.chatId, event.text);
    }
  }

  private async flushChunkBuffer(binding: SessionBinding): Promise<void> {
    if (!binding.activeTurn?.chunkBuffer) {
      return;
    }

    binding.activeTurn.emittedContent = true;
    const payload = binding.activeTurn.chunkBuffer;
    binding.activeTurn.chunkBuffer = "";
    await sendChunkedMessage(this.channel, binding.chatId, payload);
  }

  private async syncCommands(chatKey: string, chatId: string): Promise<void> {
    if (!this.channel.syncCommands) {
      return;
    }

    const state = this.stateStore.get(chatKey);
    if (!state) {
      return;
    }

    await this.channel.syncCommands(
      chatId,
      mergeCommandDefinitions(
        state.availableCommands.map((command) => this.toChatCommandDefinition(command)),
      ),
    );
  }

  private toChatCommandDefinition(command: AvailableCommand): { name: string; description: string } {
    return {
      name: command.name,
      description: command.description,
    };
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
