import os from "node:os";
import path from "node:path";

export const HERMES_CONFIG_DIRNAME = ".hermes";
export const HERMES_CONFIG_FILENAME = "config.yaml";
export const HERMES_TASKS_FILENAME = "tasks.yaml";
export const HERMES_WORKSPACE_DIRNAME = "workspace";

function resolveHomeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
}

export function getHermesConfigDir(homeDir = resolveHomeDir()): string {
  return path.join(homeDir, HERMES_CONFIG_DIRNAME);
}

export function getHermesConfigPath(homeDir = resolveHomeDir()): string {
  return path.join(getHermesConfigDir(homeDir), HERMES_CONFIG_FILENAME);
}

export function getHermesTasksPath(homeDir = resolveHomeDir()): string {
  return path.join(getHermesConfigDir(homeDir), HERMES_TASKS_FILENAME);
}

export function getHermesWorkspaceDir(homeDir = resolveHomeDir()): string {
  return path.join(getHermesConfigDir(homeDir), HERMES_WORKSPACE_DIRNAME);
}
