import "dotenv/config";
import pino from "pino";
import { DiscordAdapter } from "./adapters/discord/DiscordAdapter.js";
import { TelegramAdapter } from "./adapters/telegram/TelegramAdapter.js";
import { loadConfig } from "./config/load.js";
import type { LoadedBotConfig, LoadedProfileConfig, ToolApprovalMode } from "./config/schema.js";
import { AgentProcessManager } from "./core/acp/AgentProcessManager.js";
import { ChatOrchestrator } from "./core/orchestrator/ChatOrchestrator.js";
import { CommandRouter } from "./core/router/CommandRouter.js";
import { InMemoryChatStateStore } from "./core/state/InMemoryChatStateStore.js";
import { TaskScheduler } from "./core/tasks/TaskScheduler.js";

interface StartHermesOptions {
  configPath?: string;
}

function createAgentManager(profile: LoadedProfileConfig, logger: pino.Logger): AgentProcessManager {
  return new AgentProcessManager(
    profile.agents,
    profile.defaultAgentId,
    profile.mcpServers,
    logger.child({ component: "acp", profileId: profile.id }),
  );
}

export function createChannel(bot: LoadedBotConfig, logger: pino.Logger) {
  switch (bot.channel) {
    case "telegram":
      return new TelegramAdapter(bot.adapter.token, logger.child({ component: "telegram", botId: bot.id }));
    case "discord": {
      if (!bot.adapter.applicationId) {
        throw new Error(`Discord bot '${bot.id}' requires adapter.applicationId in config.`);
      }
      if (!bot.adapter.publicKey) {
        throw new Error(`Discord bot '${bot.id}' requires adapter.publicKey in config.`);
      }

      return new DiscordAdapter(
        bot.adapter.token,
        logger.child({ component: "discord", botId: bot.id }),
        bot.adapter.applicationId,
        bot.adapter.publicKey,
      );
    }
  }
}

export function resolveToolApprovalMode(bot: LoadedBotConfig, logger: pino.Logger): ToolApprovalMode {
  if (bot.channel === "discord" && bot.profile.tools.approvalMode === "manual") {
    logger.warn(
      { botId: bot.id, profileId: bot.profileId },
      "Discord does not support interactive manual tool approval yet; using auto approval for this bot",
    );
    return "auto";
  }

  return bot.profile.tools.approvalMode;
}

export async function startHermes(options: StartHermesOptions = {}): Promise<void> {
  const config = await loadConfig(options.configPath);
  const logger = pino({ level: config.app.logLevel });

  const enabledBots = config.bots.filter((bot) => bot.enabled);
  if (enabledBots.length === 0) {
    throw new Error(`No enabled bots configured (${config.configPath}).`);
  }

  const managers = new Map<string, AgentProcessManager>();
  const orchestrators: ChatOrchestrator[] = [];
  const orchestratorsByBotId = new Map<string, ChatOrchestrator>();
  let scheduler: TaskScheduler | undefined;

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutting down Hermes");
    if (scheduler) {
      await scheduler.stop();
    }
    await Promise.allSettled(orchestrators.map(async (orchestrator) => {
      await orchestrator.stop();
    }));
    await Promise.allSettled(Array.from(managers.values()).map(async (manager) => {
      await manager.stopAll();
    }));
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  try {
    for (const bot of enabledBots) {
      let manager = managers.get(bot.profileId);
      if (!manager) {
        manager = createAgentManager(bot.profile, logger);
        managers.set(bot.profileId, manager);
      }

      const channel = createChannel(bot, logger);
      const toolApprovalMode = resolveToolApprovalMode(bot, logger);
      const orchestrator = new ChatOrchestrator({
        channel,
        stateStore: new InMemoryChatStateStore(),
        router: new CommandRouter(),
        agentManager: manager,
        workspaces: config.workspaces,
        defaultWorkspaceId: bot.defaultWorkspaceId,
        accessControl: bot.access,
        defaultMode: bot.defaultMode,
        outputMode: bot.profile.outputMode,
        toolApprovalMode,
        logger: logger.child({ component: "orchestrator", botId: bot.id, profileId: bot.profileId }),
      });

      await orchestrator.start();
      orchestrators.push(orchestrator);
      orchestratorsByBotId.set(bot.id, orchestrator);
      logger.info({ botId: bot.id, channel: bot.channel, profileId: bot.profileId }, "Bot started");
    }

    scheduler = new TaskScheduler({
      config,
      executorsByBotId: orchestratorsByBotId,
      logger: logger.child({ component: "tasks" }),
    });
    await scheduler.start();
  } catch (error) {
    if (scheduler) {
      await scheduler.stop();
    }
    await Promise.allSettled(orchestrators.map(async (orchestrator) => {
      await orchestrator.stop();
    }));
    await Promise.allSettled(Array.from(managers.values()).map(async (manager) => {
      await manager.stopAll();
    }));
    throw error;
  }

  logger.info({ botIds: enabledBots.map((bot) => bot.id) }, "Hermes started");
}
