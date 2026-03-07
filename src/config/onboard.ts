import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import {
  cancel,
  intro,
  isCancel,
  note,
  outro,
  password,
  select,
  text,
} from "@clack/prompts";
import YAML from "yaml";
import type {
  AgentConfig,
  HermesConfig,
  LogLevel,
  OutputMode,
  ProfileConfig,
  ToolApprovalMode,
} from "./schema.js";
import { getHermesConfigPath, getHermesWorkspaceDir } from "./paths.js";
import { readConfigSource } from "./load.js";

interface OnboardOptions {
  configPath?: string;
}

type ExistingConfig = HermesConfig | undefined;

interface SupportedAgentCandidate {
  args: string[];
  command: string;
}

interface SupportedAgentDefinition {
  candidates: SupportedAgentCandidate[];
  id: string;
  label: string;
}

interface DetectedSupportedAgent {
  agent: AgentConfig;
  binaryPath: string;
  label: string;
}

const DEFAULT_PROFILE_ID = "default";
const DEFAULT_BOT_ID = "telegram-main";

const SUPPORTED_AGENT_DEFINITIONS: SupportedAgentDefinition[] = [
  {
    id: "kimi",
    label: "Kimi ACP",
    candidates: [
      { command: "kimi", args: ["acp"] },
      { command: "kimi-cli", args: ["acp"] },
    ],
  },
  {
    id: "codex",
    label: "Codex ACP",
    candidates: [{ command: "codex-acp", args: [] }],
  },
  {
    id: "claude",
    label: "Claude Code ACP",
    candidates: [
      { command: "claude-agent-acp", args: [] },
      { command: "claude-code-acp", args: [] },
    ],
  },
];

function unwrapPrompt<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Hermes onboarding cancelled.");
    process.exit(0);
  }

  return value;
}

function parseList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseStringArray(value: string, label: string): string[] {
  if (!value.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      throw new Error();
    }

    return parsed;
  } catch {
    throw new Error(`${label} must be a JSON string array.`);
  }
}

function parseStringRecord(value: string, label: string): Record<string, string> {
  if (!value.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !Object.values(parsed).every((item) => typeof item === "string")
    ) {
      throw new Error();
    }

    return parsed as Record<string, string>;
  } catch {
    throw new Error(`${label} must be a JSON object with string values.`);
  }
}

function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function matchesSupportedAgent(agent: AgentConfig, definition: SupportedAgentDefinition): boolean {
  return agent.id === definition.id || definition.candidates.some((candidate) => candidate.command === agent.command);
}

