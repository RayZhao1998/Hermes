import { z } from "zod";

export const TASKS_FILE_VERSION = 1;

const taskRunStatusSchema = z.enum(["success", "error"]);
const dateValueSchema = z.union([z.string().min(1), z.date()]).transform((value) =>
  value instanceof Date ? value.toISOString() : value
);

const onceTaskScheduleSchema = z.object({
  type: z.literal("once"),
  at: dateValueSchema,
}).strict();

const intervalTaskScheduleSchema = z.object({
  type: z.literal("interval"),
  everySeconds: z.number().int().positive(),
  startAt: dateValueSchema.optional(),
}).strict();

const cronTaskScheduleSchema = z.object({
  type: z.literal("cron"),
  expression: z.string().min(1),
  timezone: z.string().min(1).optional(),
}).strict();

export const scheduledTaskScheduleSchema = z.discriminatedUnion("type", [
  onceTaskScheduleSchema,
  intervalTaskScheduleSchema,
  cronTaskScheduleSchema,
]);

export const scheduledTaskSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  botId: z.string().min(1),
  chatId: z.string().min(1),
  agentId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  prompt: z.string().min(1),
  schedule: scheduledTaskScheduleSchema,
  nextRunAt: dateValueSchema.optional(),
  lastRunAt: dateValueSchema.optional(),
  lastStatus: taskRunStatusSchema.optional(),
  lastError: z.string().optional(),
  lastSummary: z.string().optional(),
}).strict();

export const tasksFileSchema = z.object({
  version: z.literal(TASKS_FILE_VERSION).default(TASKS_FILE_VERSION),
  tasks: z.array(scheduledTaskSchema).default([]),
}).strict();

export type ScheduledTaskSchedule = z.infer<typeof scheduledTaskScheduleSchema>;
export type ScheduledTaskConfig = z.infer<typeof scheduledTaskSchema>;
export type ScheduledTaskRunStatus = z.infer<typeof taskRunStatusSchema>;
export type TasksFileConfig = z.infer<typeof tasksFileSchema>;

export interface LoadedTasksConfig {
  version: typeof TASKS_FILE_VERSION;
  tasks: ScheduledTaskConfig[];
  tasksPath: string;
}
