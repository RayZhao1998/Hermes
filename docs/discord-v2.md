# Discord V2 Integration Notes

This project already reserves the channel abstraction for Discord:

- `ChannelAdapter` interface (shared by Telegram/Discord)
- `DiscordAdapter` placeholder in `src/adapters/discord/DiscordAdapter.ts`
- `ChatOrchestrator` depends only on `ChannelAdapter`

## V2 Implementation Steps

1. Add a Discord bot SDK (`discord.js`) and implement gateway event handling in `DiscordAdapter`.
2. Map Discord messages to `MessageEnvelope`.
3. Implement `sendMessage` via Discord channels/threads.
4. Extend bot adapter config for `channel: discord` with the Discord-specific credentials and filters it needs.
5. Instantiate Discord bots from `bots[]` in `main.ts` once the adapter is implemented.

No changes are required in ACP core modules (`ACPClient`, `AgentProcessManager`) or orchestrator logic.
