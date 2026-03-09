import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { LoadedBotConfig } from "../../src/config/schema.js";
import { DiscordAdapter } from "../../src/adapters/discord/DiscordAdapter.js";
import { createChannel, resolveToolApprovalMode } from "../../src/main.js";

function bot(overrides: Partial<LoadedBotConfig>): LoadedBotConfig {
  return {
    id: "discord-main",
    channel: "discord",
    profileId: "default",
    defaultWorkspaceId: "default",
    enabled: true,
    access: {
      allowChats: [],
      allowUsers: [],
    },
    profile: {
      id: "default",
      defaultAgentId: "agent",
      outputMode: "full",
      tools: {
        approvalMode: "manual",
      },
      agents: [],
      mcpServers: [],
    },
    adapter: {
      token: "discord-token",
      applicationId: "app-123",
      publicKey: "0".repeat(64),
    },
    ...overrides,
  } as LoadedBotConfig;
}

describe("main helpers", () => {
  it("creates a Discord channel adapter without throwing", () => {
    const logger = pino({ enabled: false });

    const channel = createChannel(bot({}), logger);

    expect(channel).toBeInstanceOf(DiscordAdapter);
  });

  it("downgrades Discord manual approval mode to auto and warns", () => {
    const logger = pino({ enabled: false });
    const warnSpy = vi.spyOn(logger, "warn");

    const mode = resolveToolApprovalMode(bot({}), logger);

    expect(mode).toBe("auto");
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("keeps Telegram approval mode unchanged", () => {
    const logger = pino({ enabled: false });
    const warnSpy = vi.spyOn(logger, "warn");

    const mode = resolveToolApprovalMode(bot({
      channel: "telegram",
      id: "telegram-main",
      adapter: {
        token: "telegram-token",
        mode: "polling",
      },
      profile: {
        id: "default",
        defaultAgentId: "agent",
        outputMode: "full",
        tools: {
          approvalMode: "manual",
        },
        agents: [],
        mcpServers: [],
      },
    }), logger);

    expect(mode).toBe("manual");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("requires publicKey in Discord bot config", () => {
    const logger = pino({ enabled: false });
    const invalidBot = {
      ...bot({}),
      adapter: {
        token: "discord-token",
        applicationId: "app-123",
      },
    } as unknown as LoadedBotConfig;

    expect(() => createChannel(invalidBot, logger)).toThrow("requires adapter.publicKey in config");
  });
});
