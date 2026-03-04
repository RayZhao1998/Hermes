import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { type LoadedHermesConfig, hermesConfigSchema } from "./schema.js";

function resolveAgentCwd(configDir: string, cwd: string): string {
  return path.isAbsolute(cwd) ? cwd : path.resolve(configDir, cwd);
}

function pickDefaultAgentId(agents: Array<{ id: string; default?: boolean }>): string {
  const explicit = agents.find((agent) => agent.default);
  return explicit?.id ?? agents[0].id;
}

export async function loadConfig(configPath = path.resolve(process.cwd(), "hermes.config.yaml")): Promise<LoadedHermesConfig> {
  const raw = await readFile(configPath, "utf8");
  const parsedYaml = YAML.parse(raw);
  const parsed = hermesConfigSchema.parse(parsedYaml);

  const token = process.env[parsed.telegram.tokenEnv] ?? "";
  if (parsed.telegram.enabled && !token) {
    throw new Error(`Missing Telegram token in env var ${parsed.telegram.tokenEnv}`);
  }

  const configDir = path.dirname(configPath);
  const agents = parsed.agents.map((agent) => ({
    ...agent,
    cwd: resolveAgentCwd(configDir, agent.cwd),
  }));

  return {
    app: parsed.app,
    security: parsed.security,
    telegram: {
      enabled: parsed.telegram.enabled,
      tokenEnv: parsed.telegram.tokenEnv,
      token,
    },
    agents,
    defaultAgentId: pickDefaultAgentId(agents),
    configPath,
  };
}
