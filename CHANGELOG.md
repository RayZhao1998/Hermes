# Changelog

All notable changes to this project will be documented in this file.

## 0.4.0 - 2026-03-10

Hermes 0.4.0 turns Discord from a placeholder into a usable Gateway-backed channel and fixes scheduled cron tasks so the first matching run fires correctly even when Hermes starts exactly on the schedule boundary.

### Highlights

- Added Discord bot runtime support through `@chat-adapter/discord`, including inbound messages, outbound send/edit, typing indicators, and Gateway listener supervision inside the CLI process.
- Added Discord-specific docs and config guidance, including `allowChats` formats for DMs, channels, and child threads.
- Fixed scheduled cron tasks so the initial matching occurrence is not skipped when Hermes boots exactly at the scheduled time.

### New

- Added a real `DiscordAdapter` implementation wired into Hermes runtime startup instead of the previous placeholder.
- Added Discord command normalization from `!command` to Hermes slash-style routing and mapped Discord thread ids into Hermes chat ids.
- Added Discord runtime handling for proxy-aware network setup, Gateway listener restarts, and warning logs when manual tool approval is configured for Discord.
- Added unit coverage for Discord adapter wiring, config validation, runtime boot, and Discord-aware authorization behavior.

### Changed

- README and Discord integration docs now describe Discord as an available channel rather than a future placeholder.
- Chat authorization now allows a whitelisted Discord parent channel to authorize its child threads.
- Task scheduling now preserves persisted `nextRunAt` values when computing due work for one-time, interval, and cron tasks.

### Validation

- `npm run build`
- `npm test`
- `npm pack`

## 0.3.0 - 2026-03-08

Hermes 0.3.0 adds file-backed scheduled tasks, expands ACP session controls for selectable modes and models, and improves Telegram pickers so common chat actions can be completed without typing command arguments.

### Highlights

- Added `tasks.yaml` support so Hermes can deliver scheduled prompts to chats on a one-time, interval, or cron basis.
- Added `/modes`, `/mode`, `/models`, and `/model` session controls, including support for ACP config-option based model selection.
- Switched Telegram list-style actions to inline button pickers for workspaces, agents, modes, and models.

### New

- Added scheduled task loading, validation, runtime state persistence, and polling execution through the new `TaskScheduler`.
- Added isolated scheduled-task execution so background prompts do not disturb the chat's active session, workspace, mode, or model.
- Added config support for `bots[].defaultMode` so new sessions can start with a preferred ACP mode.
- Added ACP tracking for selectable session modes and both config-option and legacy model selection APIs.

### Changed

- `/status` now reports the current session mode and model when the active agent exposes them.
- Telegram selection flows now use buttons instead of text-entered ids for supported list commands.
- Hermes startup now loads the tasks file path alongside the main config and wires the scheduler into runtime boot.
- Documentation now covers the expanded Telegram command surface and mode/model controls.

### Validation

- `npm run build`
- `npm test`
- `npm pack`

## 0.2.0 - 2026-03-07

Hermes 0.2.0 restructures runtime configuration around reusable profiles and concrete bots, adds named workspaces with chat-level switching, and refreshes the product docs around the OpenClaw-style assistant model. This is a breaking release for existing deployments.

### Highlights

- Replaced the single-bot config model with reusable `profiles`, concrete `bots`, and named `workspaces`.
- Added `/workspace` so each chat can switch its active project workspace before creating a session.
- Moved Telegram credentials and access control into bot-specific config.
- Rewrote the README and added a Simplified Chinese localization.

### Breaking Changes

- Removed the legacy top-level `telegram`, `security`, `tools`, and `defaultAgentId` config shape.
- Removed `agents[].cwd`; Hermes still launches agents from `~/.hermes/workspace`.
- Removed `telegram.tokenEnv`; Telegram tokens now live directly in `bots[].adapter.token`.
- Access control now lives per bot in `access.allowChats` and `access.allowUsers`.

### New

- Added `profiles` to define the default agent, enabled agents, MCP servers, output mode, and tool approval policy once and reuse them across bots.
- Added `bots` with `channel`, `profileId`, `defaultWorkspaceId`, per-bot access control, and adapter credentials.
- Added named `workspaces` plus the built-in default Hermes workspace, with Telegram picker support through `/workspace`.
- Added multi-bot runtime wiring that reuses a single ACP process manager per profile.
- Added `README.zh-CN.md` and expanded operator-facing setup guidance.

### Changed

- Onboarding now writes the new config structure with one default profile and one Telegram bot.
- Config validation now checks duplicate ids, unknown profile or workspace references, reserved workspace ids, and profile-level output/tool approval compatibility.
- Authorization checks now read from bot-scoped allowlists instead of global security settings.
- Runtime chat state now tracks the active workspace alongside the active agent and session.

### Migration Notes

- Re-run onboarding or migrate `~/.hermes/config.yaml` to the new schema before starting 0.2.0.
- Move `security.allowedChatIds` to `bots[].access.allowChats` and `security.allowedUserIds` to `bots[].access.allowUsers`.
- Move `tools.approvalMode`, `defaultAgentId`, enabled agents, and `app.outputMode` under `profiles[]`, then set each bot's `profileId`.
- Move the Telegram token to `bots[].adapter.token`; `tokenEnv` is no longer supported.
- Remove any `agents[].cwd` entries from config. Hermes still uses `~/.hermes/workspace`, and chats can switch named project workspaces with `/workspace`.

### Validation

- `npm run build`
- `npm test`
- `npm pack`

## 0.1.0 - 2026-03-07

Hermes 0.1.0 improves how agent output is delivered to chat users and makes the runtime workspace deterministic across launches. This release is intended for operators running Hermes against ACP agents in Telegram, with a small but user-visible config change for existing deployments.

### Highlights

- Added `app.outputMode` to control how much agent output Hermes sends back to chat.
- Standardized agent execution to `~/.hermes/workspace` instead of the shell directory used to launch Hermes.
- Expanded onboarding, validation, and test coverage for both changes.

### New

- Added three output delivery modes in config:
  - `full`: stream text plus tool-call updates.
  - `text_only`: send only agent text output.
  - `last_text`: send only the final text accumulated for the turn.
- Updated onboarding so operators can choose the output mode during setup.
- Added runtime validation that rejects `text_only` or `last_text` when `tools.approvalMode` is `manual`.
- Added integration coverage for `text_only` and `last_text` orchestration behavior.

### Changed

- Hermes now starts configured agents from `~/.hermes/workspace` and creates that directory automatically when loading config.
- Configured agent `cwd` values are preserved in the file for compatibility, but runtime execution now always uses the Hermes workspace.
- README setup guidance now documents workspace-based operation and recommends symlinking instruction files such as `AGENTS.md`, `SOUL.md`, and `CLAUDE.md` into the Hermes workspace.

### Operator Notes

- If you previously relied on launching Hermes from a repository directory so the agent could see local instruction files, move or symlink those files into `~/.hermes/workspace` before upgrading.
- If you want reduced chat output, set `tools.approvalMode: auto` first, then choose `app.outputMode: text_only` or `app.outputMode: last_text`.
- Existing configs without `app.outputMode` continue to default to `full`.

### Validation

- `npm run build`
- `npm test`
- `npm pack`
