import os from "node:os";
import path from "node:path";

export const HERMES_CONFIG_DIRNAME = ".hermes";
export const HERMES_CONFIG_FILENAME = "config.yaml";

function resolveHomeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
}

export function getHermesConfigDir(homeDir = resolveHomeDir()): string {
  return path.join(homeDir, HERMES_CONFIG_DIRNAME);
}

export function getHermesConfigPath(homeDir = resolveHomeDir()): string {
  return path.join(getHermesConfigDir(homeDir), HERMES_CONFIG_FILENAME);
}
