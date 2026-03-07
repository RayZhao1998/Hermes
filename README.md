# Hermes

English | [简体中文](./README.zh-CN.md)

Hermes turns ACP-compatible agents into an OpenClaw-style personal assistant, then exposes that assistant to chat applications through the [Chat SDK](https://chat-sdk.dev/).

It keeps the agent side protocol-native, so the same Hermes instance can front any agent that speaks ACP over `stdio` while presenting it through Telegram today and more chat platforms over time.

Examples of compatible agents include:

- [Kimi CLI](https://github.com/MoonshotAI/kimi-cli)
- [codex-acp](https://github.com/zed-industries/codex-acp)
- [claude-code-acp / claude-agent-acp](https://github.com/zed-industries/claude-agent-acp)

## Why Hermes

- Turn ACP agents into a persistent personal assistant instead of a terminal-only tool.
- Reuse the OpenClaw-style workspace model with a dedicated `~/.hermes/workspace`.
- Expose the same assistant to chat applications through Chat SDK adapters.
- Keep one persistent process per configured agent.
- Create chat-scoped sessions on demand with `/new`.
- Merge built-in Hermes commands with agent-published ACP commands.
- Handle `session/request_permission` in either `auto` or `manual` mode.
- Restrict access per bot with `access.allowChats` and `access.allowUsers`.

Current ACP transport support is `stdio` only. Chat state is currently in-memory.

## Chat App Support

| Platform | Status | Current support |
| --- | --- | --- |
| Telegram | Available now | Implemented with Chat SDK polling via `@chat-adapter/telegram`. Supports inbound messages, outbound send/edit, built-in command registration, namespaced ACP commands, and manual tool approval via action buttons. |
| Discord | TODO | The channel abstraction and `DiscordAdapter` placeholder already exist, but gateway events, sending/editing messages, config, and runtime wiring are not implemented yet. The current release starts Telegram only. |

### Telegram details

- Bot transport runs in polling mode.
- Hermes syncs built-in commands such as `/agents`, `/agent`, `/new`, `/models`, `/model`, `/status`, and `/cancel`.
- ACP commands are namespaced as `/<agent-id>:<command>` to avoid collisions.
- When Telegram command naming rules require it, Hermes publishes a `__` alias such as `/codex__logout` for `/codex:logout`.
- Manual tool approval uses Telegram action buttons.

### Discord status

- `src/adapters/discord/DiscordAdapter.ts` is a placeholder only.
- `ChannelAdapter` and the orchestrator are already structured to support Discord cleanly.
- See [docs/discord-v2.md](./docs/discord-v2.md) for the current implementation notes.

## Installation

Hermes requires Node.js 20 or later.

Use Hermes either as a global CLI or directly with `npx`.

```bash
npm install -g hermes-gateway
hermes
```

Or:

```bash
npx hermes-gateway@latest
```

On first run, Hermes creates `~/.hermes/config.yaml` interactively if it does not exist yet.

The generated config creates one default profile and one Telegram bot. Telegram bot tokens live under `bots[].adapter.token`.

## Setup

Hermes keeps a built-in default workspace at `~/.hermes/workspace`.

Config shape:

- `agents` declares ACP agent processes such as `id`, `command`, `args`, and `env`
- `workspaces` declares named workspace ids and absolute project paths that chats can switch to via Telegram
- `mcpServers` declares reusable MCP server definitions by `name`
- `profiles` declares reusable runtime behavior such as `defaultAgentId`, enabled agents, MCP servers, output mode, and tool approval
- `bots` declares concrete chat bot instances with `channel`, `profileId`, `defaultWorkspaceId`, bot-specific `access`, and adapter credentials
- Hermes starts ACP agent processes inside `~/.hermes/workspace`, so `cwd` is not part of agent config
- Each chat can switch its active workspace with `/workspace`; new sessions start in the selected workspace

If you already use OpenClaw, you can copy everything from `~/.openclaw/workspace` into `~/.hermes/workspace` and keep working with the same instructions, memory files, and supporting assets.

```bash
mkdir -p ~/.hermes/workspace
cp -R ~/.openclaw/workspace/. ~/.hermes/workspace/
```

## Usage

Start Hermes, then talk to your bot in Telegram and create a session with:

```text
/new
```

Useful commands:

- `/agents` list configured agents and runtime status
- `/agent <id>` switch the active agent for the current chat
- `/workspace` open a workspace picker and switch the active workspace for the current chat
- `/new` create a new ACP session
- `/models` list models exposed by the active session
- `/model <id>` switch the active model
- `/status` show the current agent, session, turn, and MCP servers
- `/cancel` cancel the in-flight turn

## Project Structure

- `src/cli.ts`: CLI entrypoint
- `src/main.ts`: app startup and runtime wiring
- `src/config/`: config loading, schema validation, onboarding
- `src/core/`: ACP client, process manager, orchestration, routing, security, state
- `src/adapters/telegram/`: Telegram transport implementation
- `src/adapters/discord/`: Discord placeholder for V2
- `tests/unit/` and `tests/integration/`: automated test coverage
- `tools/fake-acp-agent.ts`: fake ACP agent for integration tests

## Development

```bash
npm install
npm run dev
npm run build
npm test
```

- `npm run dev` runs the CLI from source with `tsx`
- `npm run build` compiles to `dist/`
- `npm test` runs the Vitest suite

See [docs/releasing.md](./docs/releasing.md) for release workflow details.
