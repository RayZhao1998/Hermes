import { z } from "zod";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { AccessControlConfig } from "../core/security/isAuthorized.js";

const logLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);
const outputModeSchema = z.enum(["full", "text_only", "last_text"]);
const toolApprovalModeSchema = z.enum(["auto", "manual"]);
const channelSchema = z.enum(["telegram", "discord"]);

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

const mcpServerSchema =
  z.union([mcpServerHttpSchema, mcpServerSseSchema, mcpServerStdioSchema]) satisfies z.ZodType<McpServer>;

const agentConfigSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
}).strict();

const toolConfigSchema = z.object({
  approvalMode: toolApprovalModeSchema.default("auto"),
}).strict().default({ approvalMode: "auto" });

const profileConfigSchema = z.object({
  id: z.string().min(1),
  defaultAgentId: z.string().min(1),
  enabledAgentIds: z.array(z.string().min(1)).optional(),
  mcpServerNames: z.array(z.string().min(1)).default([]),
  outputMode: outputModeSchema.default("full"),
  tools: toolConfigSchema,
}).strict();

const accessControlSchema = z.object({
  allowChats: z.array(z.string()).default([]),
  allowUsers: z.array(z.string()).default([]),
}).strict().default({ allowChats: [], allowUsers: [] });

const botBaseSchema = z.object({
  id: z.string().min(1),
  profileId: z.string().min(1),
  enabled: z.boolean().default(true),
  access: accessControlSchema,
}).strict();

const telegramBotConfigSchema = botBaseSchema.extend({
  channel: z.literal("telegram"),
  adapter: z.object({
    token: z.string().min(1, "Telegram token must not be empty."),
    mode: z.literal("polling").default("polling"),
  }).strict(),
}).strict();

const discordBotConfigSchema = botBaseSchema.extend({
  channel: z.literal("discord"),
  adapter: z.object({
    token: z.string().min(1, "Discord token must not be empty."),
    applicationId: z.string().min(1).optional(),
  }).strict(),
}).strict();

const botConfigSchema = z.discriminatedUnion("channel", [
  telegramBotConfigSchema,
  discordBotConfigSchema,
]);

function addDuplicateIssue(
  values: string[],
  path: Array<string | number>,
  label: string,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: `Duplicate ${label}: ${value}`,
      });
      return;
    }
    seen.add(value);
  }
}

export const hermesConfigSchema = z
  .object({
    app: z.object({
      logLevel: logLevelSchema.default("info"),
    }).strict().default({ logLevel: "info" }),
    agents: z.array(agentConfigSchema).min(1, "At least one agent must be configured."),
    mcpServers: z.array(mcpServerSchema).default([]),
    profiles: z.array(profileConfigSchema).min(1, "At least one profile must be configured."),
    bots: z.array(botConfigSchema).min(1, "At least one bot must be configured."),
  })
  .strict()
  .superRefine((config, ctx) => {
    addDuplicateIssue(config.agents.map((agent) => agent.id), ["agents"], "agent id", ctx);
    addDuplicateIssue(config.mcpServers.map((server) => server.name), ["mcpServers"], "MCP server name", ctx);
    addDuplicateIssue(config.profiles.map((profile) => profile.id), ["profiles"], "profile id", ctx);
    addDuplicateIssue(config.bots.map((bot) => bot.id), ["bots"], "bot id", ctx);

    const agentIds = new Set(config.agents.map((agent) => agent.id));
    const mcpServerNames = new Set(config.mcpServers.map((server) => server.name));
    const profileIds = new Set(config.profiles.map((profile) => profile.id));

    for (const [index, profile] of config.profiles.entries()) {
      const enabledAgentIds = profile.enabledAgentIds ?? config.agents.map((agent) => agent.id);
      if (enabledAgentIds.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["profiles", index, "enabledAgentIds"],
          message: `Profile '${profile.id}' must enable at least one agent.`,
        });
      }

      addDuplicateIssue(enabledAgentIds, ["profiles", index, "enabledAgentIds"], "enabled agent id", ctx);

      if (!agentIds.has(profile.defaultAgentId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["profiles", index, "defaultAgentId"],
          message: `Profile '${profile.id}' references unknown agent '${profile.defaultAgentId}'.`,
        });
      }

      if (!enabledAgentIds.includes(profile.defaultAgentId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["profiles", index, "defaultAgentId"],
          message: `Profile '${profile.id}' default agent '${profile.defaultAgentId}' must be enabled.`,
        });
      }

      for (const agentId of enabledAgentIds) {
        if (!agentIds.has(agentId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["profiles", index, "enabledAgentIds"],
            message: `Profile '${profile.id}' references unknown agent '${agentId}'.`,
          });
        }
      }

      addDuplicateIssue(profile.mcpServerNames, ["profiles", index, "mcpServerNames"], "MCP server name", ctx);
      for (const name of profile.mcpServerNames) {
        if (!mcpServerNames.has(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["profiles", index, "mcpServerNames"],
            message: `Profile '${profile.id}' references unknown MCP server '${name}'.`,
          });
        }
      }

      if (profile.outputMode !== "full" && profile.tools.approvalMode !== "auto") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["profiles", index],
          message: `Profile '${profile.id}' requires outputMode=full when tools.approvalMode=manual.`,
        });
      }
    }

    for (const [index, bot] of config.bots.entries()) {
      if (!profileIds.has(bot.profileId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["bots", index, "profileId"],
          message: `Bot '${bot.id}' references unknown profile '${bot.profileId}'.`,
        });
      }
    }
  });

export type HermesConfig = z.infer<typeof hermesConfigSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type ProfileConfig = z.infer<typeof profileConfigSchema>;
export type BotConfig = z.infer<typeof botConfigSchema>;
export type TelegramBotConfig = z.infer<typeof telegramBotConfigSchema>;
export type DiscordBotConfig = z.infer<typeof discordBotConfigSchema>;
export type LogLevel = z.infer<typeof logLevelSchema>;
export type OutputMode = z.infer<typeof outputModeSchema>;
export type ToolApprovalMode = z.infer<typeof toolApprovalModeSchema>;
export type Channel = z.infer<typeof channelSchema>;

export interface LoadedAgentConfig extends AgentConfig {
  cwd: string;
}

export interface LoadedProfileConfig {
  id: string;
  defaultAgentId: string;
  outputMode: OutputMode;
  tools: {
    approvalMode: ToolApprovalMode;
  };
  agents: LoadedAgentConfig[];
  mcpServers: McpServer[];
}

interface LoadedBotConfigBase {
  id: string;
  profileId: string;
  enabled: boolean;
  access: AccessControlConfig;
  profile: LoadedProfileConfig;
}

export interface LoadedTelegramBotConfig extends LoadedBotConfigBase {
  channel: "telegram";
  adapter: {
    token: string;
    mode: "polling";
  };
}

export interface LoadedDiscordBotConfig extends LoadedBotConfigBase {
  channel: "discord";
  adapter: {
    token: string;
    applicationId?: string;
  };
}

export type LoadedBotConfig = LoadedTelegramBotConfig | LoadedDiscordBotConfig;

export interface LoadedHermesConfig {
  app: HermesConfig["app"];
  profiles: LoadedProfileConfig[];
  bots: LoadedBotConfig[];
  configPath: string;
}
