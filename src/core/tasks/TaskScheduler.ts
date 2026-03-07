import { CronExpressionParser } from "cron-parser";
import type { Logger } from "pino";
import type { LoadedHermesConfig } from "../../config/schema.js";
import { loadTasks, readTasksSource, writeTasksSource } from "../../config/tasks-load.js";
import type { ScheduledTaskConfig, TasksFileConfig } from "../../config/tasks-schema.js";

const DEFAULT_POLL_INTERVAL_MS = 1000;

export interface ScheduledTaskExecutor {
  runScheduledTask(task: ScheduledTaskConfig): Promise<void>;
}

interface TaskSchedulerOptions {
  config: LoadedHermesConfig;
  executorsByBotId: ReadonlyMap<string, ScheduledTaskExecutor>;
  logger: Logger;
  pollIntervalMs?: number;
}

function toDate(value: string): Date {
  return new Date(value);
}

function toIsoString(value?: Date): string | undefined {
  return value ? value.toISOString() : undefined;
}

function getNextCronRun(expression: string, currentDate: Date, timezone?: string): Date {
  return CronExpressionParser.parse(expression, {
    currentDate,
    tz: timezone,
  }).next().toDate();
}

function computeNextRunAt(task: ScheduledTaskConfig, now: Date): Date | undefined {
  if (!task.enabled) {
    return undefined;
  }

  switch (task.schedule.type) {
    case "once":
      if (task.lastRunAt) {
        return undefined;
      }
      return toDate(task.schedule.at);
    case "interval":
      if (task.lastRunAt) {
        return new Date(toDate(task.lastRunAt).getTime() + (task.schedule.everySeconds * 1000));
      }
      if (task.schedule.startAt) {
        return toDate(task.schedule.startAt);
      }
      return now;
    case "cron":
      if (task.lastRunAt) {
        return getNextCronRun(task.schedule.expression, toDate(task.lastRunAt), task.schedule.timezone);
      }
      return getNextCronRun(task.schedule.expression, now, task.schedule.timezone);
  }
}

function isTaskDue(task: ScheduledTaskConfig, now: Date): boolean {
  const nextRunAt = computeNextRunAt(task, now);
  return Boolean(nextRunAt && nextRunAt.getTime() <= now.getTime());
}

function updateTaskRuntime(task: ScheduledTaskConfig, now: Date): ScheduledTaskConfig {
  return {
    ...task,
    nextRunAt: toIsoString(computeNextRunAt(task, now)),
  };
}

export class TaskScheduler {
  private readonly config: LoadedHermesConfig;
  private readonly executorsByBotId: ReadonlyMap<string, ScheduledTaskExecutor>;
  private readonly logger: Logger;
  private readonly pollIntervalMs: number;
  private readonly runningTaskIds = new Set<string>();
  private readonly inflightRuns = new Set<Promise<void>>();
  private writeQueue = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private tickInFlight = false;

  constructor(options: TaskSchedulerOptions) {
    this.config = options.config;
    this.executorsByBotId = options.executorsByBotId;
    this.logger = options.logger;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  async start(): Promise<void> {
    const loaded = await loadTasks(this.config, this.config.tasksPath);
    await this.reconcileTaskFile(loaded.tasks);
    await this.tick();

    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    await Promise.allSettled([...this.inflightRuns]);
  }

  private async tick(): Promise<void> {
    if (this.tickInFlight) {
      return;
    }

    this.tickInFlight = true;
    try {
      const loaded = await loadTasks(this.config, this.config.tasksPath);
      const now = new Date();

      await this.reconcileTaskFile(loaded.tasks);

      for (const task of loaded.tasks) {
        if (!task.enabled || this.runningTaskIds.has(task.id) || !isTaskDue(task, now)) {
          continue;
        }
        this.launchTask(task);
      }
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: err }, "Task scheduler tick failed");
    } finally {
      this.tickInFlight = false;
    }
  }

  private launchTask(task: ScheduledTaskConfig): void {
    this.runningTaskIds.add(task.id);

    const runPromise = this.runTask(task)
      .catch(() => undefined)
      .finally(() => {
        this.runningTaskIds.delete(task.id);
        this.inflightRuns.delete(runPromise);
      });

    this.inflightRuns.add(runPromise);
  }

  private async runTask(task: ScheduledTaskConfig): Promise<void> {
    const executor = this.executorsByBotId.get(task.botId);
    if (!executor) {
      throw new Error(`Scheduled task '${task.id}' references missing executor for bot '${task.botId}'.`);
    }

    const startedAt = new Date();
    try {
      await executor.runScheduledTask(task);
      await this.updateTask(task.id, (current) => {
        const completed = {
          ...current,
          lastRunAt: startedAt.toISOString(),
          lastStatus: "success",
          lastError: undefined,
          lastSummary: `Delivered scheduled task '${current.id}' to chat '${current.chatId}'.`,
        } satisfies ScheduledTaskConfig;

        return updateTaskRuntime(completed, startedAt);
      });
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      await this.updateTask(task.id, (current) => {
        const failed = {
          ...current,
          lastRunAt: startedAt.toISOString(),
          lastStatus: "error",
          lastError: err,
          lastSummary: undefined,
        } satisfies ScheduledTaskConfig;

        return updateTaskRuntime(failed, startedAt);
      });
      throw error;
    }
  }

  private async reconcileTaskFile(tasks?: ScheduledTaskConfig[]): Promise<void> {
    const nextTasks = tasks;
    await this.withWriteLock(async () => {
      const current = await readTasksSource(this.config.tasksPath);
      const now = new Date();
      const sourceTasks = nextTasks ?? current.tasks;
      const normalizedTasks = sourceTasks.map((task) => updateTaskRuntime(task, now));

      if (!this.haveTaskRuntimeChanges(current.tasks, normalizedTasks)) {
        return;
      }

      const nextFile: TasksFileConfig = {
        ...current,
        tasks: normalizedTasks,
      };
      await writeTasksSource(this.config.tasksPath, nextFile);
    });
  }

  private haveTaskRuntimeChanges(current: ScheduledTaskConfig[], next: ScheduledTaskConfig[]): boolean {
    if (current.length !== next.length) {
      return true;
    }

    return current.some((task, index) => {
      const candidate = next[index];
      return task.id !== candidate?.id || task.nextRunAt !== candidate.nextRunAt;
    });
  }

  private async updateTask(
    taskId: string,
    updater: (task: ScheduledTaskConfig) => ScheduledTaskConfig,
  ): Promise<void> {
    await this.withWriteLock(async () => {
      const current = await readTasksSource(this.config.tasksPath);
      const taskIndex = current.tasks.findIndex((task) => task.id === taskId);
      if (taskIndex === -1) {
        this.logger.warn({ taskId }, "Skipping scheduled task state update because the task was removed");
        return;
      }

      const nextTasks = [...current.tasks];
      nextTasks[taskIndex] = updater(nextTasks[taskIndex]!);

      const nextFile: TasksFileConfig = {
        ...current,
        tasks: nextTasks,
      };
      await writeTasksSource(this.config.tasksPath, nextFile);
    });
  }

  private async withWriteLock<T>(action: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(action, action);
    this.writeQueue = next.then(() => undefined, () => undefined);
    return await next;
  }
}
