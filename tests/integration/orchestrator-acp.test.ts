import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino, { type Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_ID,
  type LoadedWorkspaceConfig,
  type OutputMode,
  type ToolApprovalMode,
} from "../../src/config/schema.js";
import { AgentProcessManager } from "../../src/core/acp/AgentProcessManager.js";
import type {
  ChannelAdapter,
  OutboundMessageHandle,
  WorkspacePickerOption,
} from "../../src/core/channel/ChannelAdapter.js";
import type { MessageEnvelope } from "../../src/core/channel/MessageEnvelope.js";
import type { ToolPermissionDecision, ToolPermissionRequest } from "../../src/core/channel/PermissionRequest.js";
import { ChatOrchestrator } from "../../src/core/orchestrator/ChatOrchestrator.js";
import { CommandRouter } from "../../src/core/router/CommandRouter.js";
import { InMemoryChatStateStore } from "../../src/core/state/InMemoryChatStateStore.js";
import type { ChatCommandDefinition } from "../../src/core/router/CommandRouter.js";

interface PendingPermissionRequest {
  chatId: string;
  request: ToolPermissionRequest;
  resolve: (decision: ToolPermissionDecision) => void;
  settled: boolean;
}

class MockChannelAdapter implements ChannelAdapter {
  readonly platform = "telegram" as const;

  messages: Array<{ chatId: string; text: string; messageId: string }> = [];
  edits: Array<{ chatId: string; text: string; messageId: string }> = [];
  syncedCommands: Array<{ chatId: string; commands: readonly ChatCommandDefinition[] }> = [];
  workspacePickers: Array<{ chatId: string; options: readonly WorkspacePickerOption[] }> = [];
  typingSignals: string[] = [];
  pendingPermissionRequests: PendingPermissionRequest[] = [];
  private nextMessageId = 1;
  private handler?: (msg: MessageEnvelope) => Promise<void>;

  onMessage(handler: (msg: MessageEnvelope) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    // no-op
  }

  async stop(): Promise<void> {
    // no-op
  }

  async sendMessage(chatId: string, text: string): Promise<OutboundMessageHandle> {
    const messageId = String(this.nextMessageId);
    this.nextMessageId += 1;
    this.messages.push({ chatId, text, messageId });
    return {
      chatId,
      messageId,
      threadId: `telegram:${chatId}`,
    };
  }

  async editMessage(message: OutboundMessageHandle, text: string): Promise<OutboundMessageHandle> {
    const existing = this.messages.find((entry) => entry.messageId === message.messageId);
    if (!existing) {
      throw new Error(`Message not found: ${message.messageId}`);
    }

    existing.text = text;
    this.edits.push({ chatId: message.chatId, text, messageId: message.messageId });
    return message;
  }

  async setTyping(chatId: string): Promise<void> {
    this.typingSignals.push(chatId);
  }

  async syncCommands(chatId: string, commands: readonly ChatCommandDefinition[]): Promise<void> {
    this.syncedCommands.push({ chatId, commands });
  }

  async showWorkspacePicker(chatId: string, options: readonly WorkspacePickerOption[]): Promise<void> {
    this.workspacePickers.push({ chatId, options });
  }

  async requestPermission(
    chatId: string,
    request: ToolPermissionRequest,
    signal?: AbortSignal,
  ): Promise<ToolPermissionDecision> {
    return await new Promise<ToolPermissionDecision>((resolve) => {
      const pending: PendingPermissionRequest = {
        chatId,
        request,
        resolve: (decision) => {
          if (pending.settled) {
            return;
          }
          pending.settled = true;
          this.pendingPermissionRequests = this.pendingPermissionRequests.filter((entry) => entry !== pending);
          resolve(decision);
        },
        settled: false,
      };

      if (signal) {
        signal.addEventListener("abort", () => {
          pending.resolve({ outcome: "cancelled" });
        }, { once: true });
      }

      this.pendingPermissionRequests.push(pending);
    });
  }

  async emit(text: string, overrides?: Partial<MessageEnvelope>): Promise<void> {
    if (!this.handler) {
      throw new Error("No handler registered");
    }

    await this.handler({
      platform: "telegram",
      chatId: "1001",
      userId: "2002",
      messageId: String(this.messages.length + 1),
      text,
      isCommand: text.startsWith("/"),
      timestamp: Date.now(),
      ...overrides,
    });
  }

