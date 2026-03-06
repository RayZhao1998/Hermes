export const commandDefinitions = [
  { name: "agents", description: "List configured agents" },
  { name: "agent", description: "Switch the active agent" },
  { name: "new", description: "Create a new ACP session" },
  { name: "status", description: "Show current chat state" },
  { name: "cancel", description: "Cancel the active turn" },
] as const;

export type CommandName = (typeof commandDefinitions)[number]["name"];

export interface ParsedCommand {
  name: CommandName;
  args: string[];
}

const supportedCommands: ReadonlySet<string> = new Set(commandDefinitions.map(({ name }) => name));
const aliases = new Map<string, CommandName>([["session", "new"]]);

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
