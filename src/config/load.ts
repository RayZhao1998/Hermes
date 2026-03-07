import { access, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { getHermesConfigPath } from "./paths.js";
import { type HermesConfig, type LoadedHermesConfig, hermesConfigSchema } from "./schema.js";

function resolveAgentCwd(runtimeCwd: string, cwd: string): string {
  return path.isAbsolute(cwd) ? cwd : path.resolve(runtimeCwd, cwd);
}

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
  runtimeCwd = process.cwd(),
): Promise<LoadedHermesConfig> {
  const parsed = await readConfigSource(configPath);
  const token = resolveTelegramToken(parsed, configPath);
  const agents = parsed.agents.map((agent) => ({
    ...agent,
    cwd: resolveAgentCwd(runtimeCwd, agent.cwd),
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
