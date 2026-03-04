import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentProcessManager } from "../../src/core/acp/AgentProcessManager.js";
import type { ChannelAdapter } from "../../src/core/channel/ChannelAdapter.js";
import type { MessageEnvelope } from "../../src/core/channel/MessageEnvelope.js";
import { ChatOrchestrator } from "../../src/core/orchestrator/ChatOrchestrator.js";
import { CommandRouter } from "../../src/core/router/CommandRouter.js";
import { InMemoryChatStateStore } from "../../src/core/state/InMemoryChatStateStore.js";

class MockChannelAdapter implements ChannelAdapter {
  readonly platform = "telegram" as const;

  messages: Array<{ chatId: string; text: string }> = [];
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

  async sendMessage(chatId: string, text: string): Promise<void> {
    this.messages.push({ chatId, text });
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

  beforeEach(async () => {
    const logger = pino({ enabled: false });
    const tsxCli = path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
    const fakeAgent = path.resolve(process.cwd(), "tools/fake-acp-agent.ts");

    manager = new AgentProcessManager(
      [
        {
          id: "fake",
          command: process.execPath,
          args: [tsxCli, fakeAgent],
          cwd: process.cwd(),
          env: {},
          default: true,
        },
      ],
      "fake",
      logger,
    );

    adapter = new MockChannelAdapter();

    orchestrator = new ChatOrchestrator({
      channel: adapter,
      stateStore: new InMemoryChatStateStore(),
      router: new CommandRouter(),
      agentManager: manager,
      accessControl: {
        allowedChatIds: ["telegram:1001"],
        allowedUserIds: [],
      },
      logger,
    });

    await orchestrator.start();
  });

  afterEach(async () => {
    await orchestrator.stop();
    await manager.stopAll();
  });

  it("rejects prompt when /session was not created", async () => {
    await adapter.emit("hello");

    expect(adapter.messages.at(-1)?.text).toContain("Run /session first");
  });

  it("runs initialize -> session/new -> session/prompt and auto-approves permission", async () => {
    await adapter.emit("/session");
    expect(adapter.messages.at(-1)?.text).toContain("Session created");
    adapter.clearMessages();

    await adapter.emit("hello hermes");

    await waitFor(() => adapter.messages.length > 0);
    const merged = adapter.messages.map((m) => m.text).join("\n");
    expect(merged).toContain("Echo: hello hermes");
    expect(merged).toContain("permission:allow");
    expect(merged).not.toContain("Turn complete.");
    expect(adapter.messages.length).toBe(1);
  });

  it("cancels active turn via /cancel", async () => {
    await adapter.emit("/session");
    adapter.clearMessages();

    void adapter.emit("please run a long task");
    await new Promise((resolve) => setTimeout(resolve, 250));

    await adapter.emit("/cancel");
    expect(adapter.messages.some((m) => m.text.includes("Cancellation requested"))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(adapter.messages.some((m) => m.text.includes("Turn complete."))).toBe(false);
  });
});
