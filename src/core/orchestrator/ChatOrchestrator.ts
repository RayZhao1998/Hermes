import type { Logger } from "pino";
import type { AvailableCommand, McpServer, RequestPermissionResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import type { ChannelAdapter, OutboundMessageHandle } from "../channel/ChannelAdapter.js";
import type { MessageEnvelope } from "../channel/MessageEnvelope.js";
import type { LoadedWorkspaceConfig, OutputMode, ToolApprovalMode } from "../../config/schema.js";
import type { ScheduledTaskConfig } from "../../config/tasks-schema.js";
import {
  CommandRouter,
  mergeCommandDefinitions,
  type ParsedCommand,
} from "../router/CommandRouter.js";
import {
  rewriteAgentCommandPrompt,
  toAgentChatCommandDefinition,
} from "../router/AgentCommandNamespace.js";
import { InMemoryChatStateStore } from "../state/InMemoryChatStateStore.js";
import type { AccessControlConfig } from "../security/isAuthorized.js";
import { isAuthorizedMessage } from "../security/isAuthorized.js";
import { AgentProcessManager } from "../acp/AgentProcessManager.js";
import type { SessionModelSelection } from "../acp/ACPClient.js";
import { extractAvailableCommands } from "../acp/ACPClient.js";

const UNAUTHORIZED_TEXT = "Unauthorized. This chat is not allowed to control Hermes.";
const NO_SESSION_TEXT = "No active session. Run /new first.";
const BUSY_TEXT = "A turn is already in progress. Use /cancel to interrupt it.";
const TYPING_REFRESH_MS = 4000;
const PROMPT_TURN_SETTLE_MS = 50;

type RenderEvent =
  | {
      kind: "chunk";
      text: string;
    }
  | {
      kind: "message";
      text: string;
    }
  | {
      kind: "tool_call";
      toolCallId: string;
      title?: string;
      status?: string;
      titleProvided: boolean;
      statusProvided: boolean;
      contentProvided: boolean;
      contentMessages: string[];
      rawOutputProvided: boolean;
      rawOutput?: string;
    };

interface ToolCallRenderState {
  toolCallId: string;
  title?: string;
  status?: string;
  contentMessages: string[];
  rawOutput?: string;
  rendered?: string;
  message?: OutboundMessageHandle;
}

interface ActiveTurnState {
  turnId: string;
  fullText: string;
  hasVisibleOutput: boolean;
  chunkBuffer: string;
  toolCalls: Map<string, ToolCallRenderState>;
}

interface SessionBinding {
  chatId: string;
  agentId: string;
  sessionId: string;
  unsubscribe: () => void;
  pendingSessionUpdates: Promise<void>;
  stateKey?: string;
  syncCommands: boolean;
  activeTurn?: ActiveTurnState;
}

interface BindSessionOptions {
  stateKey?: string;
  syncCommands?: boolean;
  enablePermissionRequests?: boolean;
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
    events.push({
      kind: "tool_call",
      toolCallId: typeof loose.toolCallId === "string" ? loose.toolCallId : "unknown",
      title: typeof loose.title === "string" ? loose.title : undefined,
      status: typeof loose.status === "string" ? loose.status : undefined,
      titleProvided: "title" in loose,
      statusProvided: "status" in loose,
      contentProvided: "content" in loose,
      contentMessages: extractToolContentMessages(loose.content).map((message) => truncateForChat(message)),
      rawOutputProvided: "rawOutput" in loose,
      rawOutput: undefined,
    });
    return events;
  }

  if (loose.sessionUpdate === "tool_call_update") {
    const raw = toCompactText(loose.rawOutput);
    events.push({
      kind: "tool_call",
      toolCallId: typeof loose.toolCallId === "string" ? loose.toolCallId : "unknown",
      title: typeof loose.title === "string" ? loose.title : undefined,
      status: typeof loose.status === "string" ? loose.status : undefined,
      titleProvided: "title" in loose,
      statusProvided: "status" in loose,
      contentProvided: "content" in loose,
      contentMessages: extractToolContentMessages(loose.content).map((message) => truncateForChat(message)),
      rawOutputProvided: "rawOutput" in loose,
      rawOutput: raw && raw.length > 0 ? truncateForChat(raw, 1200) : undefined,
    });
    return events;
  }

  return events;
}

