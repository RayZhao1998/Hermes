import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { hermesConfigSchema } from "../../src/config/schema.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("config loading", () => {
  it("loads config and resolves default agent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hermes-config-"));
    const configPath = path.join(dir, "hermes.config.yaml");

    await writeFile(
      configPath,
      `app:\n  logLevel: info\nsecurity:\n  allowedChatIds: []\n  allowedUserIds: []\ntelegram:\n  enabled: true\n  tokenEnv: TEST_TG_TOKEN\ntools:\n  approvalMode: manual\nagents:\n  - id: a\n    command: echo\n    args: [\"ok\"]\n    cwd: .\n    env: {}\n    mcpServers:\n      - name: filesystem\n        command: npx\n        args: [\"-y\", \"@modelcontextprotocol/server-filesystem\", \".\"]\n        env:\n          - name: NODE_ENV\n            value: test\n      - type: http\n        name: docs\n        url: https://mcp.example.com\n        headers:\n          - name: Authorization\n            value: Bearer token\n    default: true\n`,
      "utf8",
    );

    process.env.TEST_TG_TOKEN = "abc";

    const loaded = await loadConfig(configPath);
    expect(loaded.defaultAgentId).toBe("a");
    expect(path.isAbsolute(loaded.agents[0].cwd)).toBe(true);
    expect(loaded.telegram.token).toBe("abc");
    expect(loaded.tools.approvalMode).toBe("manual");
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

  it("throws when telegram token env is missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hermes-config-"));
    const configPath = path.join(dir, "hermes.config.yaml");

    await writeFile(
      configPath,
      `telegram:\n  enabled: true\n  tokenEnv: MISSING_TOKEN\nagents:\n  - id: a\n    command: echo\n    args: []\n    cwd: .\n    env: {}\n`,
      "utf8",
    );

    await expect(loadConfig(configPath)).rejects.toThrow("MISSING_TOKEN");
  });

  it("rejects duplicate agent ids", () => {
    expect(() =>
      hermesConfigSchema.parse({
        telegram: { enabled: true, tokenEnv: "TG" },
        agents: [
          { id: "a", command: "echo", args: [], cwd: ".", env: {} },
          { id: "a", command: "echo", args: [], cwd: ".", env: {} },
        ],
      }),
    ).toThrow("Duplicate agent id");
  });

  it("defaults tool approval mode to auto", () => {
    const parsed = hermesConfigSchema.parse({
      telegram: { enabled: true, tokenEnv: "TG" },
      agents: [
        { id: "a", command: "echo", args: [], cwd: ".", env: {} },
      ],
    });

    expect(parsed.tools.approvalMode).toBe("auto");
  });

  it("defaults agent MCP servers to an empty list", () => {
    const parsed = hermesConfigSchema.parse({
      telegram: { enabled: true, tokenEnv: "TG" },
      agents: [
        { id: "a", command: "echo", args: [], cwd: ".", env: {} },
      ],
    });

    expect(parsed.agents[0]?.mcpServers).toEqual([]);
  });
});
