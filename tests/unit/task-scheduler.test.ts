import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { readTasksSource } from "../../src/config/tasks-load.js";
import { TaskScheduler } from "../../src/core/tasks/TaskScheduler.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("TaskScheduler", () => {
  it("runs due tasks from tasks.yaml and persists runtime status", async () => {
    const configDir = await mkdtemp(path.join(os.tmpdir(), "hermes-tasks-config-"));
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "hermes-tasks-home-"));
    const configPath = path.join(configDir, "config.yaml");
    const tasksPath = path.join(configDir, "tasks.yaml");

    process.env.HOME = homeDir;

    await writeFile(
      configPath,
      `agents:\n  - id: a\n    command: echo\n    args: []\n    env: {}\nprofiles:\n  - id: default\n    defaultAgentId: a\n    tools:\n      approvalMode: auto\nbots:\n  - id: tg-main\n    channel: telegram\n    profileId: default\n    adapter:\n      token: test-token\n`,
      "utf8",
    );

    await writeFile(
      tasksPath,
      `version: 1\ntasks:\n  - id: every-hour\n    enabled: true\n    botId: tg-main\n    chatId: "1001"\n    prompt: "Send an hourly report"\n    schedule:\n      type: interval\n      everySeconds: 3600\n      startAt: 2026-03-07T00:00:00.000Z\n`,
      "utf8",
    );

    const config = await loadConfig(configPath);
    const runs: string[] = [];
    const scheduler = new TaskScheduler({
      config,
      executorsByBotId: new Map([
        ["tg-main", {
          runScheduledTask: async (task) => {
            runs.push(task.id);
          },
        }],
      ]),
      logger: pino({ enabled: false }),
      pollIntervalMs: 50,
    });

    await scheduler.start();
    await waitFor(() => runs.length === 1);
    await scheduler.stop();

    const tasksFile = await readTasksSource(config.tasksPath);
    expect(tasksFile.tasks[0]?.lastStatus).toBe("success");
    expect(tasksFile.tasks[0]?.lastError).toBeUndefined();
    expect(tasksFile.tasks[0]?.lastRunAt).toMatch(/^202/);
    expect(tasksFile.tasks[0]?.nextRunAt).toMatch(/^202/);
  });
});