function renderToolCallText(toolCall: ToolCallRenderState): string {
  if (!toolCall.title) {
    return "";
  }

  const header = `[tool] ${toolCall.title}${toolCall.status ? ` (${toolCall.status})` : ""}`;
  const sections = [header];

  if (toolCall.contentMessages.length > 0) {
    sections.push(toolCall.contentMessages.join("\n"));
  }

  if (toolCall.rawOutput) {
    sections.push(toolCall.rawOutput);
  }

  return sections.join("\n");
}

function getMcpServerType(server: McpServer): "http" | "sse" | "stdio" {
  return "type" in server ? server.type : "stdio";
}

function formatMcpServers(servers: McpServer[]): string {
  if (servers.length === 0) {
    return "(none)";
  }
  return servers.map((server) => `${server.name} (${getMcpServerType(server)})`).join(", ");
}

function formatModelSelection(selection: SessionModelSelection): string {
  if (selection.models.length === 0) {
    return "Selectable models:\n(none)";
  }

  const rows = selection.models.map((model) => {
    const marker = model.id === selection.currentModelId ? "*" : " ";
    const suffix = model.description ? ` - ${model.description}` : "";
    return `${marker} ${model.id} (${model.name})${suffix}`;
  });

  return [`Current model: ${selection.currentModelId}`, "Selectable models:", ...rows].join("\n");
}

function formatWorkspaceList(workspaces: readonly LoadedWorkspaceConfig[], activeWorkspaceId: string): string {
  return workspaces.map((workspace) => {
    const marker = workspace.id === activeWorkspaceId ? "*" : " ";
    return `${marker} ${workspace.id} - ${workspace.path}`;
  }).join("\n");
}

export interface ChatOrchestratorOptions {
  channel: ChannelAdapter;
  stateStore: InMemoryChatStateStore;
  router: CommandRouter;
  agentManager: AgentProcessManager;
  workspaces: LoadedWorkspaceConfig[];
  defaultWorkspaceId: string;
  accessControl: AccessControlConfig;
  outputMode: OutputMode;
  toolApprovalMode: ToolApprovalMode;
  logger: Logger;
}

export class ChatOrchestrator {
  private readonly channel: ChannelAdapter;
  private readonly stateStore: InMemoryChatStateStore;
  private readonly router: CommandRouter;
  private readonly agentManager: AgentProcessManager;
  private readonly workspacesById: Map<string, LoadedWorkspaceConfig>;
  private readonly orderedWorkspaces: LoadedWorkspaceConfig[];
  private readonly defaultWorkspaceId: string;
  private readonly accessControl: AccessControlConfig;
  private readonly outputMode: OutputMode;
  private readonly toolApprovalMode: ToolApprovalMode;
  private readonly logger: Logger;
  private readonly typingLastSentAtByChat = new Map<string, number>();
  private readonly sessionBindings = new Map<string, SessionBinding>();