function getExecutableExtensions(): string[] {
  if (process.platform !== "win32") {
    return [""];
  }

  const rawExtensions = process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM";
  return rawExtensions.split(";").filter(Boolean);
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findExecutable(command: string): Promise<string | undefined> {
  const candidates = command.includes(path.sep) ? [command] : [];
  if (candidates.length === 0) {
    const pathDirectories = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    const extensions = getExecutableExtensions();
    for (const directory of pathDirectories) {
      for (const extension of extensions) {
        const needsExtension = process.platform === "win32" && path.extname(command) === "";
        candidates.push(path.join(directory, needsExtension ? `${command}${extension}` : command));
      }
    }
  }

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function mergeWithExistingAgent(detected: AgentConfig, existing: AgentConfig | undefined): AgentConfig {
  return {
    ...detected,
    id: existing?.id ?? detected.id,
    env: existing?.env ?? {},
  };
}

function buildSupportedAgentSummary(detectedAgents: DetectedSupportedAgent[]): string {
  if (detectedAgents.length === 0) {
    return "No supported ACP agents were found in PATH. You can configure one manually below.";
  }

  return detectedAgents
    .map((agent) => `- ${agent.label}: ${agent.agent.command}${agent.agent.args.length > 0 ? ` ${agent.agent.args.join(" ")}` : ""}`)
    .join("\n");
}

async function maybeReadExistingConfig(configPath: string): Promise<ExistingConfig> {
  try {
    return await readConfigSource(configPath);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

function getExistingTelegramBot(config: ExistingConfig) {
  return config?.bots.find((bot) => bot.channel === "telegram");
}

function getExistingProfile(config: ExistingConfig, profileId: string | undefined): ProfileConfig | undefined {
  if (!config) {
    return undefined;
  }

  if (profileId) {
    return config.profiles.find((profile) => profile.id === profileId);
  }

  return config.profiles[0];
}

function assertSupportedExistingConfig(config: ExistingConfig): void {
  if (!config) {
    return;
  }

  if (config.profiles.length > 1 || config.bots.length > 1) {
    throw new Error("Onboarding only supports a single profile and a single bot. Edit config.yaml manually.");
  }
}

export async function detectSupportedAgents(existingAgents: AgentConfig[] = []): Promise<DetectedSupportedAgent[]> {
  const detectedAgents: DetectedSupportedAgent[] = [];
  for (const definition of SUPPORTED_AGENT_DEFINITIONS) {
    for (const candidate of definition.candidates) {
      const binaryPath = await findExecutable(candidate.command);
      if (!binaryPath) {
        continue;
      }

      const existing = existingAgents.find((agent) => matchesSupportedAgent(agent, definition));
      const agent = mergeWithExistingAgent(
        {
          id: definition.id,
          command: candidate.command,
          args: candidate.args,
          env: {},
        },
        existing,
      );

      detectedAgents.push({
        agent,
        binaryPath,
        label: definition.label,
      });
      break;
    }
  }

  return detectedAgents;
}

async function promptManualAgent(existingAgent: AgentConfig | undefined, reservedIds: Set<string>): Promise<AgentConfig> {
  const suggestedId = existingAgent?.id ?? "default";
  const id = unwrapPrompt(
    await text({
      message: "Agent ID",
      initialValue: suggestedId,
      validate(value) {
        if (!value?.trim()) {
          return "Agent ID is required.";
        }

        if (reservedIds.has(value.trim())) {
          return "Agent ID must be unique.";
        }
      },
    }),
  ).trim();

  const command = unwrapPrompt(
    await text({
      message: "Agent command",
      initialValue: existingAgent?.command ?? "",
      placeholder: "codex-acp",
      validate(value) {
        if (!value?.trim()) {
          return "Agent command is required.";
        }
      },
    }),
  ).trim();

  const argsInput = unwrapPrompt(
    await text({
      message: "Agent args (JSON array)",
      initialValue: toJson(existingAgent?.args ?? []),
      placeholder: "[\"acp\"]",
      validate(value) {
        try {
          parseStringArray(value ?? "", "Agent args");
        } catch (error) {
          return error instanceof Error ? error.message : "Invalid JSON array.";
        }
      },
    }),
  );

  const envInput = unwrapPrompt(
    await text({
      message: "Agent env (JSON object)",
      initialValue: toJson(existingAgent?.env ?? {}),
      placeholder: "{\"NODE_ENV\": \"production\"}",
      validate(value) {
        try {
          parseStringRecord(value ?? "", "Agent env");
        } catch (error) {
          return error instanceof Error ? error.message : "Invalid JSON object.";
        }
      },
    }),
  );

  return {
    id,
    command,
    args: parseStringArray(argsInput, "Agent args"),
    env: parseStringRecord(envInput, "Agent env"),
  };
}

async function resolveOnboardingAgents(existingAgents: AgentConfig[]): Promise<{
  agents: AgentConfig[];
  detectedAgents: DetectedSupportedAgent[];
}> {
  const detectedAgents = await detectSupportedAgents(existingAgents);
  if (detectedAgents.length > 0) {
    const matchedExistingAgentIds = new Set(
      detectedAgents
        .map((detectedAgent) =>
          existingAgents.find((existingAgent) => existingAgent.id === detectedAgent.agent.id || existingAgent.command === detectedAgent.agent.command)?.id,
        )
        .filter((id): id is string => Boolean(id)),
    );

    const preservedExistingAgents = existingAgents.filter((agent) => !matchedExistingAgentIds.has(agent.id));
    return {
      agents: [...detectedAgents.map((detectedAgent) => detectedAgent.agent), ...preservedExistingAgents],
      detectedAgents,
    };
  }

  return {
    agents: [await promptManualAgent(existingAgents[0], new Set())],
    detectedAgents,
  };
}

function pickDefaultAgentId(agents: AgentConfig[], existingDefaultAgentId: string | undefined): string {
  if (agents.length === 1) {
    return agents[0].id;
  }

  return existingDefaultAgentId && agents.some((agent) => agent.id === existingDefaultAgentId)
    ? existingDefaultAgentId
    : agents[0].id;
}

function buildConfig(params: {
  allowChats: string[];
  allowUsers: string[];
  agents: AgentConfig[];
  defaultAgentId: string;
  logLevel: LogLevel;
  outputMode: OutputMode;
  profileId: string;
  botId: string;
  telegramToken: string;
  toolApprovalMode: ToolApprovalMode;
  mcpServers: HermesConfig["mcpServers"];
}): HermesConfig {
  return {
    app: {
      logLevel: params.logLevel,
    },
    agents: params.agents,
    mcpServers: params.mcpServers,
    profiles: [
      {
        id: params.profileId,
        defaultAgentId: params.defaultAgentId,
        enabledAgentIds: params.agents.map((agent) => agent.id),
        mcpServerNames: params.mcpServers.map((server) => server.name),
        outputMode: params.outputMode,
        tools: {
          approvalMode: params.toolApprovalMode,
        },
      },
    ],
    bots: [
      {
        id: params.botId,
        channel: "telegram",
        profileId: params.profileId,
        enabled: true,
        access: {
          allowChats: params.allowChats,
          allowUsers: params.allowUsers,
        },
        adapter: {
          token: params.telegramToken,
          mode: "polling",
        },
      },
    ],
  };
}

async function writeConfigFile(configPath: string, config: HermesConfig): Promise<void> {
  const configDir = path.dirname(configPath);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(configPath, YAML.stringify(config, { lineWidth: 0 }), { encoding: "utf8", mode: 0o600 });

  await Promise.all([
    chmod(configDir, 0o700).catch(() => undefined),
    chmod(configPath, 0o600).catch(() => undefined),
  ]);
}

export async function runOnboarding(options: OnboardOptions = {}): Promise<string> {
  const configPath = options.configPath ?? getHermesConfigPath();
  const workspaceDir = getHermesWorkspaceDir();
  const existing = await maybeReadExistingConfig(configPath);
  assertSupportedExistingConfig(existing);

  const existingBot = getExistingTelegramBot(existing) ?? existing?.bots[0];
  const existingProfile = getExistingProfile(existing, existingBot?.profileId);
  const existingToken = existingBot?.channel === "telegram" ? existingBot.adapter.token : "";
  const existingProfileId = existingProfile?.id ?? DEFAULT_PROFILE_ID;
  const existingBotId = existingBot?.id ?? DEFAULT_BOT_ID;

  const { agents, detectedAgents } = await resolveOnboardingAgents(existing?.agents ?? []);

  intro("Hermes onboarding");
  note(
    [
      `Config path: ${configPath}`,
      `Agent workspace: ${workspaceDir}`,
      "This flow sets up one Telegram bot, one profile, and ACP agents.",
      "Agent working directory is fixed to the Hermes workspace.",
    ].join("\n"),
    "Setup",
  );
  note(buildSupportedAgentSummary(detectedAgents), "ACP Agents");

  const telegramTokenInput = unwrapPrompt(
    await password({
      message: existingToken
        ? "Telegram bot token (leave blank to keep current token)"
        : "Telegram bot token",
      validate(value) {
        if (!existingToken && !value?.trim()) {
          return "Telegram bot token is required.";
        }
      },
    }),
  );
  const telegramToken = telegramTokenInput.trim() || existingToken;

  const allowedChatIdsInput = unwrapPrompt(
    await text({
      message: "Allowed chat IDs (comma or newline separated)",
      initialValue: (existingBot?.access.allowChats ?? []).join(", "),
      placeholder: "telegram:123456789",
    }),
  );

  const allowedUserIdsInput = unwrapPrompt(
    await text({
      message: "Allowed user IDs (comma or newline separated)",
      initialValue: (existingBot?.access.allowUsers ?? []).join(", "),
      placeholder: "telegram:987654321",
    }),
  );

  const logLevel = unwrapPrompt(
    await select<LogLevel>({
      message: "Log level",
      initialValue: existing?.app.logLevel ?? "info",
      options: [
        { value: "trace", label: "trace" },
        { value: "debug", label: "debug" },
        { value: "info", label: "info" },
        { value: "warn", label: "warn" },
        { value: "error", label: "error" },
        { value: "fatal", label: "fatal" },
      ],
    }),
  );

  const toolApprovalMode = unwrapPrompt(
    await select<ToolApprovalMode>({
      message: "Tool approval mode",
      initialValue: existingProfile?.tools.approvalMode ?? "auto",
      options: [
        { value: "auto", label: "auto", hint: "approve tools automatically" },
        { value: "manual", label: "manual", hint: "approve tools in chat" },
      ],
    }),
  );

  const initialOutputMode =
    toolApprovalMode === "manual" && existingProfile?.outputMode !== "full"
      ? "full"
      : existingProfile?.outputMode ?? "full";

  const outputMode = unwrapPrompt(
    await select<OutputMode>({
      message: "Output mode",
      initialValue: initialOutputMode,
      options: toolApprovalMode === "manual"
        ? [
            { value: "full", label: "full", hint: "required when tool approval mode is manual" },
          ]
        : [
            { value: "full", label: "full", hint: "show text and tool call updates" },
            { value: "text_only", label: "text_only", hint: "show only agent text output" },
            { value: "last_text", label: "last_text", hint: "show only the final text for each turn" },
          ],
    }),
  );

  const defaultAgentId =
    agents.length === 1
      ? agents[0].id
      : unwrapPrompt(
          await select<string>({
            message: "Default agent",
            initialValue: pickDefaultAgentId(agents, existingProfile?.defaultAgentId),
            options: agents.map((agent) => ({
              value: agent.id,
              label: agent.id,
              hint: `${agent.command}${agent.args.length > 0 ? ` ${agent.args.join(" ")}` : ""}`,
            })),
          }),
        );

  const config = buildConfig({
    allowChats: parseList(allowedChatIdsInput),
    allowUsers: parseList(allowedUserIdsInput),
    agents,
    defaultAgentId,
    logLevel,
    outputMode,
    profileId: existingProfileId,
    botId: existingBotId,
    telegramToken,
    toolApprovalMode,
    mcpServers: existing?.mcpServers ?? [],
  });

  await writeConfigFile(configPath, config);
  outro(`Hermes config saved to ${configPath}`);
  return configPath;
}
