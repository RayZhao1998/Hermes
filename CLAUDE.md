# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hermes is an ACP (Agent Client Protocol) multi-channel gateway that exposes ACP-compatible coding agents to chat platforms like Telegram. It acts as a bridge between AI coding agents and messaging platforms.

## Development Commands

```bash
npm run dev       # Start Hermes with tsx (development)
npm run build     # Compile TypeScript (tsc -p tsconfig.json)
npm test          # Run all tests (vitest run)
npm run test:watch # Run tests in watch mode (vitest)
```

To run a single test file: `npx vitest run path/to/test.test.ts`

## Architecture Overview

Hermes follows a layered architecture with clear separation between platform-specific code and core orchestration logic:

### Core Layers

1. **Channel Layer** (`src/adapters/`) - Platform abstraction
   - `ChannelAdapter` interface defines the contract for all platforms
   - `MessageEnvelope` normalizes messages across platforms
   - `TelegramAdapter` is the only fully implemented adapter (using Vercel Chat SDK)
   - `DiscordAdapter` exists as a placeholder for V2

2. **Orchestration Layer** (`src/core/orchestrator/`) - Central coordination
   - `ChatOrchestrator` routes messages, manages sessions, and handles ACP updates
   - Implements chunk buffering for streaming responses
   - Manages tool permission flows (auto/manual modes)
   - Handles dynamic command synchronization from ACP

3. **ACP Layer** (`src/core/acp/`) - Agent communication
   - `ACPClient` wraps the ACP SDK for NDJSON-over-stdio communication
   - `AgentProcessManager` spawns and manages agent processes with restart logic

4. **Command Router** (`src/core/router/`) - Slash command handling
   - Built-in commands: `/agents`, `/agent <id>`, `/new`, `/status`, `/cancel`
   - Merges with ACP-provided commands dynamically

5. **State Management** (`src/core/state/`) - Chat-scoped state
   - `InMemoryChatStateStore` tracks active agent, session, turn, and commands per chat

6. **Security** (`src/core/security/`) - Access control
   - Whitelist-based authorization via `allowedChatIds` or `allowedUserIds`
   - Platform-prefixed IDs (e.g., `telegram:123456789`)

### Key Data Flows

**Prompt Execution:** User message → ChannelAdapter → ChatOrchestrator → ACPClient → Agent process → Session updates (streaming) → RenderEvents → ChannelAdapter (sendMessage/editMessage)

**Tool Permission (manual mode):** Agent requests permission → ACPClient → ChatOrchestrator → ChannelAdapter.requestPermission() → UI buttons → User selection → ToolPermissionDecision → Agent continues/cancels

**Command Sync:** Session created → ACP available_commands_update → StateStore → ChatOrchestrator.syncCommands() → ChannelAdapter.syncCommands() → Platform API

## Configuration

Configuration is loaded from `hermes.config.yaml` with Zod validation:

- `app.logLevel`: Logging verbosity (info, debug, warn, error)
- `security.allowedChatIds`/`allowedUserIds`: Whitelist for access control
- `telegram.tokenEnv`: Environment variable name for bot token
- `tools.approvalMode`: `auto` or `manual` (manual uses Telegram action buttons)
- `agents`: Array of agent configurations (id, command, args, cwd, env, default)

## Important Patterns

1. **Session Isolation**: Each chat has its own ACP session. Switching agents resets the session.

2. **Streaming Response Handling**: ACP session updates are rendered incrementally. Chunks are buffered and flushed periodically. Tool calls are rendered via message editing (upsert pattern).

3. **Process Management**: One persistent process per agent configuration (no pooling). Processes restart on crash with exponential backoff (max 3 attempts).

4. **Platform Extension**: To add a new platform, implement `ChannelAdapter` interface and update `MessageEnvelope.Platform` type.

5. **Testing**: Integration tests use `tools/fake-acp-agent.ts` as a mock ACP agent. Unit tests mock the channel adapter.

## Key Files

- `src/main.ts` - Application entry point
- `src/core/channel/ChannelAdapter.ts` - Platform interface definition
- `src/core/orchestrator/ChatOrchestrator.ts` - Central coordination logic
- `src/core/acp/ACPClient.ts` - ACP SDK wrapper
- `src/core/acp/AgentProcessManager.ts` - Process lifecycle management
- `src/config/schema.ts` - Configuration Zod schemas
- `tools/fake-acp-agent.ts` - Mock ACP agent for testing

## Technology Stack

- **Runtime**: Node.js 20+
- **Language**: TypeScript (ES2022, NodeNext modules)
- **ACP SDK**: @agentclientprotocol/sdk
- **Telegram**: Vercel Chat SDK (`chat` + `@chat-adapter/telegram`)
- **Testing**: Vitest with globals enabled
- **Logging**: Pino
- **Validation**: Zod