  constructor(options: ChatOrchestratorOptions) {
    this.channel = options.channel;
    this.stateStore = options.stateStore;
    this.router = options.router;
    this.agentManager = options.agentManager;
    this.orderedWorkspaces = options.workspaces;
    this.workspacesById = new Map(options.workspaces.map((workspace) => [workspace.id, workspace]));
    this.defaultWorkspaceId = options.defaultWorkspaceId;
    this.accessControl = options.accessControl;
    this.outputMode = options.outputMode;
    this.toolApprovalMode = options.toolApprovalMode;
    this.logger = options.logger;

    if (!this.workspacesById.has(this.defaultWorkspaceId)) {
      throw new Error(`Unknown default workspace '${this.defaultWorkspaceId}'.`);
    }
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

  async runScheduledTask(task: ScheduledTaskConfig): Promise<void> {
    if (this.toolApprovalMode !== "auto") {
      throw new Error(
        `Scheduled task '${task.id}' requires tools.approvalMode=auto for bot '${task.botId}'.`,
      );
    }

    const agentId = task.agentId ?? this.agentManager.getDefaultAgentId();
    const workspaceId = task.workspaceId ?? this.defaultWorkspaceId;
    const workspace = this.requireWorkspace(workspaceId);
    const client = await this.agentManager.getClient(agentId);
    const sessionId = await client.newSession(
      workspace.path,
      this.agentManager.getAgentMcpServers(agentId),
    );

    const bindingKey = `scheduled:${task.id}:${Date.now()}`;
    const turnId = `${bindingKey}:turn`;
    const binding = await this.bindSession(bindingKey, task.chatId, agentId, sessionId, {
      syncCommands: false,
      enablePermissionRequests: false,
    });

    binding.activeTurn = {
      turnId,
      fullText: "",
      hasVisibleOutput: false,
      chunkBuffer: "",
      toolCalls: new Map(),
    };

    try {
      await this.setTypingIfSupported(task.chatId);
      await client.prompt(sessionId, task.prompt);
      await this.waitForPendingSessionUpdates(binding);
      await this.finalizeTurn(task.chatId, binding);
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { error: err, taskId: task.id, sessionId, agentId, botId: task.botId },
        "Scheduled task execution failed",
      );
      await this.channel.sendMessage(task.chatId, `Scheduled task '${task.id}' failed: ${err}`);
      throw error;
    } finally {
      if (binding.activeTurn?.turnId === turnId) {
        binding.activeTurn = undefined;
      }
      this.typingLastSentAtByChat.delete(task.chatId);
      this.releaseSessionBinding(bindingKey);
    }
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
    const state = this.stateStore.getOrCreate(
      chatKey,
      this.agentManager.getDefaultAgentId(),
      this.defaultWorkspaceId,
    );
    if (isNewChat) {
      await this.syncCommands(chatKey, message.chatId);
    }
    const parsedCommand = this.router.parse(message.text);

    if (parsedCommand) {
      await this.handleCommand(chatKey, message, parsedCommand);
      return;
    }

    const promptText = rewriteAgentCommandPrompt(message.text, state.activeAgentId, state.availableCommands) ?? message.text;
    await this.handlePrompt(
      chatKey,
      {
        ...message,
        text: promptText,
      },
      state.activeAgentId,
      state.sessionId,
      state.activeTurnId,
    );
  }

