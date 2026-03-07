import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { getHermesConfigPath, getHermesWorkspaceDir } from "../../src/config/paths.js";
import { hermesConfigSchema } from "../../src/config/schema.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("config loading", () => {
  it("loads config and resolves profiles and bots", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hermes-config-"));
    const configPath = path.join(dir, "hermes.config.yaml");
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "hermes-home-"));

    process.env.HOME = homeDir;

    await writeFile(
      configPath,
      `app:\n  logLevel: info\nagents:\n  - id: a\n    command: echo\n    args: ["ok"]\n    env: {}\n  - id: b\n    command: printf\n    args: []\n    env: {}\nmcpServers:\n  - name: filesystem\n    command: npx\n    args: ["-y", "@modelcontextprotocol/server-filesystem", "."]\n    env:\n      - name: NODE_ENV\n        value: test\n  - type: http\n    name: docs\n    url: https://mcp.example.com\n    headers:\n      - name: Authorization\n        value: Bearer token\nprofiles:\n  - id: personal\n    defaultAgentId: a\n    enabledAgentIds: [a]\n    mcpServerNames: [filesystem, docs]\n    outputMode: text_only\n    tools:\n      approvalMode: auto\nbots:\n  - id: tg-main\n    channel: telegram\n    profileId: personal\n    access:\n      allowChats: ["telegram:1"]\n      allowUsers: ["telegram:2"]\n    adapter:\n      token: abc\n      mode: polling\n`,
      "utf8",
    );

    const loaded = await loadConfig(configPath);
    const workspaceDir = getHermesWorkspaceDir(homeDir);

    expect(loaded.profiles).toHaveLength(1);
    expect(loaded.bots).toHaveLength(1);
    expect(loaded.profiles[0]?.defaultAgentId).toBe("a");
    expect(loaded.profiles[0]?.agents[0]?.cwd).toBe(workspaceDir);
    expect(loaded.profiles[0]?.outputMode).toBe("text_only");
    expect(loaded.profiles[0]?.mcpServers).toHaveLength(2);
    expect(loaded.bots[0]?.channel).toBe("telegram");
    expect(loaded.bots[0]?.profile.id).toBe("personal");
    expect(loaded.bots[0]?.access).toEqual({
      allowChats: ["telegram:1"],
      allowUsers: ["telegram:2"],
    });
    await expect(access(workspaceDir)).resolves.toBeUndefined();
  });

  it("loads config from ~/.hermes/config.yaml by default", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "hermes-home-"));
    const configPath = getHermesConfigPath(homeDir);

    process.env.HOME = homeDir;
    await mkdir(path.dirname(configPath), { recursive: true });

    await writeFile(
      configPath,
      `agents:\n  - id: a\n    command: echo\n    args: []\n    env: {}\nprofiles:\n  - id: default\n    defaultAgentId: a\nbots:\n  - id: tg-main\n    channel: telegram\n    profileId: default\n    adapter:\n      token: from-config\n`,
      "utf8",
    );

    const loaded = await loadConfig();
    expect(loaded.configPath).toBe(configPath);
    expect(loaded.bots[0]?.channel).toBe("telegram");
    expect(loaded.bots[0]?.profile.defaultAgentId).toBe("a");
  });

  it("rejects the old top-level config shape", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hermes-config-"));
    const configPath = path.join(dir, "config.yaml");

    await writeFile(
      configPath,
      `telegram:\n  enabled: true\n  token: abc\nsecurity:\n  allowedChatIds: []\n  allowedUserIds: []\ntools:\n  approvalMode: auto\ndefaultAgentId: a\nagents:\n  - id: a\n    command: echo\n    args: []\n    env: {}\nprofiles:\n  - id: default\n    defaultAgentId: a\nbots:\n  - id: tg-main\n    channel: telegram\n    profileId: default\n    adapter:\n      token: abc\n`,
      "utf8",
    );

    await expect(loadConfig(configPath)).rejects.toThrow("Unrecognized");
  });

  it("rejects profiles that reference unknown agents", () => {
    expect(() =>
      hermesConfigSchema.parse({
        agents: [
          { id: "a", command: "echo", args: [], env: {} },
        ],
        profiles: [
          { id: "default", defaultAgentId: "missing" },
        ],
        bots: [
          { id: "tg-main", channel: "telegram", profileId: "default", adapter: { token: "abc" } },
        ],
      }),
    ).toThrow("references unknown agent");
  });

  it("rejects bots that reference unknown profiles", () => {
    expect(() =>
      hermesConfigSchema.parse({
        agents: [
          { id: "a", command: "echo", args: [], env: {} },
        ],
        profiles: [
          { id: "default", defaultAgentId: "a" },
        ],
        bots: [
          { id: "tg-main", channel: "telegram", profileId: "missing", adapter: { token: "abc" } },
        ],
      }),
    ).toThrow("references unknown profile");
  });

  it("rejects non-full output modes when tool approval mode is manual", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hermes-config-"));
    const configPath = path.join(dir, "hermes.config.yaml");

    await writeFile(
      configPath,
      `agents:\n  - id: a\n    command: echo\n    args: []\n    env: {}\nprofiles:\n  - id: default\n    defaultAgentId: a\n    outputMode: last_text\n    tools:\n      approvalMode: manual\nbots:\n  - id: tg-main\n    channel: telegram\n    profileId: default\n    adapter:\n      token: abc\n`,
      "utf8",
    );

    await expect(loadConfig(configPath)).rejects.toThrow(
      "requires outputMode=full when tools.approvalMode=manual",
    );
  });

  it("defaults profile and bot options", () => {
    const parsed = hermesConfigSchema.parse({
      agents: [
        { id: "a", command: "echo", args: [], env: {} },
      ],
      profiles: [
        { id: "default", defaultAgentId: "a" },
      ],
      bots: [
        { id: "tg-main", channel: "telegram", profileId: "default", adapter: { token: "abc" } },
      ],
    });

    expect(parsed.app.logLevel).toBe("info");
    expect(parsed.mcpServers).toEqual([]);
    expect(parsed.profiles[0]?.outputMode).toBe("full");
    expect(parsed.profiles[0]?.tools.approvalMode).toBe("auto");
    expect(parsed.bots[0]?.enabled).toBe(true);
    expect(parsed.bots[0]?.access).toEqual({ allowChats: [], allowUsers: [] });
  });
});
