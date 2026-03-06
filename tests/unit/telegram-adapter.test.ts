import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTelegramCommands } from "../../src/adapters/telegram/TelegramAdapter.js";

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
      commands: [
        { command: "agents", description: "List configured agents" },
        { command: "agent", description: "Switch the active agent" },
        { command: "new", description: "Create a new ACP session" },
        { command: "status", description: "Show current chat state" },
        { command: "cancel", description: "Cancel the active turn" },
      ],
    });
  });
});
