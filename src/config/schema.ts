import { z } from "zod";
import type { McpServer } from "@agentclientprotocol/sdk";

const logLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);
const outputModeSchema = z.enum(["full", "text_only", "last_text"]);
const toolApprovalModeSchema = z.enum(["auto", "manual"]);
const envVariableSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
});
const httpHeaderSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
});
const mcpMetaSchema = z.record(z.string(), z.unknown()).nullable().optional();
const mcpServerHttpSchema = z.object({
  type: z.literal("http"),
  name: z.string().min(1),
  url: z.string().min(1),
  headers: z.array(httpHeaderSchema).default([]),
  _meta: mcpMetaSchema,
});
const mcpServerSseSchema = z.object({
  type: z.literal("sse"),
  name: z.string().min(1),
  url: z.string().min(1),
  headers: z.array(httpHeaderSchema).default([]),
  _meta: mcpMetaSchema,
});
const mcpServerStdioSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.array(envVariableSchema).default([]),
  _meta: mcpMetaSchema,
});
const mcpServerSchema = z.union([mcpServerHttpSchema, mcpServerSseSchema, mcpServerStdioSchema]) satisfies z.ZodType<McpServer>;

const agentConfigSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().default("."),
  env: z.record(z.string(), z.string()).default({}),
  mcpServers: z.array(mcpServerSchema).default([]),
  default: z.boolean().optional(),
});
const telegramConfigSchema = z.object({
  enabled: z.boolean().default(true),
  token: z.string().min(1, "Telegram token must not be empty.").optional(),
});

export const hermesConfigSchema = z
  .object({
    app: z
      .object({
        logLevel: logLevelSchema.default("info"),
        outputMode: outputModeSchema.default("full"),
      })
      .default({ logLevel: "info", outputMode: "full" }),
    security: z
      .object({
        allowedChatIds: z.array(z.string()).default([]),
        allowedUserIds: z.array(z.string()).default([]),
      })
      .default({ allowedChatIds: [], allowedUserIds: [] }),
    telegram: telegramConfigSchema,
    tools: z
      .object({
        approvalMode: toolApprovalModeSchema.default("auto"),
      })
      .default({ approvalMode: "auto" }),
    agents: z.array(agentConfigSchema).min(1, "At least one agent must be configured."),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    for (const agent of config.agents) {
      if (seen.has(agent.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agents"],
          message: `Duplicate agent id: ${agent.id}`,
        });
      }
      seen.add(agent.id);
    }

    if (config.telegram.enabled && !config.telegram.token) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["telegram"],
        message: "Telegram token must be configured when Telegram is enabled.",
      });
    }
  });

export type HermesConfig = z.infer<typeof hermesConfigSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type LogLevel = z.infer<typeof logLevelSchema>;
export type OutputMode = z.infer<typeof outputModeSchema>;
export type ToolApprovalMode = z.infer<typeof toolApprovalModeSchema>;

export interface LoadedAgentConfig extends AgentConfig {
  cwd: string;
}

export interface LoadedHermesConfig {
  app: HermesConfig["app"];
  security: HermesConfig["security"];
  telegram: {
    enabled: boolean;
    token: string;
  };
  tools: HermesConfig["tools"];
  agents: LoadedAgentConfig[];
  defaultAgentId: string;
  configPath: string;
}
