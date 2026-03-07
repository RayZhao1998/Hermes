import { access, mkdir, readFile } from "node:fs/promises";
import YAML from "yaml";
import { getHermesConfigPath, getHermesWorkspaceDir } from "./paths.js";
import { type HermesConfig, type LoadedHermesConfig, hermesConfigSchema } from "./schema.js";

function pickDefaultAgentId(agents: Array<{ id: string; default?: boolean }>): string {
  const explicit = agents.find((agent) => agent.default);
  return explicit?.id ?? agents[0].id;
}

function resolveTelegramToken(config: HermesConfig, configPath: string): string {
  if (!config.telegram.enabled) {
    return "";
  }

  if (config.telegram.token) {
    return config.telegram.token;
  }

  const token = process.env[config.telegram.tokenEnv] ?? "";
  if (!token) {
    throw new Error(`Missing Telegram token in config or env var ${config.telegram.tokenEnv} (${configPath})`);
  }

  return token;
}

function validateRuntimeConfig(config: HermesConfig, configPath: string): void {
  if (config.app.outputMode !== "full" && config.tools.approvalMode !== "auto") {
    throw new Error(
      `Invalid config: app.outputMode=${config.app.outputMode} requires tools.approvalMode=auto (${configPath})`,
    );
  }
}

export async function configExists(configPath = getHermesConfigPath()): Promise<boolean> {
  try {
    await access(configPath);
    return true;
  } catch {
    return false;
  }
}

export async function readConfigSource(configPath = getHermesConfigPath()): Promise<HermesConfig> {
  const raw = await readFile(configPath, "utf8");
  const parsedYaml = YAML.parse(raw);
  return hermesConfigSchema.parse(parsedYaml);
}

export async function loadConfig(
  configPath = getHermesConfigPath(),
): Promise<LoadedHermesConfig> {
  const parsed = await readConfigSource(configPath);
  validateRuntimeConfig(parsed, configPath);
  const token = resolveTelegramToken(parsed, configPath);
  const workspaceDir = getHermesWorkspaceDir();
  await mkdir(workspaceDir, { recursive: true, mode: 0o700 });
  const agents = parsed.agents.map((agent) => ({
    ...agent,
    cwd: workspaceDir,
  }));

  return {
    app: parsed.app,
    security: parsed.security,
    telegram: {
      enabled: parsed.telegram.enabled,
      tokenEnv: parsed.telegram.tokenEnv,
      token,
    },
    tools: parsed.tools,
    agents,
    defaultAgentId: pickDefaultAgentId(agents),
    configPath,
  };
}
