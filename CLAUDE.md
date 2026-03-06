# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hermes is an ACP (Agent Client Protocol) multi-channel gateway that exposes ACP-compatible coding agents to chat platforms (currently Telegram, with Discord planned). It acts as a bridge between AI coding agents and messaging platforms, enabling users to control agents through chat interfaces with real-time streaming responses and tool call updates.

## Development Commands

```bash
# Development (hot reload with tsx)
npm run dev

# Build
npm run build

# Tests
npm test              # Run all tests
npm run test:watch    # Watch mode
```

## Architecture

The system follows a layered architecture with clear abstractions:

### Initialization Flow (`src/main.ts`)
1. Load config from `hermes.config.yaml`
2. Create Telegram adapter with Chat SDK
3. Initialize in-memory state store
4. Create command router
5. Start agent process manager
6. Wire up ChatOrchestrator
7. Register shutdown handlers

### Core Layers

**Channel Layer** (`src/core/channel/`)
- `ChannelAdapter` interface defines the contract for all chat platforms
- `MessageEnvelope` normalizes messages from different platforms
- Platform adapters implement this interface (Telegram via Chat SDK, Discord placeholder)

**ACP Layer** (`src/core/acp/`)
- `AgentProcessManager`: Manages multiple ACP agent processes (one per configured agent)
  - Spawns processes with stdio pipes
  - Auto-restarts on failure (exponential backoff, max 3 attempts)
  - Tracks status: stopped, starting, running, restarting, unavailable
- `ACPClient`: Wrapper around `@agentclientprotocol/sdk`
  - Handles ACP protocol (initialize, newSession, prompt, cancel)
  - Auto-approves permissions (always selects "allow_once" or "allow_always")
  - Emits session updates via listener pattern

**Orchestrator Layer** (`src/core/orchestrator/ChatOrchestrator.ts`)
The heart of the system - coordinates all interactions:
- Receives messages from channel adapter
- Checks access control (whitelist-based)
- Routes commands vs. prompts
- Manages session lifecycle (create, bind, release)
- Handles session updates and renders them to chat
- Implements chunked message sending (3500 char limit for Telegram)
- Edits tool call messages in-place for status updates

**Router Layer** (`src/core/router/`)
- Parses slash commands: `/agents`, `/agent <id>`, `/new`, `/status`, `/cancel`
- Supports aliases (e.g., `/session` → `/new`)
- Merges built-in commands with ACP agent commands

**State Management** (`src/core/state/`)
- `InMemoryChatStateStore`: Tracks per-chat state
  - `chatKey`: `${platform}:${chatId}`
  - Stores: activeAgentId, sessionId, activeTurnId, availableCommands

**Security Layer** (`src/core/security/`)
- Whitelist-based access control
- Checks both `allowedChatIds` and `allowedUserIds`
- Supports scoped IDs (e.g., `telegram:123456789`)

### Message Flow

**Incoming Message:**
```
Telegram API → Chat SDK → TelegramAdapter → MessageEnvelope
→ ChatOrchestrator.handleMessage()
→ Check authorization
→ Parse command or route to prompt
→ Handle command OR Execute prompt
→ Send response via channel.sendMessage()
```

**Prompt Execution:**
```
1. User sends text (not a command)
2. ChatOrchestrator checks if session exists
3. Creates active turn with turnId
4. Binds session to ACP client
5. Sends prompt via ACPClient.prompt()
6. Receives streaming SessionUpdate events
7. Aggregates chunks, renders tool calls
8. Sends chunked messages (3500 char limit)
9. Edits tool call messages for status updates
10. Clears active turn on completion
```

### Command System

**Built-in Commands** (always available):
- `/agents` - List configured agents
- `/agent <id>` - Switch active agent (resets session)
- `/new` - Create new ACP session
- `/status` - Show current state (agent, session, turn, commands)
- `/cancel` - Cancel in-flight prompt turn

**Dynamic Commands** (from ACP agent):
- Merged with built-in commands
- Registered per-chat via Telegram Bot API
- Executed by sending raw `/<command>` prompt to agent
- Updated when agent sends `available_commands_update`

## Configuration

**Config File**: `hermes.config.yaml`

**Schema** (defined in `src/config/schema.ts`):
```yaml
app:
  logLevel: info|debug|warn|error

security:
  allowedChatIds: ["telegram:123456789"]
  allowedUserIds: ["telegram:987654321"]

telegram:
  enabled: true
  tokenEnv: TELEGRAM_BOT_TOKEN  # Environment variable name

agents:
  - id: kimi
    command: kimi
    args: ["acp"]
    cwd: "."  # Relative or absolute path
    env: {}
    default: true  # Marked as default agent
```

**Environment Variables:**
- `TELEGRAM_BOT_TOKEN` - Bot token from BotFather
- `HTTP_PROXY` / `HTTPS_PROXY` - Optional proxy for Telegram API

## Key Dependencies

- `@agentclientprotocol/sdk` (v0.14.1) - ACP protocol implementation
- `chat` (v4.17.0) - Vercel Chat SDK for multi-platform bots
- `@chat-adapter/telegram` - Telegram adapter for Chat SDK
- `@chat-adapter/state-memory` - In-memory state for Chat SDK
- `undici` (v7.22.0) - HTTP client for proxy support
- `pino` (v10.3.1) - Structured logging
- `zod` (v4.3.6) - Runtime type validation
- `yaml` (v2.8.2) - YAML config parsing
- `tsx` (v4.21.0) - TypeScript execution
- `vitest` (v4.0.18) - Testing framework

## Discord V2 Implementation

The project already reserves the channel abstraction for Discord:
- `ChannelAdapter` interface (shared by Telegram/Discord)
- `DiscordAdapter` placeholder in `src/adapters/discord/DiscordAdapter.ts`
- `ChatOrchestrator` depends only on `ChannelAdapter`

**V2 Implementation Steps** (from `docs/discord-v2.md`):
1. Add a Discord bot SDK (`discord.js`) and implement gateway event handling in `DiscordAdapter`
2. Map Discord messages to `MessageEnvelope`
3. Implement `sendMessage` via Discord channels/threads
4. Extend config schema with `discord.enabled`, token env, and optional guild/channel filters
5. Instantiate both adapters in `main.ts` behind feature flags if desired

No changes are required in ACP core modules (`ACPClient`, `AgentProcessManager`) or orchestrator logic.

## Testing

- **Test Runner**: Vitest
- **Test Files**: 7 test files, 24 tests total
- **Integration Tests**: Use `tools/fake-acp-agent.ts` as a mock ACP agent
- **Current Status**: All tests passing (24/24)

Run single test file: `npm test -- <path-to-test-file>`

## Key Design Decisions

- **In-memory state only**: No persistence (simple, fast, but loses state on restart)
- **Polling mode for Telegram**: Simpler than webhooks, works well for single-instance deployments
- **Auto-approve permissions**: Streamlines UX for trusted agents
- **One process per agent**: Isolation, easy restart, resource management
- **Manual session creation**: Users must explicitly run `/new` to start sessions
- **Streaming first**: Handles chunked messages and tool call updates efficiently
