import "dotenv/config";
import pino from "pino";
import { loadConfig } from "./config/load.js";
import { TelegramAdapter } from "./adapters/telegram/TelegramAdapter.js";
import { AgentProcessManager } from "./core/acp/AgentProcessManager.js";
import { InMemoryChatStateStore } from "./core/state/InMemoryChatStateStore.js";
import { CommandRouter } from "./core/router/CommandRouter.js";
import { ChatOrchestrator } from "./core/orchestrator/ChatOrchestrator.js";

interface StartHermesOptions {
  configPath?: string;
}

export async function startHermes(options: StartHermesOptions = {}): Promise<void> {
  const config = await loadConfig(options.configPath);

  const logger = pino({ level: config.app.logLevel });

  if (!config.telegram.enabled) {
    throw new Error("Telegram must be enabled.");
  }

  const channel = new TelegramAdapter(config.telegram.token, logger.child({ component: "telegram" }));
  const stateStore = new InMemoryChatStateStore();
  const commandRouter = new CommandRouter();
  const agentManager = new AgentProcessManager(config.agents, config.defaultAgentId, logger.child({ component: "acp" }));

  const orchestrator = new ChatOrchestrator({
    channel,
    stateStore,
    router: commandRouter,
    agentManager,
    accessControl: config.security,
    outputMode: config.app.outputMode,
    toolApprovalMode: config.tools.approvalMode,
    logger: logger.child({ component: "orchestrator" }),
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutting down Hermes");
    await orchestrator.stop();
    await agentManager.stopAll();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await orchestrator.start();
  logger.info("Hermes started");
}
