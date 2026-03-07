import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CronExpressionParser } from "cron-parser";
import YAML from "yaml";
import type { LoadedHermesConfig } from "./schema.js";
import { getHermesTasksPath } from "./paths.js";
import {
  TASKS_FILE_VERSION,
  type LoadedTasksConfig,
  type ScheduledTaskConfig,
  type TasksFileConfig,
  tasksFileSchema,
} from "./tasks-schema.js";

function isValidDateString(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function validateTask(task: ScheduledTaskConfig, config: LoadedHermesConfig): void {
  const bot = config.bots.find((candidate) => candidate.id === task.botId);
  if (!bot) {
    throw new Error(`Task '${task.id}' references unknown bot '${task.botId}'.`);
  }

  const agentId = task.agentId ?? bot.profile.defaultAgentId;
  if (!bot.profile.agents.some((agent) => agent.id === agentId)) {
    throw new Error(`Task '${task.id}' references unknown agent '${agentId}' for bot '${bot.id}'.`);
  }

  const workspaceId = task.workspaceId ?? bot.defaultWorkspaceId;
  if (!config.workspaces.some((workspace) => workspace.id === workspaceId)) {
    throw new Error(`Task '${task.id}' references unknown workspace '${workspaceId}'.`);
  }

  if (task.nextRunAt && !isValidDateString(task.nextRunAt)) {
    throw new Error(`Task '${task.id}' has invalid nextRunAt '${task.nextRunAt}'.`);
  }
  if (task.lastRunAt && !isValidDateString(task.lastRunAt)) {
    throw new Error(`Task '${task.id}' has invalid lastRunAt '${task.lastRunAt}'.`);
  }

  switch (task.schedule.type) {
    case "once":
      if (!isValidDateString(task.schedule.at)) {
        throw new Error(`Task '${task.id}' has invalid schedule.at '${task.schedule.at}'.`);
      }
      return;
    case "interval":
      if (task.schedule.startAt && !isValidDateString(task.schedule.startAt)) {
        throw new Error(`Task '${task.id}' has invalid schedule.startAt '${task.schedule.startAt}'.`);
      }
      return;
    case "cron":
      if (task.schedule.timezone && !isValidTimeZone(task.schedule.timezone)) {
        throw new Error(`Task '${task.id}' has invalid timezone '${task.schedule.timezone}'.`);
      }
      try {
        CronExpressionParser.parse(task.schedule.expression, {
          currentDate: new Date(),
          tz: task.schedule.timezone,
        });
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        throw new Error(`Task '${task.id}' has invalid cron expression '${task.schedule.expression}': ${err}`);
      }
      return;
  }
}

function validateTasks(tasksFile: TasksFileConfig, config: LoadedHermesConfig): void {
  const seen = new Set<string>();
  for (const task of tasksFile.tasks) {
    if (seen.has(task.id)) {
      throw new Error(`Duplicate task id '${task.id}'.`);
    }
    seen.add(task.id);
    validateTask(task, config);
  }
}

function getDefaultTasksFile(): TasksFileConfig {
  return {
    version: TASKS_FILE_VERSION,
    tasks: [],
  };
}

export async function tasksFileExists(tasksPath = getHermesTasksPath()): Promise<boolean> {
  try {
    await access(tasksPath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureTasksFile(tasksPath = getHermesTasksPath()): Promise<void> {
  await mkdir(path.dirname(tasksPath), { recursive: true, mode: 0o700 });

  if (await tasksFileExists(tasksPath)) {
    return;
  }

  await writeFile(tasksPath, YAML.stringify(getDefaultTasksFile(), { lineWidth: 0 }), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function readTasksSource(tasksPath = getHermesTasksPath()): Promise<TasksFileConfig> {
  await ensureTasksFile(tasksPath);
  const raw = await readFile(tasksPath, "utf8");
  const parsedYaml = YAML.parse(raw) ?? {};
  return tasksFileSchema.parse(parsedYaml);
}

export async function writeTasksSource(tasksPath: string, tasksFile: TasksFileConfig): Promise<void> {
  await ensureTasksFile(tasksPath);
  await writeFile(tasksPath, YAML.stringify(tasksFile, { lineWidth: 0 }), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function loadTasks(
  config: LoadedHermesConfig,
  tasksPath = getHermesTasksPath(),
): Promise<LoadedTasksConfig> {
  const parsed = await readTasksSource(tasksPath);
  validateTasks(parsed, config);

  return {
    version: parsed.version,
    tasks: parsed.tasks,
    tasksPath,
  };
}
