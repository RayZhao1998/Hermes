# Hermes

Hermes is an [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) gateway that brings ACP-compatible coding agents into chat applications.

It uses the [Chat SDK](https://chat-sdk.dev/) for chat-platform transport and keeps the agent side protocol-native, so the same Hermes instance can front any agent that speaks ACP over `stdio`.

Examples of compatible agents include:

- [Kimi CLI](https://github.com/MoonshotAI/kimi-cli)
- [codex-acp](https://github.com/zed-industries/codex-acp)
- [claude-code-acp / claude-agent-acp](https://github.com/zed-industries/claude-agent-acp)

## Why Hermes

- Run ACP agents from chat instead of a terminal.
- Keep one persistent process per configured agent.
- Create chat-scoped sessions on demand with `/new`.
- Merge built-in Hermes commands with agent-published ACP commands.
- Handle `session/request_permission` in either `auto` or `manual` mode.
- Restrict access with `allowedChatIds` and `allowedUserIds`.

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
hermes onboard
hermes
```

Or:

```bash
npx hermes-gateway@latest onboard
npx hermes-gateway@latest
```

## Setup

Hermes stores its config at `~/.hermes/config.yaml`.

The onboarding command creates this file interactively and scans your `PATH` for known ACP agent commands, including `kimi`, `codex-acp`, `claude-code-acp`, and `claude-agent-acp`.

Example config:

```yaml
app:
  logLevel: info

security:
  allowedChatIds:
    - telegram:123456789
  allowedUserIds: []

telegram:
  enabled: true
  tokenEnv: TELEGRAM_BOT_TOKEN

tools:
  approvalMode: manual

agents:
  - id: kimi
    command: kimi
    args: ["acp"]
    cwd: .
    env: {}
    mcpServers: []
    default: true

  - id: codex
    command: codex-acp
    args: []
    cwd: .
    env: {}
    mcpServers: []
```

Recommended environment setup:

```bash
export TELEGRAM_BOT_TOKEN=your_bot_token
```

## Usage

Start Hermes, then talk to your bot in Telegram and create a session with:

```text
/new
```

Useful commands:

- `/agents` list configured agents and runtime status
- `/agent <id>` switch the active agent for the current chat
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
