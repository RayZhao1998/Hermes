import { z } from "zod";

const logLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);

const agentConfigSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().default("."),
  env: z.record(z.string(), z.string()).default({}),
  default: z.boolean().optional(),
});

export const hermesConfigSchema = z
  .object({
    app: z
      .object({
        logLevel: logLevelSchema.default("info"),
      })
      .default({ logLevel: "info" }),
    security: z
      .object({
        allowedChatIds: z.array(z.string()).default([]),
        allowedUserIds: z.array(z.string()).default([]),
      })
      .default({ allowedChatIds: [], allowedUserIds: [] }),
    telegram: z.object({
      enabled: z.boolean().default(true),
      tokenEnv: z.string().min(1).default("TELEGRAM_BOT_TOKEN"),
    }),
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
  });

export type HermesConfig = z.infer<typeof hermesConfigSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type LogLevel = z.infer<typeof logLevelSchema>;

export interface LoadedAgentConfig extends AgentConfig {
  cwd: string;
}

export interface LoadedHermesConfig {
  app: HermesConfig["app"];
  security: HermesConfig["security"];
  telegram: {
    enabled: boolean;
    tokenEnv: string;
    token: string;
  };
  agents: LoadedAgentConfig[];
  defaultAgentId: string;
  configPath: string;
}
