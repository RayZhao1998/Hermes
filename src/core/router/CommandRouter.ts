export type CommandName = "agents" | "agent" | "session" | "status" | "cancel";

export interface ParsedCommand {
  name: CommandName;
  args: string[];
}

const supportedCommands: ReadonlySet<string> = new Set(["agents", "agent", "session", "status", "cancel"]);

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
    if (!supportedCommands.has(commandToken)) {
      return null;
    }

    return {
      name: commandToken as CommandName,
      args: parts.slice(1),
    };
  }
}
