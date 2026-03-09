import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedBotConfig } from "../../src/config/schema.js";
import { DiscordAdapter } from "../../src/adapters/discord/DiscordAdapter.js";
import { createChannel, resolveToolApprovalMode } from "../../src/main.js";

const originalEnv = { ...process.env };

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
    },
    ...overrides,
  } as LoadedBotConfig;
}

describe("main helpers", () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      DISCORD_PUBLIC_KEY: "0".repeat(64),
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

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
});
