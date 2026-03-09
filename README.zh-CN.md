# Hermes

[English](./README.md) | 简体中文

Hermes 会把兼容 ACP 的 agent 变成一个类似 OpenClaw 的个人助理，再通过 [Chat SDK](https://chat-sdk.dev/) 暴露给聊天应用。

它保持 agent 侧的 ACP 原生协议不变，因此同一个 Hermes 实例可以承接任何通过 `stdio` 说 ACP 的 agent，并通过 Telegram、Discord 以及后续更多聊天平台对外提供服务。

兼容的 agent 示例包括：

- [Kimi CLI](https://github.com/MoonshotAI/kimi-cli)
- [codex-acp](https://github.com/zed-industries/codex-acp)
- [claude-code-acp / claude-agent-acp](https://github.com/zed-industries/claude-agent-acp)

## 为什么用 Hermes

- 把 ACP agent 变成常驻的个人助理，而不是只能在终端里使用的工具。
- 复用类似 OpenClaw 的工作区模型，统一使用专用的 `~/.hermes/workspace`。
- 通过 Chat SDK 把同一个助理暴露到聊天应用里。
- 为每个已配置 agent 保持一个持久进程。
- 通过 `/new` 按聊天会话创建独立 session。
- 合并 Hermes 内置命令和 agent 发布的 ACP 命令。
- 支持 `session/request_permission` 的 `auto` 和 `manual` 两种审批模式。
- 通过每个 bot 下的 `access.allowChats` 和 `access.allowUsers` 限制访问范围。

当前 ACP 传输层只支持 `stdio`。聊天状态当前保存在内存中。

## 聊天应用支持

| 平台 | 状态 | 当前支持 |
| --- | --- | --- |
| Telegram | 已可用 | 基于 `@chat-adapter/telegram` 的 Chat SDK polling 实现。支持接收消息、发送/编辑消息、内置命令注册、带命名空间的 ACP 命令，以及基于按钮的手动工具审批。 |
| Discord | 已可用 | 基于 `@chat-adapter/discord` 的 Gateway-only CLI 实现。支持白名单内 DM/频道/线程消息接收、发送/编辑消息和 typing 指示；不支持 HTTP interactions、按钮 UI 或原生 slash commands。 |

### Telegram 细节

- Bot 传输层运行在 polling 模式。
- Hermes 会同步 `/agents`、`/agent`、`/new`、`/modes`、`/mode`、`/models`、`/model`、`/status`、`/cancel` 等内置命令。
- ACP 命令会以 `/<agent-id>:<command>` 的形式加命名空间，避免冲突。
- 当 Telegram 命令命名规则不允许 `:` 时，Hermes 会额外发布 `__` 别名，例如 `/codex__logout`。
- 手动工具审批通过 Telegram action button 完成。

### Discord 细节

- Hermes 通过 Discord Gateway 收消息，并在 CLI 进程内持续监管 listener。
- Discord 侧命令使用 `!` 前缀，例如 `!new`、`!status`、`!agent codex`。
- Discord bot 的凭据都放在 `bots[].adapter` 下，包括 `token`、`applicationId` 和 `publicKey`。
- `allowChats` 可写成 `discord:@me:<dmChannelId>`、`discord:<guildId>:<channelId>` 或 `discord:<guildId>:<channelId>:<threadId>`。
- 白名单命中父频道时，其子线程也会自动放行。
- 当前版本不支持交互式选择器、按钮式工具审批和原生 Discord slash commands。
- 如果 Discord bot 配了 `tools.approvalMode: manual`，Hermes 会记录 warning，并按 `auto` 实际运行该 bot。
- 详细限制和接入说明见 [docs/discord-v2.md](./docs/discord-v2.md)。

## 安装

Hermes 需要 Node.js 20 或更高版本。

你可以全局安装，也可以直接通过 `npx` 运行。

```bash
npm install -g hermes-gateway
hermes
```

或者：

```bash
npx hermes-gateway@latest
```

如果 `~/.hermes/config.yaml` 还不存在，Hermes 会在首次运行时交互式创建它。

当前生成的配置会创建一个默认 profile 和一个 Telegram bot。Telegram bot token 放在 `bots[].adapter.token` 下。Discord bot 需要手动编辑 `config.yaml` 添加。

## 配置

Hermes 内置了默认工作区 `~/.hermes/workspace`。

当前配置结构：

- `agents` 只描述 ACP agent 进程本身，例如 `id`、`command`、`args` 和 `env`
- `workspaces` 描述具名工作区，配置 `id` 和绝对路径，聊天会话可以通过聊天命令切换
- `mcpServers` 描述可复用的 MCP server 定义，通过 `name` 引用
- `profiles` 描述可复用的运行配置，例如 `defaultAgentId`、启用的 agent、MCP server、输出模式和工具审批模式
- `bots` 描述实际接入的聊天 bot 实例，包括 `channel`、`profileId`、`defaultWorkspaceId`、可选的 `defaultMode`、bot 自己的 `access` 和适配器凭据
- Hermes 会让 ACP agent 进程从 `~/.hermes/workspace` 启动，因此 `cwd` 不属于 agent 配置的一部分
- 每个聊天会话都可以通过 `/workspace` 切换当前工作区，新的 session 会在选中的工作区中启动

如果你已经在使用 OpenClaw，可以直接把 `~/.openclaw/workspace` 中的所有内容复制到 `~/.hermes/workspace`，继续沿用原有的指令文件、记忆文件和其他辅助资产。

```bash
mkdir -p ~/.hermes/workspace
cp -R ~/.openclaw/workspace/. ~/.hermes/workspace/
```

## 使用

启动 Hermes 后，和你的 bot 对话，并通过下面的命令创建 session：

```text
/new
```

如果是在 Discord 中，使用 `!new` 这样的 `!` 前缀命令。

常用命令：

- `/agents` 查看已配置 agent 及其运行状态
- `/agent <id>` 切换当前聊天会话的活跃 agent
- `/workspace` 打开工作区选择器，并切换当前聊天会话的工作区
- `/new` 创建新的 ACP session
- `/modes` 查看当前 session 暴露的模式
- `/mode <id>` 切换当前模式
- `/models` 查看当前 session 暴露的模型
- `/model <id>` 切换当前模型
- `/status` 查看当前 agent、session、turn 和 MCP server 状态
- `/cancel` 取消正在进行中的 turn

## 项目结构

- `src/cli.ts`: CLI 入口
- `src/main.ts`: 应用启动和运行时接线
- `src/config/`: 配置加载、schema 校验、onboarding
- `src/core/`: ACP client、进程管理、编排、路由、安全、状态
- `src/adapters/telegram/`: Telegram 传输实现
- `src/adapters/discord/`: Discord 传输实现
- `tests/unit/` 和 `tests/integration/`: 自动化测试
- `tools/fake-acp-agent.ts`: 集成测试用 fake ACP agent

## 开发

```bash
npm install
npm run dev
npm run build
npm test
```

- `npm run dev` 通过 `tsx` 直接运行源码
- `npm run build` 编译到 `dist/`
- `npm test` 运行 Vitest 测试

发布流程见 [docs/releasing.md](./docs/releasing.md)。
