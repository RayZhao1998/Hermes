#!/usr/bin/env node

import "dotenv/config";
import { configExists } from "./config/load.js";
import { runOnboarding } from "./config/onboard.js";
import { getHermesConfigPath } from "./config/paths.js";
import { startHermes } from "./main.js";

function isInteractiveShell(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function ensureConfig(configPath: string): Promise<void> {
  if (await configExists(configPath)) {
    return;
  }

  if (!isInteractiveShell()) {
    throw new Error(
      `Hermes config not found at ${configPath}. Run "npx hermes-gateway onboard" in an interactive shell.`,
    );
  }

  await runOnboarding({ configPath });
}

async function run(): Promise<void> {
  const configPath = getHermesConfigPath();
  const [command] = process.argv.slice(2);

  switch (command) {
    case undefined:
    case "start":
      await ensureConfig(configPath);
      await startHermes({ configPath, runtimeCwd: process.cwd() });
      return;
    case "onboard":
      await runOnboarding({ configPath });
      return;
    default:
      throw new Error(`Unknown command "${command}". Supported commands: start, onboard.`);
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