  clearMessages(): void {
    this.messages.length = 0;
    this.edits.length = 0;
  }

  resolveNextPermission(decision: ToolPermissionDecision): void {
    const pending = this.pendingPermissionRequests[0];
    if (!pending) {
      throw new Error("No pending permission request");
    }
    pending.resolve(decision);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("ChatOrchestrator + ACP integration", () => {
  let adapter: MockChannelAdapter;
  let manager: AgentProcessManager;
  let orchestrator: ChatOrchestrator;
  let logger: Logger;
  let workspaces: LoadedWorkspaceConfig[];
  let workspaceRoot: string;

  async function startOrchestrator(
    toolApprovalMode: ToolApprovalMode = "auto",
    outputMode: OutputMode = "full",
  ): Promise<ChatOrchestrator> {
    const instance = new ChatOrchestrator({
      channel: adapter,
      stateStore: new InMemoryChatStateStore(),
      router: new CommandRouter(),
      agentManager: manager,
      workspaces,
      defaultWorkspaceId: "repo",
      accessControl: {
        allowChats: ["telegram:1001"],
        allowUsers: [],
      },
      outputMode,
      toolApprovalMode,
      logger,
    });

    await instance.start();
    return instance;
  }

  beforeEach(async () => {
    logger = pino({ enabled: false });
    const tsxCli = path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
    const fakeAgent = path.resolve(process.cwd(), "tools/fake-acp-agent.ts");
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "hermes-workspace-"));
    await mkdir(path.join(workspaceRoot, "repo"), { recursive: true });
    await mkdir(path.join(workspaceRoot, "alt"), { recursive: true });
    workspaces = [
      { id: DEFAULT_WORKSPACE_ID, path: workspaceRoot },
      { id: "repo", path: path.join(workspaceRoot, "repo") },
      { id: "alt", path: path.join(workspaceRoot, "alt") },
    ];

    manager = new AgentProcessManager(
      [
        {
          id: "fake",
          command: process.execPath,
          args: [tsxCli, fakeAgent],
          cwd: workspaceRoot,
          env: {},
        },
      ],
      "fake",
      [
        {
          name: "filesystem",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", workspaceRoot],
          env: [],
        },
        {
          type: "http",
          name: "docs",
          url: "https://mcp.example.com",
          headers: [],
        },
      ],
      logger,
    );

    adapter = new MockChannelAdapter();
    orchestrator = await startOrchestrator();
  });

  afterEach(async () => {
    await orchestrator.stop();
    await manager.stopAll();
  });

  it("rejects prompt when /session was not created", async () => {
    await adapter.emit("hello");

    expect(adapter.messages.at(-1)?.text).toContain("Run /new first");
  });

  it("runs initialize -> session/new -> session/prompt and auto-approves permission", async () => {
    await adapter.emit("/new");
    expect(adapter.messages.at(-1)?.text).toContain("Session created");
    adapter.clearMessages();

    await adapter.emit("hello hermes");

    await waitFor(() => adapter.messages.some((m) => m.text.includes("[tool] Fake search operation (completed)")));
    const merged = adapter.messages.map((m) => m.text).join("\n");
    expect(merged).toContain("Echo: hello hermes");
    expect(merged).toContain("permission:allow");
    expect(merged).toContain("Write permission granted via: allow");
    expect(merged).toContain("Search complete for: hello hermes");
    expect(merged).toContain("\"result\":\"ok\"");
    expect(merged).not.toContain("Turn complete.");
    expect(adapter.messages.length).toBeGreaterThanOrEqual(2);
    expect(adapter.edits.length).toBeGreaterThanOrEqual(2);
    expect(adapter.messages.filter((m) => m.text.includes("[tool] Fake write operation")).length).toBe(1);
    expect(adapter.messages.filter((m) => m.text.includes("[tool] Fake search operation")).length).toBe(1);
    expect(merged).not.toContain("[tool] Fake search operation (pending)");
    expect(merged).not.toContain("[tool] Fake search operation (in_progress)");
  });

  it("waits for manual permission approval before allowing the tool call", async () => {
    await orchestrator.stop();
    orchestrator = await startOrchestrator("manual");

    await adapter.emit("/new");
    adapter.clearMessages();

    void adapter.emit("hello hermes");

    await waitFor(() => adapter.pendingPermissionRequests.length === 1);
    const pendingRequest = adapter.pendingPermissionRequests[0];
    expect(pendingRequest?.request.title).toBe("Fake write operation");
    expect(pendingRequest?.request.renderedText).toContain("[tool] Fake write operation (pending)");
    expect(pendingRequest?.request.message?.messageId).toBe(
      adapter.messages.find((entry) => entry.text.includes("[tool] Fake write operation (pending)"))?.messageId,
    );
    expect(adapter.messages.map((entry) => entry.text).join("\n")).not.toContain("permission:allow");

    adapter.resolveNextPermission({ outcome: "selected", optionId: "allow" });

    await waitFor(() => adapter.messages.some((m) => m.text.includes("[tool] Fake search operation (completed)")));

    const merged = adapter.messages.map((m) => m.text).join("\n");
    expect(merged).toContain("permission:allow");
    expect(merged).toContain("Write permission granted via: allow");
    expect(merged).toContain("Search complete for: hello hermes");
  });

  it("hides tool calls and only forwards agent text when output mode is text_only", async () => {
    await orchestrator.stop();
    orchestrator = await startOrchestrator("auto", "text_only");

    await adapter.emit("/new");
    adapter.clearMessages();

    await adapter.emit("hello hermes");

    await waitFor(() => adapter.messages.some((m) => m.text.includes("permission:allow")));

    const merged = adapter.messages.map((m) => m.text).join("\n");
    expect(merged).toContain("Echo: hello hermes");
    expect(merged).toContain("permission:allow");
    expect(merged).not.toContain("[tool]");
    expect(merged).not.toContain("Search complete for: hello hermes");
    expect(merged).not.toContain("\"result\":\"ok\"");
    expect(adapter.edits).toHaveLength(0);
  });

  it("only sends the final text for the current prompt turn when output mode is last_text", async () => {
    await orchestrator.stop();
    orchestrator = await startOrchestrator("auto", "last_text");

    await adapter.emit("/new");
    adapter.clearMessages();

    await adapter.emit("hello hermes");

    await waitFor(() => adapter.messages.some((m) => m.text.includes("permission:allow")));

    expect(adapter.messages).toHaveLength(1);
    expect(adapter.messages[0]?.text).toContain("Echo: hello hermes");
    expect(adapter.messages[0]?.text).toContain("permission:allow");
    expect(adapter.messages[0]?.text).toContain("done done done done");
    expect(adapter.messages[0]?.text).not.toContain("[tool]");
    expect(adapter.edits).toHaveLength(0);
  });

  it("cancels a pending manual permission request when /cancel is issued", async () => {
    await orchestrator.stop();
    orchestrator = await startOrchestrator("manual");

    await adapter.emit("/new");
    adapter.clearMessages();

    void adapter.emit("hello hermes");
    await waitFor(() => adapter.pendingPermissionRequests.length === 1);

    await adapter.emit("/cancel");

    await waitFor(() => adapter.pendingPermissionRequests.length === 0);
    expect(adapter.messages.some((m) => m.text.includes("Cancellation requested"))).toBe(true);
    expect(adapter.messages.map((entry) => entry.text).join("\n")).not.toContain("permission:allow");
  });

  it("syncs ACP slash commands after session creation", async () => {
    await adapter.emit("/new");

    await waitFor(() => adapter.syncedCommands.length >= 2);

    expect(adapter.syncedCommands.at(-1)).toEqual({
      chatId: "1001",
      commands: [
        { name: "agents", description: "List configured agents" },
        { name: "agent", description: "Switch the active agent" },
        { name: "workspace", description: "Switch the active workspace" },
        { name: "new", description: "Create a new ACP session" },
        { name: "models", description: "List selectable models for the active session" },
        { name: "model", description: "Set the model for the active session" },
        { name: "status", description: "Show current chat state" },
        { name: "cancel", description: "Cancel the active turn" },
        { name: "fake:explain", description: "Explain the selected code or text." },
        { name: "fake:summarize", description: "Summarize the latest context." },
      ],
    });
  });

  it("rewrites namespaced agent commands before sending them to ACP", async () => {
    await adapter.emit("/new");
    adapter.clearMessages();

    await adapter.emit("/fake:explain file.ts");

    await waitFor(() => adapter.messages.some((m) => m.text.includes("[tool] Fake search operation (completed)")));

    const merged = adapter.messages.map((m) => m.text).join("\n");
    expect(merged).toContain("Echo: /explain file.ts");
    expect(merged).toContain("Search complete for: /explain file.ts");
  });

  it("shows configured MCP servers in /status", async () => {
    await adapter.emit("/status");

    const status = adapter.messages.at(-1)?.text;
    expect(status).toContain("Agent: fake");
    expect(status).toContain(`Workspace: repo (${path.join(workspaceRoot, "repo")})`);
    expect(status).toContain("Model: (not available)");
    expect(status).toContain("MCP servers: filesystem (stdio), docs (http)");
  });

  it("shows a workspace picker with configured workspace ids", async () => {
    await adapter.emit("/workspace");

    expect(adapter.workspacePickers).toEqual([
      {
        chatId: "1001",
        options: [
          { id: DEFAULT_WORKSPACE_ID, path: workspaceRoot, selected: false },
          { id: "repo", path: path.join(workspaceRoot, "repo"), selected: true },
          { id: "alt", path: path.join(workspaceRoot, "alt"), selected: false },
        ],
      },
    ]);
  });

  it("switches workspace and uses it for the next session", async () => {
    await adapter.emit("/workspace alt");
    expect(adapter.messages.at(-1)?.text).toContain("Workspace switched to 'alt'");

    adapter.clearMessages();
    await adapter.emit("/new");
    expect(adapter.messages.at(-1)?.text).toContain("Workspace: alt");

    adapter.clearMessages();
    await adapter.emit("please report cwd");
    await waitFor(() => adapter.messages.some((m) => m.text.includes("[cwd:")));

    expect(adapter.messages.map((entry) => entry.text).join("\n")).toContain(`[cwd:${path.join(workspaceRoot, "alt")}]`);
  });

  it("shows the current model in /status after session creation", async () => {
    await adapter.emit("/new");
    adapter.clearMessages();

    await adapter.emit("/status");

    const status = adapter.messages.at(-1)?.text;
    expect(status).toContain("Session: ");
    expect(status).not.toContain("Session: (none)");
    expect(status).toContain("Model: gpt-5");
  });

  it("passes configured MCP servers into session/new", async () => {
    await adapter.emit("/new");
    adapter.clearMessages();

    await adapter.emit("please report mcp");

    await waitFor(() => adapter.messages.some((m) => m.text.includes("[mcp:filesystem,docs]")));

    expect(adapter.messages.map((entry) => entry.text).join("\n")).toContain("[mcp:filesystem,docs]");
  });

  it("runs scheduled tasks in an isolated session without disturbing chat state", async () => {
    await orchestrator.runScheduledTask({
      id: "daily-report",
      enabled: true,
      botId: "tg-main",
      chatId: "1001",
      agentId: "fake",
      workspaceId: "alt",
      prompt: "please report cwd and report model",
      schedule: {
        type: "interval",
        everySeconds: 3600,
      },
    });

    await waitFor(() => adapter.messages.some((m) => m.text.includes("[tool] Fake search operation (completed)")));

    const merged = adapter.messages.map((entry) => entry.text).join("\n");
    expect(merged).toContain(`[cwd:${path.join(workspaceRoot, "alt")}]`);
    expect(merged).toContain("[model:gpt-5]");
    expect(merged).toContain("permission:allow");
  });

  it("resets chat-scoped commands when the active agent changes", async () => {
    await adapter.emit("/new");
    await waitFor(() => adapter.syncedCommands.length >= 2);

    adapter.syncedCommands.length = 0;
    await adapter.emit("/agent fake");

    expect(adapter.syncedCommands).toEqual([
      {
        chatId: "1001",
        commands: [
          { name: "agents", description: "List configured agents" },
          { name: "agent", description: "Switch the active agent" },
          { name: "workspace", description: "Switch the active workspace" },
          { name: "new", description: "Create a new ACP session" },
          { name: "models", description: "List selectable models for the active session" },
          { name: "model", description: "Set the model for the active session" },
          { name: "status", description: "Show current chat state" },
          { name: "cancel", description: "Cancel the active turn" },
        ],
      },
    ]);
  });

  it("lists selectable models for the active session", async () => {
    await adapter.emit("/new");
    adapter.clearMessages();

    await adapter.emit("/models");

    expect(adapter.messages.at(-1)?.text).toContain("Current model: gpt-5");
    expect(adapter.messages.at(-1)?.text).toContain("* gpt-5 (GPT-5)");
    expect(adapter.messages.at(-1)?.text).toContain("gpt-5-mini (GPT-5 Mini)");
  });

  it("switches the active session model", async () => {
    await adapter.emit("/new");
    adapter.clearMessages();

    await adapter.emit("/model gpt-5-mini");
    expect(adapter.messages.at(-1)?.text).toContain("Model switched to 'gpt-5-mini'");

    adapter.clearMessages();
    await adapter.emit("/models");
    expect(adapter.messages.at(-1)?.text).toContain("Current model: gpt-5-mini");
    expect(adapter.messages.at(-1)?.text).toContain("* gpt-5-mini (GPT-5 Mini)");

    adapter.clearMessages();
    await adapter.emit("please report model");
    await waitFor(() => adapter.messages.some((m) => m.text.includes("[tool] Fake search operation (completed)")));
    expect(adapter.messages.map((entry) => entry.text).join("\n")).toContain("[model:gpt-5-mini]");
  });

  it("cancels active turn via /cancel", async () => {
    await adapter.emit("/new");
    adapter.clearMessages();

    void adapter.emit("please run a long task");
    await new Promise((resolve) => setTimeout(resolve, 250));

    await adapter.emit("/cancel");
    expect(adapter.messages.some((m) => m.text.includes("Cancellation requested"))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(adapter.messages.some((m) => m.text.includes("Turn complete."))).toBe(false);
  });

  it("emits typing signal while session updates are streaming", async () => {
    await adapter.emit("/new");
    adapter.clearMessages();
    adapter.typingSignals.length = 0;

    await adapter.emit("hello typing");
    await waitFor(() => adapter.messages.some((m) => m.text.includes("[tool] Fake search operation (completed)")));

    expect(adapter.typingSignals.length).toBeGreaterThan(0);
    expect(adapter.typingSignals.every((chatId) => chatId === "1001")).toBe(true);
  });

  it("edits tool-call updates in place instead of sending a new message per status change", async () => {
    await adapter.emit("/new");
    adapter.clearMessages();

    await adapter.emit("hello tool flow");

    await waitFor(() => adapter.messages.some((m) => m.text.includes("[tool] Fake search operation (completed)")));

    const toolMessages = adapter.messages.filter((m) => m.text.includes("[tool] Fake search operation"));
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.text).toContain("Search complete for: hello tool flow");
    expect(adapter.edits.map((entry) => entry.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("[tool] Fake search operation (in_progress)"),
        expect.stringContaining("[tool] Fake search operation (completed)"),
      ]),
    );
  });

