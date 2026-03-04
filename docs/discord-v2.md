# Discord V2 Integration Notes

This project already reserves the channel abstraction for Discord:

- `ChannelAdapter` interface (shared by Telegram/Discord)
- `DiscordAdapter` placeholder in `src/adapters/discord/DiscordAdapter.ts`
- `ChatOrchestrator` depends only on `ChannelAdapter`

## V2 Implementation Steps

1. Add a Discord bot SDK (`discord.js`) and implement gateway event handling in `DiscordAdapter`.
2. Map Discord messages to `MessageEnvelope`.
3. Implement `sendMessage` via Discord channels/threads.
4. Extend config schema with `discord.enabled`, token env, and optional guild/channel filters.
5. Instantiate both adapters in `main.ts` behind feature flags if desired.

No changes are required in ACP core modules (`ACPClient`, `AgentProcessManager`) or orchestrator logic.
