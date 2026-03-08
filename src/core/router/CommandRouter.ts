export interface ChatCommandDefinition {
  name: string;
  description: string;
}

export const commandDefinitions = [
  { name: "agents", description: "List configured agents" },
  { name: "workspace", description: "Switch the active workspace" },
  { name: "new", description: "Create a new ACP session" },
  { name: "modes", description: "List selectable modes for the active session" },
  { name: "models", description: "List selectable models for the active session" },
  { name: "status", description: "Show current chat state" },
  { name: "cancel", description: "Cancel the active turn" },
] as const satisfies readonly ChatCommandDefinition[];

const hiddenCommandNames = ["agent", "mode", "model"] as const;

export type CommandName =
  | (typeof commandDefinitions)[number]["name"]
  | (typeof hiddenCommandNames)[number];

export interface ParsedCommand {
  name: CommandName;
  args: string[];
}

const supportedCommands: ReadonlySet<string> = new Set([
  ...commandDefinitions.map(({ name }) => name),
  ...hiddenCommandNames,
]);
const aliases = new Map<string, CommandName>([["session", "new"]]);

export function mergeCommandDefinitions(extraCommands: readonly ChatCommandDefinition[]): ChatCommandDefinition[] {
  const merged: ChatCommandDefinition[] = [...commandDefinitions];
  const seen = new Set<string>(commandDefinitions.map(({ name }) => name));

  for (const command of extraCommands) {
    if (seen.has(command.name)) {
      continue;
    }
    merged.push(command);
    seen.add(command.name);
  }

  return merged;
}

export class CommandRouter {
  parse(input: string): ParsedCommand | null {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) {
      return null;
    }

    const parts = trimmed.slice(1).split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      return null;
    }

    const commandToken = parts[0].split("@")[0].toLowerCase();
    const canonicalCommand = aliases.get(commandToken) ?? commandToken;
    if (!supportedCommands.has(canonicalCommand)) {
      return null;
    }

    return {
      name: canonicalCommand as CommandName,
      args: parts.slice(1),
    };
  }
}
