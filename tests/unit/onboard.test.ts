import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getHermesWorkspaceDir } from "../../src/config/paths.js";
import { detectSupportedAgents } from "../../src/config/onboard.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

async function createExecutable(directory: string, name: string): Promise<void> {
  const filePath = path.join(directory, name);
  await writeFile(filePath, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(filePath, 0o755);
}

describe("onboarding agent detection", () => {
  it("detects installed supported ACP agents from PATH", async () => {
    const binDir = await mkdtemp(path.join(os.tmpdir(), "hermes-bin-"));
    await createExecutable(binDir, "kimi");
    await createExecutable(binDir, "codex-acp");
    await createExecutable(binDir, "claude-code-acp");

    process.env.PATH = binDir;

    const detected = await detectSupportedAgents();
    expect(detected.map((agent) => agent.agent.id)).toEqual(["kimi", "codex", "claude"]);
    expect(detected.map((agent) => ({ command: agent.agent.command, args: agent.agent.args }))).toEqual([
      { command: "kimi", args: ["acp"] },
      { command: "codex-acp", args: [] },
      { command: "claude-code-acp", args: [] },
    ]);
  });

  it("preserves existing agent settings when a supported agent is detected", async () => {
    const binDir = await mkdtemp(path.join(os.tmpdir(), "hermes-bin-"));
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "hermes-home-"));
    await createExecutable(binDir, "codex-acp");

    process.env.PATH = binDir;
    process.env.HOME = homeDir;

    const detected = await detectSupportedAgents([
      {
        id: "my-codex",
        command: "codex-acp",
        args: [],
        cwd: "/tmp/project",
        env: { FOO: "bar" },
        mcpServers: [],
        default: true,
      },
    ]);

    expect(detected).toHaveLength(1);
    expect(detected[0]?.agent).toMatchObject({
      id: "my-codex",
      command: "codex-acp",
      args: [],
      cwd: getHermesWorkspaceDir(homeDir),
      env: { FOO: "bar" },
      default: true,
    });
  });
});
