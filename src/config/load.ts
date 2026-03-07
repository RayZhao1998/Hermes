import os from "node:os";
import path from "node:path";
import { access, mkdir, readFile } from "node:fs/promises";
import YAML from "yaml";
import { getHermesConfigPath, getHermesWorkspaceDir, HERMES_TASKS_FILENAME } from "./paths.js";
import {
  type AgentConfig,
  type HermesConfig,
  type LoadedAgentConfig,
  type LoadedBotConfig,
  type LoadedHermesConfig,
  type LoadedProfileConfig,
  type LoadedWorkspaceConfig,
  DEFAULT_WORKSPACE_ID,
  hermesConfigSchema,
} from "./schema.js";

function indexById<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

function indexByName<T extends { name: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.name, item]));
}

function toLoadedAgents(agents: AgentConfig[], workspaceDir: string): LoadedAgentConfig[] {
  return agents.map((agent) => ({
    ...agent,
    cwd: workspaceDir,
  }));
}

function resolveProfiles(config: HermesConfig, workspaceDir: string): LoadedProfileConfig[] {
  const agentsById = indexById(config.agents);
  const mcpServersByName = indexByName(config.mcpServers);

  return config.profiles.map((profile) => {
    const enabledAgentIds = profile.enabledAgentIds ?? config.agents.map((agent) => agent.id);
    const agents = toLoadedAgents(
      enabledAgentIds.map((agentId) => {
        const agent = agentsById.get(agentId);
        if (!agent) {
          throw new Error(`Profile '${profile.id}' references unknown agent '${agentId}'.`);
        }
        return agent;
      }),
      workspaceDir,
    );

    return {
      id: profile.id,
      defaultAgentId: profile.defaultAgentId,
      outputMode: profile.outputMode,
      tools: profile.tools,
      agents,
      mcpServers: profile.mcpServerNames.map((name) => {
        const server = mcpServersByName.get(name);
        if (!server) {
          throw new Error(`Profile '${profile.id}' references unknown MCP server '${name}'.`);
        }
        return server;
      }),
    };
  });
}

function resolveBots(config: HermesConfig, profiles: LoadedProfileConfig[]): LoadedBotConfig[] {
  const profilesById = indexById(profiles);

  return config.bots.map((bot) => {
    const profile = profilesById.get(bot.profileId);
    if (!profile) {
      throw new Error(`Bot '${bot.id}' references unknown profile '${bot.profileId}'.`);
    }

    return {
      ...bot,
      access: {
        allowChats: bot.access.allowChats,
        allowUsers: bot.access.allowUsers,
      },
      profile,
    };
  });
}

function expandWorkspacePath(workspacePath: string): string {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  if (workspacePath === "~") {
    return homeDir;
  }

  if (workspacePath.startsWith("~/") || workspacePath.startsWith("~\\")) {
    if (!homeDir) {
      throw new Error(`Cannot expand workspace path '${workspacePath}' without a home directory.`);
    }
    return path.join(homeDir, workspacePath.slice(2));
  }

  return workspacePath;
}

function resolveWorkspaces(config: HermesConfig, defaultWorkspaceDir: string): LoadedWorkspaceConfig[] {
  const workspaces = config.workspaces.map((workspace) => {
    const resolvedPath = expandWorkspacePath(workspace.path);
    if (!path.isAbsolute(resolvedPath)) {
      throw new Error(`Workspace '${workspace.id}' must use an absolute path.`);
    }

    return {
      id: workspace.id,
      path: resolvedPath,
    };
  });

  return [
    {
      id: DEFAULT_WORKSPACE_ID,
      path: defaultWorkspaceDir,
    },
    ...workspaces,
  ];
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
  const workspaceDir = getHermesWorkspaceDir();
  await mkdir(workspaceDir, { recursive: true, mode: 0o700 });

  const workspaces = resolveWorkspaces(parsed, workspaceDir);
  const profiles = resolveProfiles(parsed, workspaceDir);
  const bots = resolveBots(parsed, profiles);

  return {
    app: parsed.app,
    workspaces,
    profiles,
    bots,
    configPath,
    tasksPath: path.join(path.dirname(configPath), HERMES_TASKS_FILENAME),
  };
}
