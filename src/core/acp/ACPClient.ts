import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import type {
  InitializeResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "pino";

type SessionUpdateListener = (update: SessionUpdate) => Promise<void> | void;

export interface ACPClientOptions {
  clientName: string;
  clientVersion: string;
  logger: Logger;
}

export class ACPClient {
  private readonly connection: ClientSideConnection;
  private readonly listeners = new Map<string, Set<SessionUpdateListener>>();
  private readonly logger: Logger;
  private initialized = false;
  private initResponse?: InitializeResponse;

  constructor(process: ChildProcessWithoutNullStreams, options: ACPClientOptions) {
    this.logger = options.logger;

    const writable = Writable.toWeb(process.stdin) as WritableStream<Uint8Array>;
    const readable = Readable.toWeb(process.stdout) as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(writable, readable);

    this.connection = new ClientSideConnection(() => ({
      requestPermission: this.requestPermission.bind(this),
      sessionUpdate: this.sessionUpdate.bind(this),
    }), stream);

    process.stderr.on("data", (chunk: Buffer) => {
      this.logger.debug({ stderr: chunk.toString("utf8") }, "Agent stderr");
    });
  }

  async initialize(clientName: string, clientVersion: string): Promise<InitializeResponse> {
    if (this.initialized && this.initResponse) {
      return this.initResponse;
    }

    const response = await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: {
        name: clientName,
        version: clientVersion,
      },
      clientCapabilities: {},
    });

    this.initialized = true;
    this.initResponse = response;
    return response;
  }

  async newSession(cwd: string): Promise<string> {
    this.ensureInitialized();
    const response = await this.connection.newSession({
      cwd,
      mcpServers: [],
    });
    return response.sessionId;
  }

  async prompt(sessionId: string, text: string): Promise<PromptResponse> {
    this.ensureInitialized();
    return await this.connection.prompt({
      sessionId,
      prompt: [
        {
          type: "text",
          text,
        },
      ],
    });
  }

  async cancel(sessionId: string): Promise<void> {
    this.ensureInitialized();
    await this.connection.cancel({ sessionId });
  }

  onSessionUpdate(sessionId: string, listener: SessionUpdateListener): () => void {
    const existing = this.listeners.get(sessionId) ?? new Set<SessionUpdateListener>();
    existing.add(listener);
    this.listeners.set(sessionId, existing);

    return () => {
      const scoped = this.listeners.get(sessionId);
      if (!scoped) {
        return;
      }
      scoped.delete(listener);
      if (scoped.size === 0) {
        this.listeners.delete(sessionId);
      }
    };
  }

  get signal(): AbortSignal {
    return this.connection.signal;
  }

  private async sessionUpdate(params: SessionNotification): Promise<void> {
    this.logger.info(
      {
        sessionId: params.sessionId,
        updateType: (params.update as { sessionUpdate?: string }).sessionUpdate,
      },
      "ACP session/update received",
    );

    const scoped = this.listeners.get(params.sessionId);
    if (!scoped || scoped.size === 0) {
      this.logger.warn({ sessionId: params.sessionId }, "No listeners for ACP session/update");
      return;
    }

    for (const listener of scoped) {
      await listener(params.update);
    }
  }

  private async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const preferred = params.options.find((option) => option.kind === "allow_once" || option.kind === "allow_always");
    const selected = preferred ?? params.options[0];

    if (!selected) {
      this.logger.warn({ sessionId: params.sessionId }, "No permission option provided by agent; falling back to cancelled");
      return {
        outcome: {
          outcome: "cancelled",
        },
      };
    }

    this.logger.info(
      {
        sessionId: params.sessionId,
        toolCall: params.toolCall.title,
        optionId: selected.optionId,
      },
      "Auto-approved session/request_permission",
    );

    return {
      outcome: {
        outcome: "selected",
        optionId: selected.optionId,
      },
    };
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("ACP client is not initialized.");
    }
  }
}
