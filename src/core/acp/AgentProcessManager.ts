import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { Logger } from "pino";
import type { LoadedAgentConfig } from "../../config/schema.js";
import { ACPClient } from "./ACPClient.js";

export type AgentStatus = "stopped" | "starting" | "running" | "restarting" | "unavailable";

export interface AgentRuntimeInfo {
  id: string;
  status: AgentStatus;
  restartAttempts: number;
  lastError?: string;
}

interface ManagedAgent {
  config: LoadedAgentConfig;
  status: AgentStatus;
  restartAttempts: number;
  lastError?: string;
  process?: ChildProcessWithoutNullStreams;
  client?: ACPClient;
  startingPromise?: Promise<ACPClient>;
  intentionalStop: boolean;
}

export class AgentProcessManager {
  private readonly records = new Map<string, ManagedAgent>();

  constructor(
    agents: LoadedAgentConfig[],
    private readonly defaultAgentId: string,
    private readonly logger: Logger,
  ) {
    for (const config of agents) {
      this.records.set(config.id, {
        config,
        status: "stopped",
        restartAttempts: 0,
        intentionalStop: false,
      });
    }
  }

  getDefaultAgentId(): string {
    return this.defaultAgentId;
  }

  hasAgent(agentId: string): boolean {
    return this.records.has(agentId);
  }

  getAgentIds(): string[] {
    return Array.from(this.records.keys());
  }

  getAgentCwd(agentId: string): string {
    const record = this.requireRecord(agentId);
    return record.config.cwd;
  }

  getAgentMcpServers(agentId: string): McpServer[] {
    const record = this.requireRecord(agentId);
    return record.config.mcpServers;
  }

  listAgents(): AgentRuntimeInfo[] {
    return Array.from(this.records.values()).map((record) => ({
      id: record.config.id,
      status: record.status,
      restartAttempts: record.restartAttempts,
      lastError: record.lastError,
    }));
  }

  async getClient(agentId: string): Promise<ACPClient> {
    const record = this.requireRecord(agentId);

    if (record.status === "unavailable") {
      throw new Error(`Agent ${agentId} is unavailable: ${record.lastError ?? "restart limit reached"}`);
    }

    if (record.client && record.status === "running") {
      return record.client;
    }

    if (record.startingPromise) {
      return record.startingPromise;
    }

    record.startingPromise = this.startAgent(record, false).finally(() => {
      record.startingPromise = undefined;
    });

    return await record.startingPromise;
  }

  async stopAll(): Promise<void> {
    const stops: Promise<void>[] = [];
    for (const record of this.records.values()) {
      record.intentionalStop = true;
      const proc = record.process;
      if (proc && !proc.killed) {
        stops.push(
          new Promise<void>((resolve) => {
            if (proc.exitCode !== null) {
              resolve();
              return;
            }
            proc.once("exit", () => resolve());
            proc.kill();
          }),
        );
      }
      record.status = "stopped";
      record.client = undefined;
      record.process = undefined;
      record.restartAttempts = 0;
      record.lastError = undefined;
    }
    await Promise.allSettled(stops);
  }

  private async startAgent(record: ManagedAgent, isRestart: boolean): Promise<ACPClient> {
    const { config } = record;
    record.status = isRestart ? "restarting" : "starting";

    this.logger.info({ agentId: config.id, command: config.command, args: config.args }, "Starting ACP agent process");

    const proc = spawn(config.command, config.args, {
      cwd: config.cwd,
      env: {
        ...process.env,
        ...config.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (!proc.stdin || !proc.stdout || !proc.stderr) {
      throw new Error(`Agent ${config.id} failed to start with stdio pipes`);
    }

    record.process = proc;
    record.intentionalStop = false;

    const client = new ACPClient(proc, {
      clientName: "hermes",
      clientVersion: "0.1.0",
      logger: this.logger.child({ agentId: config.id }),
    });

    proc.once("exit", (code, signal) => {
      const intentional = record.intentionalStop;
      record.process = undefined;
      record.client = undefined;

      if (intentional) {
        this.logger.info({ agentId: config.id, code, signal }, "Agent process exited intentionally");
        return;
      }

      this.logger.error({ agentId: config.id, code, signal }, "Agent process exited unexpectedly");
      this.scheduleRestart(record, `process exited with code=${code} signal=${signal}`);
    });

    try {
      await client.initialize("hermes", "0.1.0");
      record.client = client;
      record.status = "running";
      record.restartAttempts = 0;
      record.lastError = undefined;
      return client;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record.lastError = message;
      record.status = "stopped";
      if (!proc.killed) {
        proc.kill();
      }
      throw error;
    }
  }

  private scheduleRestart(record: ManagedAgent, reason: string): void {
    if (record.intentionalStop) {
      return;
    }

    if (record.restartAttempts >= 3) {
      record.status = "unavailable";
      record.lastError = reason;
      this.logger.error({ agentId: record.config.id, reason }, "Restart budget exhausted; agent marked unavailable");
      return;
    }

    record.restartAttempts += 1;
    record.status = "restarting";
    record.lastError = reason;

    const delayMs = 500 * 2 ** (record.restartAttempts - 1);
    this.logger.warn(
      { agentId: record.config.id, delayMs, restartAttempt: record.restartAttempts },
      "Scheduling ACP agent restart",
    );

    const timer = setTimeout(() => {
      this.startAgent(record, true).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.scheduleRestart(record, message);
      });
    }, delayMs);

    timer.unref();
  }

  private requireRecord(agentId: string): ManagedAgent {
    const record = this.records.get(agentId);
    if (!record) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    return record;
  }
}
