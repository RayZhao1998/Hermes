import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTelegramCommands } from "../../src/adapters/telegram/TelegramAdapter.js";
import { commandDefinitions } from "../../src/core/router/CommandRouter.js";

describe("registerTelegramCommands", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers the full command list with Telegram Bot API", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    vi.stubGlobal("fetch", fetchMock);

    await registerTelegramCommands("test-token", pino({ enabled: false }));

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottest-token/setMyCommands",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      commands: commandDefinitions.map(({ name, description }) => ({
        command: name,
        description,
      })),
    });
  });

  it("registers chat-scoped dynamic commands", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    vi.stubGlobal("fetch", fetchMock);

    await registerTelegramCommands(
      "test-token",
      pino({ enabled: false }),
      [
        ...commandDefinitions,
        { name: "explain", description: "Explain the selected code or text." },
      ],
      { type: "chat", chat_id: "1001" },
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      commands: [
        ...commandDefinitions.map(({ name, description }) => ({
          command: name,
          description,
        })),
        { command: "explain", description: "Explain the selected code or text." },
      ],
      scope: {
        type: "chat",
        chat_id: "1001",
      },
    });
  });
});
