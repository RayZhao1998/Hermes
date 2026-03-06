# Hermes

Hermes is an ACP client gateway that exposes ACP-compatible coding agents to chat platforms.

Telegram transport is powered by Vercel Chat SDK (`chat` + `@chat-adapter/telegram`) in polling mode. V2 is prepared with a Discord adapter interface placeholder.

## Features

- ACP transport over `stdio` only.
- Telegram bot transport via Chat SDK polling.
- Chat-scoped Telegram slash commands merged with ACP `available_commands_update`.
- One persistent process per configured agent.
- Manual session creation via `/new` only.
- Configurable tool approval for `session/request_permission`.
- Whitelist-based access control (`allowedChatIds` or `allowedUserIds`).
- In-memory chat state (no persistence).

## Requirements

- Node.js 20+

## Setup

1. Install dependencies:

```bash
npm install
```

2. Export Telegram bot token (or use `.env`):

```bash
export TELEGRAM_BOT_TOKEN="<your-token>"
```

3. Edit `hermes.config.yaml` (agents and whitelist):

- `security.allowedChatIds`: e.g. `telegram:123456789`
- `security.allowedUserIds`: e.g. `telegram:987654321`
- `tools.approvalMode`: `auto` or `manual` (`manual` uses Telegram action buttons for approval)
- `agents`: command/args/cwd/env for ACP agents
- `agents[].mcpServers`: optional MCP server list passed to `session/new`

4. Start Hermes:

```bash
npm run dev
```

## Chat Commands

- `/agents` list configured agents and runtime status
- `/agent <id>` switch active agent for current chat (resets session)
- `/new` create a new ACP session
- `/status` show current agent/session/turn state, including configured MCP servers
- `/cancel` cancel in-flight prompt turn
- ACP slash commands published by the active session are registered dynamically for the current Telegram chat and are executed by sending the raw `/<command> ...` prompt to the agent.

## Build and Test

```bash
npm run build
npm test
```

## Project Structure

- `src/main.ts` app entrypoint
- `src/config/*` config schema + loader
- `src/core/acp/*` ACP connection and agent process manager
- `src/core/orchestrator/*` command + prompt orchestration
- `src/adapters/telegram/*` Telegram adapter backed by Chat SDK
- `src/adapters/discord/*` Discord placeholder (V2)
- `tools/fake-acp-agent.ts` ACP fake agent for integration tests
- `tests/*` unit and integration tests