  private async handleCommand(chatKey: string, message: MessageEnvelope, command: ParsedCommand): Promise<void> {
    const state = this.stateStore.getOrCreate(
      chatKey,
      this.agentManager.getDefaultAgentId(),
      this.defaultWorkspaceId,
    );

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
      case "workspace": {
        const workspaceId = command.args[0];
        if (!workspaceId) {
          if (this.channel.showWorkspacePicker) {
            await this.channel.showWorkspacePicker(
              message.chatId,
              this.orderedWorkspaces.map((workspace) => ({
                id: workspace.id,
                path: workspace.path,
                selected: workspace.id === state.activeWorkspaceId,
              })),
            );
            return;
          }

          await this.channel.sendMessage(
            message.chatId,
            [
              `Current workspace: ${state.activeWorkspaceId}`,
              "Available workspaces:",
              formatWorkspaceList(this.orderedWorkspaces, state.activeWorkspaceId),
            ].join("\n"),
          );
          return;
        }

        const workspace = this.workspacesById.get(workspaceId);
        if (!workspace) {
          await this.channel.sendMessage(
            message.chatId,
            [
              `Unknown workspace '${workspaceId}'.`,
              "Available workspaces:",
              formatWorkspaceList(this.orderedWorkspaces, state.activeWorkspaceId),
            ].join("\n"),
          );
          return;
        }
        if (state.activeTurnId) {
          await this.channel.sendMessage(message.chatId, BUSY_TEXT);
          return;
        }
        if (workspace.id === state.activeWorkspaceId) {
          await this.channel.sendMessage(
            message.chatId,
            `Workspace '${workspace.id}' is already active.\nPath: ${workspace.path}`,
          );
          return;
        }

        this.releaseSessionBinding(chatKey);
        this.stateStore.setActiveWorkspace(chatKey, workspace.id);
        await this.syncCommands(chatKey, message.chatId);
        await this.channel.sendMessage(
          message.chatId,
          `Workspace switched to '${workspace.id}'.\nPath: ${workspace.path}\nSession reset; run /new.`,
        );
        return;
      }
      case "new": {
        if (state.activeTurnId) {
          await this.channel.sendMessage(message.chatId, BUSY_TEXT);
          return;
        }

        const workspace = this.requireWorkspace(state.activeWorkspaceId);
        const client = await this.agentManager.getClient(state.activeAgentId);
        const sessionId = await client.newSession(
          workspace.path,
          this.agentManager.getAgentMcpServers(state.activeAgentId),
        );
        this.stateStore.setSession(chatKey, sessionId);
        await this.bindSession(chatKey, message.chatId, state.activeAgentId, sessionId, {
          stateKey: chatKey,
          syncCommands: true,
          enablePermissionRequests: this.toolApprovalMode === "manual",
        });
        await this.syncCommands(chatKey, message.chatId);
        await this.channel.sendMessage(
          message.chatId,
          `Session created.\nAgent: ${state.activeAgentId}\nWorkspace: ${workspace.id}\nSession ID: ${sessionId}`,
        );
        return;
      }
      case "models": {
        if (!state.sessionId) {
          await this.channel.sendMessage(message.chatId, NO_SESSION_TEXT);
          return;
        }

        const client = await this.agentManager.getClient(state.activeAgentId);
        const selection = client.getModelSelection(state.sessionId);
        if (!selection) {
          await this.channel.sendMessage(
            message.chatId,
            "Active agent does not expose selectable models for this session.",
          );
          return;
        }

        await this.channel.sendMessage(message.chatId, formatModelSelection(selection));
        return;
      }
      case "model": {
        if (!state.sessionId) {
          await this.channel.sendMessage(message.chatId, NO_SESSION_TEXT);
          return;
        }
        if (state.activeTurnId) {
          await this.channel.sendMessage(message.chatId, BUSY_TEXT);
          return;
        }

        const modelId = command.args[0];
        if (!modelId) {
          await this.channel.sendMessage(message.chatId, "Usage: /model <id>");
          return;
        }

        const client = await this.agentManager.getClient(state.activeAgentId);
        const selection = client.getModelSelection(state.sessionId);
        if (!selection) {
          await this.channel.sendMessage(
            message.chatId,
            "Active agent does not expose selectable models for this session.",
          );
          return;
        }

        if (!selection.models.some((model) => model.id === modelId)) {
          await this.channel.sendMessage(
            message.chatId,
            `Unknown model '${modelId}'. Run /models to list available options.`,
          );
          return;
        }

        const updated = await client.setModel(state.sessionId, modelId);
        await this.channel.sendMessage(
          message.chatId,
          `Model switched to '${updated.currentModelId}'.`,
        );
        return;
      }
      case "status": {
        const workspace = this.requireWorkspace(state.activeWorkspaceId);
        const mcpServers = this.agentManager.getAgentMcpServers(state.activeAgentId);
        const client = await this.agentManager.getClient(state.activeAgentId);
        const modelSelection = state.sessionId ? client.getModelSelection(state.sessionId) : null;
        await this.channel.sendMessage(
          message.chatId,
          [
            `Agent: ${state.activeAgentId}`,
            `Workspace: ${workspace.id} (${workspace.path})`,
            `Session: ${state.sessionId ?? "(none)"}`,
            `Model: ${modelSelection?.currentModelId ?? "(not available)"}`,
            `Turn: ${state.activeTurnId ?? "idle"}`,
            `MCP servers: ${formatMcpServers(mcpServers)}`,
            `Commands: ${state.availableCommands.length === 0
              ? "(none)"
              : state.availableCommands
                  .map((command) => `/${toAgentChatCommandDefinition(state.activeAgentId, command).name}`)
                  .join(", ")}`,
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
    const sessionBinding = await this.bindSession(chatKey, message.chatId, activeAgentId, sessionId, {
      stateKey: chatKey,
      syncCommands: true,
      enablePermissionRequests: this.toolApprovalMode === "manual",
    });
    sessionBinding.activeTurn = {
      turnId,
      fullText: "",
      hasVisibleOutput: false,
      chunkBuffer: "",
      toolCalls: new Map(),
    };

    const client = await this.agentManager.getClient(activeAgentId);

    try {
      await this.setTypingIfSupported(message.chatId);
      await client.prompt(sessionId, message.text);
      await this.waitForPendingSessionUpdates(sessionBinding);
      await this.finalizeTurn(message.chatId, sessionBinding);
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
    bindingKey: string,
    chatId: string,
    agentId: string,
    sessionId: string,
    options: BindSessionOptions = {},
  ): Promise<SessionBinding> {
    const existing = this.sessionBindings.get(bindingKey);
    if (existing && existing.sessionId === sessionId && existing.agentId === agentId) {
      return existing;
    }

    this.releaseSessionBinding(bindingKey);

    const client = await this.agentManager.getClient(agentId);
    const binding: SessionBinding = {
      chatId,
      agentId,
      sessionId,
      unsubscribe: () => undefined,
      pendingSessionUpdates: Promise.resolve(),
      stateKey: options.stateKey,
      syncCommands: options.syncCommands ?? false,
    };

    const unsubscribePermission = options.enablePermissionRequests
      ? client.onRequestPermission(sessionId, async (params, signal): Promise<RequestPermissionResponse> => {
          if (!this.channel.requestPermission) {
            this.logger.warn(
              { chatId, sessionId, toolCallId: params.toolCall.toolCallId },
              "Channel does not support interactive permission approval; cancelling tool call",
            );
            return {
              outcome: {
                outcome: "cancelled",
              },
            };
          }

          const existingToolCall = binding.activeTurn?.toolCalls.get(params.toolCall.toolCallId);
          const fallbackToolCall: ToolCallRenderState = {
            toolCallId: params.toolCall.toolCallId,
            title: params.toolCall.title ?? undefined,
            status: params.toolCall.status ?? undefined,
            contentMessages: [],
            rawOutput: undefined,
            message: undefined,
          };
          const toolCallForRender = existingToolCall ?? fallbackToolCall;

          const decision = await this.channel.requestPermission(
            chatId,
            {
              sessionId: params.sessionId,
              toolCallId: params.toolCall.toolCallId,
              title: params.toolCall.title ?? undefined,
              status: params.toolCall.status ?? undefined,
              renderedText: renderToolCallText(toolCallForRender) || undefined,
              message: toolCallForRender.message
                ? {
                    chatId: toolCallForRender.message.chatId,
                    messageId: toolCallForRender.message.messageId,
                    threadId: toolCallForRender.message.threadId,
                  }
                : undefined,
              options: params.options.map((option) => ({
                optionId: option.optionId,
                kind: option.kind,
                name: option.name,
              })),
            },
            signal,
          );

          if (decision.outcome === "cancelled") {
            return {
              outcome: {
                outcome: "cancelled",
              },
            };
          }

          return {
            outcome: {
              outcome: "selected",
              optionId: decision.optionId,
            },
          };
        })
      : () => undefined;

    binding.unsubscribe = client.onSessionUpdate(sessionId, async (update) => {
      binding.pendingSessionUpdates = binding.pendingSessionUpdates
        .catch(() => undefined)
        .then(async () => {
          await this.handleSessionUpdate(binding, update);
        });

      await binding.pendingSessionUpdates;
    });
    const unsubscribeUpdates = binding.unsubscribe;
    binding.unsubscribe = () => {
      unsubscribePermission();
      unsubscribeUpdates();
    };

    this.sessionBindings.set(bindingKey, binding);
    if (binding.stateKey) {
      this.stateStore.setAvailableCommands(binding.stateKey, client.getAvailableCommands(sessionId));
    }
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

  private async handleSessionUpdate(binding: SessionBinding, update: SessionUpdate): Promise<void> {
    const availableCommands = extractAvailableCommands(update);
    if (availableCommands && binding.stateKey && binding.syncCommands) {
      this.stateStore.setAvailableCommands(binding.stateKey, availableCommands);
      await this.syncCommands(binding.stateKey, binding.chatId);
    }

    if (!binding.activeTurn) {
      return;
    }

    await this.setTypingIfSupported(binding.chatId);
    const events = renderEventsFromUpdate(update);
    for (const event of events) {
      if (event.kind === "chunk") {
        binding.activeTurn.chunkBuffer += event.text;
        binding.activeTurn.fullText += event.text;
        continue;
      }
      if (event.kind === "tool_call") {
        if (this.outputMode !== "last_text") {
          await this.flushChunkBuffer(binding);
        }
        if (this.outputMode === "full") {
          await this.upsertToolCallMessage(binding, event);
        }
        continue;
      }
      binding.activeTurn.fullText += event.text;
      if (this.outputMode === "last_text") {
        continue;
      }
      await this.flushChunkBuffer(binding);
      await this.channel.sendMessage(binding.chatId, event.text);
      binding.activeTurn.hasVisibleOutput = true;
    }
  }

  private async flushChunkBuffer(binding: SessionBinding): Promise<void> {
    if (!binding.activeTurn?.chunkBuffer) {
      return;
    }

    const payload = binding.activeTurn.chunkBuffer;
    binding.activeTurn.chunkBuffer = "";
    await sendChunkedMessage(this.channel, binding.chatId, payload);
    binding.activeTurn.hasVisibleOutput = true;
  }

  private async finalizeTurn(chatId: string, binding: SessionBinding): Promise<void> {
    if (!binding.activeTurn) {
      return;
    }

    if (this.outputMode === "last_text") {
      const finalText = binding.activeTurn.fullText;
      if (finalText.length > 0) {
        await sendChunkedMessage(this.channel, chatId, finalText);
        binding.activeTurn.hasVisibleOutput = true;
      }
    } else {
      await this.flushChunkBuffer(binding);
    }

    if (!binding.activeTurn.hasVisibleOutput) {
      await this.channel.sendMessage(
        chatId,
        "No textual updates were emitted by the agent during this turn.",
      );
    }
  }

  private async upsertToolCallMessage(
    binding: SessionBinding,
    event: Extract<RenderEvent, { kind: "tool_call" }>,
  ): Promise<void> {
    if (!binding.activeTurn) {
      return;
    }

    const existing = binding.activeTurn.toolCalls.get(event.toolCallId);
    const toolCall: ToolCallRenderState = existing ?? {
      toolCallId: event.toolCallId,
      title: undefined,
      status: undefined,
      contentMessages: [],
      rawOutput: undefined,
      rendered: undefined,
      message: undefined,
    };

    if (event.titleProvided && typeof event.title === "string" && event.title.trim().length > 0) {
      toolCall.title = event.title;
    }
    if (event.statusProvided) {
      toolCall.status = event.status;
    }
    if (event.contentProvided) {
      toolCall.contentMessages = event.contentMessages;
    }
    if (event.rawOutputProvided) {
      toolCall.rawOutput = event.rawOutput;
    }

    const rendered = renderToolCallText(toolCall);
    binding.activeTurn.toolCalls.set(event.toolCallId, toolCall);

    if (!rendered) {
      return;
    }

    if (toolCall.rendered === rendered) {
      return;
    }

    if (toolCall.message && this.channel.editMessage) {
      toolCall.message = await this.channel.editMessage(toolCall.message, rendered);
    } else {
      toolCall.message = await this.channel.sendMessage(binding.chatId, rendered);
    }
    toolCall.rendered = rendered;
    binding.activeTurn.hasVisibleOutput = true;

    binding.activeTurn.toolCalls.set(event.toolCallId, toolCall);
  }

  private async waitForPendingSessionUpdates(binding: SessionBinding): Promise<void> {
    await binding.pendingSessionUpdates.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, PROMPT_TURN_SETTLE_MS));
    await binding.pendingSessionUpdates.catch(() => undefined);
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
        state.availableCommands.map((command) => this.toChatCommandDefinition(state.activeAgentId, command)),
      ),
    );
  }

  private toChatCommandDefinition(agentId: string, command: AvailableCommand): { name: string; description: string } {
    return toAgentChatCommandDefinition(agentId, command);
  }

  private requireWorkspace(workspaceId: string): LoadedWorkspaceConfig {
    const workspace = this.workspacesById.get(workspaceId);
    if (!workspace) {
      throw new Error(`Unknown workspace '${workspaceId}'.`);
    }
    return workspace;
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
