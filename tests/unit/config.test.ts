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
  it("loads config and resolves default agent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hermes-config-"));
    const configPath = path.join(dir, "hermes.config.yaml");
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "hermes-home-"));

    process.env.HOME = homeDir;

    await writeFile(
      configPath,
      `app:\n  logLevel: info\n  outputMode: text_only\nsecurity:\n  allowedChatIds: []\n  allowedUserIds: []\ntelegram:\n  enabled: true\n  token: abc\ntools:\n  approvalMode: auto\nagents:\n  - id: a\n    command: echo\n    args: [\"ok\"]\n    cwd: .\n    env: {}\n    mcpServers:\n      - name: filesystem\n        command: npx\n        args: [\"-y\", \"@modelcontextprotocol/server-filesystem\", \".\"]\n        env:\n          - name: NODE_ENV\n            value: test\n      - type: http\n        name: docs\n        url: https://mcp.example.com\n        headers:\n          - name: Authorization\n            value: Bearer token\n    default: true\n`,
      "utf8",
    );

    const loaded = await loadConfig(configPath);
    const workspaceDir = getHermesWorkspaceDir(homeDir);
    expect(loaded.defaultAgentId).toBe("a");
    expect(loaded.agents[0]?.cwd).toBe(workspaceDir);
    await expect(access(workspaceDir)).resolves.toBeUndefined();
    expect(loaded.telegram.token).toBe("abc");
    expect(loaded.app.outputMode).toBe("text_only");
    expect(loaded.tools.approvalMode).toBe("auto");
    expect(loaded.agents[0]?.mcpServers).toEqual([
      {
        name: "filesystem",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
        env: [{ name: "NODE_ENV", value: "test" }],
      },
      {
        type: "http",
        name: "docs",
        url: "https://mcp.example.com",
        headers: [{ name: "Authorization", value: "Bearer token" }],
      },
    ]);
  });

  it("loads config from ~/.hermes/config.yaml by default", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "hermes-home-"));
    const configPath = getHermesConfigPath(homeDir);

    process.env.HOME = homeDir;
    await mkdir(path.dirname(configPath), { recursive: true });

    await writeFile(
      configPath,
      `telegram:\n  enabled: true\n  token: from-config\nagents:\n  - id: a\n    command: echo\n    args: []\n    cwd: .\n    env: {}\n`,
      "utf8",
    );

    const loaded = await loadConfig();
    expect(loaded.configPath).toBe(configPath);
    expect(loaded.agents[0]?.cwd).toBe(getHermesWorkspaceDir(homeDir));
    expect(loaded.telegram.token).toBe("from-config");
  });

  it("ignores configured agent cwd and uses the Hermes workspace", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hermes-config-"));
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "hermes-home-"));
    const configPath = path.join(dir, "config.yaml");

    process.env.HOME = homeDir;

    await writeFile(
      configPath,
      `telegram:\n  enabled: true\n  token: abc\nagents:\n  - id: a\n    command: echo\n    args: []\n    cwd: /tmp/legacy-project\n    env: {}\n`,
      "utf8",
    );

    const loaded = await loadConfig(configPath);
    expect(loaded.agents[0]?.cwd).toBe(getHermesWorkspaceDir(homeDir));
  });

  it("throws when telegram token is missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hermes-config-"));
    const configPath = path.join(dir, "config.yaml");

    await writeFile(
      configPath,
      `telegram:\n  enabled: true\nagents:\n  - id: a\n    command: echo\n    args: []\n    cwd: .\n    env: {}\n`,
      "utf8",
    );

    await expect(loadConfig(configPath)).rejects.toThrow("Telegram token must be configured");
  });

  it("rejects non-full output modes when tool approval mode is manual", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hermes-config-"));
    const configPath = path.join(dir, "hermes.config.yaml");

    await writeFile(
      configPath,
      `app:\n  outputMode: last_text\ntelegram:\n  enabled: true\n  token: abc\ntools:\n  approvalMode: manual\nagents:\n  - id: a\n    command: echo\n    args: []\n    cwd: .\n    env: {}\n`,
      "utf8",
    );

    await expect(loadConfig(configPath)).rejects.toThrow(
      "Invalid config: app.outputMode=last_text requires tools.approvalMode=auto",
    );
  });

  it("rejects duplicate agent ids", () => {
    expect(() =>
      hermesConfigSchema.parse({
        telegram: { enabled: true, token: "TG" },
        agents: [
          { id: "a", command: "echo", args: [], cwd: ".", env: {} },
          { id: "a", command: "echo", args: [], cwd: ".", env: {} },
        ],
      }),
    ).toThrow("Duplicate agent id");
  });

  it("defaults tool approval mode to auto", () => {
    const parsed = hermesConfigSchema.parse({
      telegram: { enabled: true, token: "TG" },
      agents: [
        { id: "a", command: "echo", args: [], cwd: ".", env: {} },
      ],
    });

    expect(parsed.tools.approvalMode).toBe("auto");
  });

  it("defaults output mode to full", () => {
    const parsed = hermesConfigSchema.parse({
      telegram: { enabled: true, token: "TG" },
      agents: [
        { id: "a", command: "echo", args: [], cwd: ".", env: {} },
      ],
    });

    expect(parsed.app.outputMode).toBe("full");
  });

  it("defaults agent MCP servers to an empty list", () => {
    const parsed = hermesConfigSchema.parse({
      telegram: { enabled: true, token: "TG" },
      agents: [
        { id: "a", command: "echo", args: [], cwd: ".", env: {} },
      ],
    });

    expect(parsed.agents[0]?.mcpServers).toEqual([]);
  });
});
