# Discord CLI Integration

Hermes now supports Discord through `@chat-adapter/discord` in Gateway-only CLI mode.

## Scope

- Receives messages from Discord DMs, top-level channels, and Discord threads.
- Sends and edits messages through the Chat SDK adapter.
- Emits typing indicators while ACP turns are running.
- Uses plain text commands with `!` prefixes, such as `!new` and `!status`.

This release does not support:

- HTTP interactions
- native Discord slash commands
- button-based pickers
- button-based manual tool approval

If a Discord bot is configured with `tools.approvalMode: manual`, Hermes logs a warning and runs that bot with effective `auto` approval.

## Required Discord setup

Create a Discord application and bot, then enable:

- Message Content Intent
- Guild Messages intent
- Direct Messages intent
- Guild Message Reactions intent if you plan to extend reactions later

Grant the bot permissions needed for Hermes replies:

- View Channels
- Send Messages
- Send Messages in Threads
- Create Public Threads
- Read Message History

Set these runtime values as well:

- `bots[].adapter.token` or `DISCORD_BOT_TOKEN`
- `bots[].adapter.applicationId` or `DISCORD_APPLICATION_ID`
- `DISCORD_PUBLIC_KEY`

## Config example

Add a Discord bot under `bots` in `~/.hermes/config.yaml`:

```yaml
bots:
  - id: discord-main
    channel: discord
    profileId: default
    defaultWorkspaceId: default
    enabled: true
    access:
      allowChats:
        - discord:@me:123456789012345678
        - discord:987654321098765432:234567890123456789
        - discord:987654321098765432:234567890123456789:345678901234567890
      allowUsers: []
    adapter:
      token: ${DISCORD_BOT_TOKEN}
      applicationId: ${DISCORD_APPLICATION_ID}
```

`applicationId` remains optional in config because Hermes can also read `DISCORD_APPLICATION_ID` from the environment. `DISCORD_PUBLIC_KEY` is required by the current Chat SDK adapter even in Gateway-only CLI mode.

## `allowChats` semantics

Hermes stores Discord chat state per conversation target:

- DM or top-level channel: `discord:<guildId-or-@me>:<channelId>`
- Discord thread: `discord:<guildId>:<parentChannelId>:<threadId>`

For authorization:

- an exact thread entry authorizes that thread
- a parent channel entry also authorizes child threads

## Command behavior

Use these commands in Discord:

- `!agents`
- `!agent <id>`
- `!workspace`
- `!new`
- `!modes`
- `!mode <id>`
- `!models`
- `!model <id>`
- `!status`
- `!cancel`

Discord does not expose picker UI in this integration, so chooser commands fall back to plain text lists and usage hints.

## Runtime model

Hermes starts the Discord Gateway listener inside the CLI process and restarts it automatically when the listener window ends or exits unexpectedly.

No separate HTTP server is required for this release.