  it("ignores tool_call_update events that do not change visible content", async () => {
    await adapter.emit("/new");
    adapter.clearMessages();

    await adapter.emit("please trigger noop tool update");

    await waitFor(() => adapter.messages.some((m) => m.text.includes("[tool] Fake search operation (completed)")));

    const searchToolMessages = adapter.messages.filter((m) => m.text.includes("[tool] Fake search operation"));
    expect(searchToolMessages).toHaveLength(1);
    expect(searchToolMessages[0]?.text).toContain("Search complete for: please trigger noop tool update");
  });

  it("does not render fallback toolCallId text when an update arrives without a visible title", async () => {
    await adapter.emit("/new");
    adapter.clearMessages();

    await adapter.emit("please trigger untitled tool");

    await waitFor(() => adapter.messages.some((m) => m.text.includes("Echo: please trigger untitled tool")));

    const merged = adapter.messages.map((m) => m.text).join("\n");
    expect(merged).not.toContain("[tool] tool:call_c1f39807384f4f21954d7ffc");
    expect(merged).not.toContain("call_c1f39807384f4f21954d7ffc");
  });

  it("waits briefly for late tool-call completion updates before finalizing the turn", async () => {
    await adapter.emit("/new");
    adapter.clearMessages();

    await adapter.emit("please run late tool");

    await waitFor(() => adapter.messages.some((m) => m.text.includes("[tool] Fake search operation (completed)")));

    const toolMessage = adapter.messages.find((m) => m.text.includes("[tool] Fake search operation"));
    expect(toolMessage?.text).toContain("(completed)");
    expect(toolMessage?.text).not.toContain("(pending)");
  });
});
