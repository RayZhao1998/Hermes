# Changelog

All notable changes to this project will be documented in this file.

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
