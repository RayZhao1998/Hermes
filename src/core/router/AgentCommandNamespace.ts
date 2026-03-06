import type { AvailableCommand } from "@agentclientprotocol/sdk";
import type { ChatCommandDefinition } from "./CommandRouter.js";

const TELEGRAM_COMMAND_NAME_PATTERN = /^[a-z0-9_]{1,32}$/u;

function normalizeCommandToken(token: string): string {
  return token.split("@")[0].toLowerCase();
}

function extractInvocationParts(input: string): { commandToken: string; args: string[] } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const parts = trimmed.slice(1).split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return null;
  }

  return {
    commandToken: normalizeCommandToken(parts[0]),
    args: parts.slice(1),
  };
}

export function buildAgentCommandName(agentId: string, commandName: string): string {
  return `${agentId}:${commandName}`;
}

export function toAgentChatCommandDefinition(
  agentId: string,
  command: Pick<AvailableCommand, "name" | "description">,
): ChatCommandDefinition {
  return {
    name: buildAgentCommandName(agentId, command.name),
    description: command.description,
  };
}

export function toTelegramCommandAlias(commandName: string): string {
  return commandName.toLowerCase().replace(/:/gu, "__").replace(/[^a-z0-9_]/gu, "_");
}

export function isTelegramSafeCommandName(commandName: string): boolean {
  return TELEGRAM_COMMAND_NAME_PATTERN.test(commandName);
}

export function rewriteAgentCommandPrompt(
  input: string,
  agentId: string,
  availableCommands: readonly Pick<AvailableCommand, "name">[],
): string | null {
  const invocation = extractInvocationParts(input);
  if (!invocation) {
    return null;
  }

  for (const command of availableCommands) {
    const publicName = buildAgentCommandName(agentId, command.name);
    const canonicalName = publicName.toLowerCase();
    const telegramAlias = toTelegramCommandAlias(publicName);
    if (invocation.commandToken !== canonicalName && invocation.commandToken !== telegramAlias) {
      continue;
    }

    return invocation.args.length > 0 ? `/${command.name} ${invocation.args.join(" ")}` : `/${command.name}`;
  }

  return null;
}
