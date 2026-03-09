import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const initializeMock = vi.fn();
const shutdownMock = vi.fn();

const mockDiscordSdk = {
  postMessage: vi.fn(),
  editMessage: vi.fn(),
  startTyping: vi.fn(),
  startGatewayListener: vi.fn(),
};

const chatState: {
  newMessageHandler?: (thread: unknown, message: unknown) => Promise<void>;
  subscribedMessageHandler?: (thread: unknown, message: unknown) => Promise<void>;
} = {
};

vi.mock("@chat-adapter/state-memory", () => ({
  createMemoryState: vi.fn(() => ({})),
}));

vi.mock("@chat-adapter/discord", () => ({
  createDiscordAdapter: vi.fn(() => mockDiscordSdk),
}));

vi.mock("chat", () => {
  class ChatMock {
    onNewMessage(_pattern: RegExp, handler: (thread: unknown, message: unknown) => Promise<void>): void {
      chatState.newMessageHandler = handler;
    }

    onSubscribedMessage(handler: (thread: unknown, message: unknown) => Promise<void>): void {
      chatState.subscribedMessageHandler = handler;
    }

    async initialize(): Promise<void> {
      initializeMock();
    }

    async shutdown(): Promise<void> {
      shutdownMock();
    }
  }

  return {
    Chat: ChatMock,
  };
});

describe("DiscordAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initializeMock.mockClear();
    shutdownMock.mockClear();
    chatState.newMessageHandler = undefined;
    chatState.subscribedMessageHandler = undefined;

    mockDiscordSdk.postMessage.mockResolvedValue({ id: "m-1" });
    mockDiscordSdk.editMessage.mockResolvedValue({ id: "m-2" });
    mockDiscordSdk.startTyping.mockResolvedValue(undefined);
    mockDiscordSdk.startGatewayListener.mockImplementation(async (options: { waitUntil?: (task: Promise<unknown>) => void }, _durationMs: number, signal?: AbortSignal) => {
      const task = new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      options.waitUntil?.(task);
      return new Response("ok", { status: 200 });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes ! commands and maps top-level channels to Hermes chat ids", async () => {
    const { DiscordAdapter } = await import("../../src/adapters/discord/DiscordAdapter.js");
    const adapter = new DiscordAdapter("token", pino({ enabled: false }));
    const handler = vi.fn().mockResolvedValue(undefined);
    const subscribe = vi.fn().mockResolvedValue(undefined);

    adapter.onMessage(handler);

    await chatState.newMessageHandler?.(
      { id: "discord:guild-1:channel-2", subscribe },
      {
        text: "!status",
        id: "msg-1",
        author: { userId: "user-1" },
        metadata: { dateSent: new Date("2026-03-09T00:00:00.000Z") },
      },
    );

    expect(subscribe).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({
      platform: "discord",
      chatId: "guild-1:channel-2",
      userId: "user-1",
      messageId: "msg-1",
      text: "/status",
      isCommand: true,
      timestamp: new Date("2026-03-09T00:00:00.000Z").getTime(),
    });
  });

  it("maps thread messages to Hermes thread chat ids without rewriting plain text", async () => {
    const { DiscordAdapter } = await import("../../src/adapters/discord/DiscordAdapter.js");
    const adapter = new DiscordAdapter("token", pino({ enabled: false }));
    const handler = vi.fn().mockResolvedValue(undefined);

    adapter.onMessage(handler);

    await chatState.subscribedMessageHandler?.(
      { id: "discord:guild-1:channel-2:thread-3" },
      {
        text: "hello discord",
        id: "msg-2",
        author: { userId: "user-2" },
        metadata: { dateSent: new Date("2026-03-09T00:00:01.000Z") },
      },
    );

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "guild-1:channel-2:thread-3",
      text: "hello discord",
      isCommand: false,
    }));
  });

  it("sends, edits, and types against the internal Discord thread id", async () => {
    const {
      DiscordAdapter,
      toDiscordThreadId,
    } = await import("../../src/adapters/discord/DiscordAdapter.js");
    const adapter = new DiscordAdapter("token", pino({ enabled: false }));
    const chatId = "guild-1:channel-2:thread-3";

    const sent = await adapter.sendMessage(chatId, "hello");
    const edited = await adapter.editMessage(sent, "updated");
    await adapter.setTyping(chatId);

    expect(mockDiscordSdk.postMessage).toHaveBeenCalledWith(toDiscordThreadId(chatId), "hello");
    expect(mockDiscordSdk.editMessage).toHaveBeenCalledWith(toDiscordThreadId(chatId), "m-1", "updated");
    expect(mockDiscordSdk.startTyping).toHaveBeenCalledWith(toDiscordThreadId(chatId));
    expect(edited).toEqual({
      chatId,
      messageId: "m-2",
      threadId: toDiscordThreadId(chatId),
    });
  });

  it("starts and stops the supervised gateway listener", async () => {
    const { DiscordAdapter } = await import("../../src/adapters/discord/DiscordAdapter.js");
    const adapter = new DiscordAdapter("token", pino({ enabled: false }), undefined, undefined, 50);

    await adapter.start();
    await adapter.stop();

    expect(initializeMock).toHaveBeenCalledOnce();
    expect(mockDiscordSdk.startGatewayListener).toHaveBeenCalledOnce();
    expect(shutdownMock).toHaveBeenCalledOnce();
  });
});
