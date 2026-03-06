import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import type {
  AvailableCommand,
  AvailableCommandsUpdate,
  ConfigOptionUpdate,
  InitializeResponse,
  McpServer,
  NewSessionResponse,
  PromptResponse,
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
  SessionModelState,
  SessionNotification,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "pino";

type SessionUpdateListener = (update: SessionUpdate) => Promise<void> | void;
type PermissionRequestHandler = (
  params: RequestPermissionRequest,
  signal: AbortSignal,
) => Promise<RequestPermissionResponse> | RequestPermissionResponse;

interface PendingPermissionRequest {
  abortController: AbortController;
  resolve: (response: RequestPermissionResponse) => void;
  settled: boolean;
}

export interface ACPClientOptions {
  clientName: string;
  clientVersion: string;
  logger: Logger;
}

export interface SelectableModel {
  id: string;
  name: string;
  description?: string;
}

export interface SessionModelSelection {
  configId?: string;
  currentModelId: string;
  models: SelectableModel[];
  source: "config_option" | "legacy_models";
}

export class ACPClient {
  private readonly connection: ClientSideConnection;
  private readonly listeners = new Map<string, Set<SessionUpdateListener>>();
  private readonly permissionHandlers = new Map<string, PermissionRequestHandler>();
  private readonly pendingPermissionsBySession = new Map<string, Set<PendingPermissionRequest>>();
  private readonly availableCommandsBySession = new Map<string, AvailableCommand[]>();
  private readonly configOptionsBySession = new Map<string, SessionConfigOption[]>();
  private readonly legacyModelsBySession = new Map<string, SessionModelState>();
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

  async newSession(cwd: string, mcpServers: McpServer[] = []): Promise<string> {
    this.ensureInitialized();
    const response = await this.connection.newSession({
      cwd,
      mcpServers,
    });
    this.captureSessionState(response.sessionId, response);
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
    this.cancelPendingPermissionRequests(sessionId);
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

  getAvailableCommands(sessionId: string): AvailableCommand[] {
    return [...(this.availableCommandsBySession.get(sessionId) ?? [])];
  }

  getModelSelection(sessionId: string): SessionModelSelection | null {
    const configSelection = toModelSelectionFromConfigOptions(this.configOptionsBySession.get(sessionId));
    if (configSelection) {
      return configSelection;
    }

    const legacyModels = this.legacyModelsBySession.get(sessionId);
    if (!legacyModels) {
      return null;
    }

    return {
      currentModelId: legacyModels.currentModelId,
      models: legacyModels.availableModels.map((model) => ({
        id: model.modelId,
        name: model.name,
        description: model.description ?? undefined,
      })),
      source: "legacy_models",
    };
  }

  async setModel(sessionId: string, modelId: string): Promise<SessionModelSelection> {
    this.ensureInitialized();

    const configSelection = toModelSelectionFromConfigOptions(this.configOptionsBySession.get(sessionId));
    if (configSelection?.configId) {
      const response = await this.connection.setSessionConfigOption({
        sessionId,
        configId: configSelection.configId,
        value: modelId,
      });
      this.configOptionsBySession.set(sessionId, response.configOptions);

      const updated = toModelSelectionFromConfigOptions(response.configOptions);
      if (!updated) {
        throw new Error("Agent did not return model config options after updating the model.");
      }
      return updated;
    }

    const legacyModels = this.legacyModelsBySession.get(sessionId);
    if (!legacyModels) {
      throw new Error("Active session does not expose selectable models.");
    }

    await this.connection.unstable_setSessionModel({
      sessionId,
      modelId,
    });

    this.legacyModelsBySession.set(sessionId, {
      ...legacyModels,
      currentModelId: modelId,
    });

    return this.getModelSelection(sessionId) ?? {
      currentModelId: modelId,
      models: legacyModels.availableModels.map((model) => ({
        id: model.modelId,
        name: model.name,
        description: model.description ?? undefined,
      })),
      source: "legacy_models",
    };
  }

  onRequestPermission(sessionId: string, handler: PermissionRequestHandler): () => void {
    this.permissionHandlers.set(sessionId, handler);

    return () => {
      const existing = this.permissionHandlers.get(sessionId);
      if (existing === handler) {
        this.permissionHandlers.delete(sessionId);
      }
    };
  }

  private async sessionUpdate(params: SessionNotification): Promise<void> {
    this.logger.info(
      {
        sessionId: params.sessionId,
        updateType: (params.update as { sessionUpdate?: string }).sessionUpdate,
      },
      "ACP session/update received",
    );

    const availableCommands = extractAvailableCommands(params.update);
    if (availableCommands) {
      this.availableCommandsBySession.set(params.sessionId, availableCommands);
    }

    const configOptions = extractConfigOptions(params.update);
    if (configOptions) {
      this.configOptionsBySession.set(params.sessionId, configOptions);
    }

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
    const handler = this.permissionHandlers.get(params.sessionId);
    if (!handler) {
      const selected = this.pickPreferredPermissionOption(params.options);

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

    const abortController = new AbortController();
    return await new Promise<RequestPermissionResponse>((resolve) => {
      const pending: PendingPermissionRequest = {
        abortController,
        resolve: (response) => {
          if (pending.settled) {
            return;
          }
          pending.settled = true;
          this.removePendingPermission(params.sessionId, pending);
          resolve(response);
        },
        settled: false,
      };

      this.addPendingPermission(params.sessionId, pending);

      void Promise.resolve(handler(params, abortController.signal))
        .then((response) => {
          pending.resolve(response);
        })
        .catch((error) => {
          const err = error instanceof Error ? error.message : String(error);
          this.logger.error(
            {
              sessionId: params.sessionId,
              toolCall: params.toolCall.title,
              error: err,
            },
            "Permission handler failed; cancelling tool call",
          );
          pending.resolve({
            outcome: {
              outcome: "cancelled",
            },
          });
        });
    });
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("ACP client is not initialized.");
    }
  }

  private pickPreferredPermissionOption(options: PermissionOption[]): PermissionOption | undefined {
    return options.find((option) => option.kind === "allow_once" || option.kind === "allow_always") ?? options[0];
  }

  private addPendingPermission(sessionId: string, pending: PendingPermissionRequest): void {
    const existing = this.pendingPermissionsBySession.get(sessionId) ?? new Set<PendingPermissionRequest>();
    existing.add(pending);
    this.pendingPermissionsBySession.set(sessionId, existing);
  }

  private removePendingPermission(sessionId: string, pending: PendingPermissionRequest): void {
    const existing = this.pendingPermissionsBySession.get(sessionId);
    if (!existing) {
      return;
    }
    existing.delete(pending);
    if (existing.size === 0) {
      this.pendingPermissionsBySession.delete(sessionId);
    }
  }

  private cancelPendingPermissionRequests(sessionId: string): void {
    const pendingRequests = this.pendingPermissionsBySession.get(sessionId);
    if (!pendingRequests) {
      return;
    }

    for (const pending of pendingRequests) {
      pending.abortController.abort();
      pending.resolve({
        outcome: {
          outcome: "cancelled",
        },
      });
    }
  }

  private captureSessionState(
    sessionId: string,
    response: Pick<NewSessionResponse, "configOptions" | "models">,
  ): void {
    if (Array.isArray(response.configOptions)) {
      this.configOptionsBySession.set(sessionId, response.configOptions);
    } else {
      this.configOptionsBySession.delete(sessionId);
    }

    if (response.models) {
      this.legacyModelsBySession.set(sessionId, response.models);
    } else {
      this.legacyModelsBySession.delete(sessionId);
    }
  }
}

export function extractAvailableCommands(update: SessionUpdate): AvailableCommand[] | null {
  const availableCommandsUpdate = update as SessionUpdate & AvailableCommandsUpdate;
  if (availableCommandsUpdate.sessionUpdate !== "available_commands_update") {
    return null;
  }

  if (!Array.isArray(availableCommandsUpdate.availableCommands)) {
    return null;
  }

  return availableCommandsUpdate.availableCommands;
}

function extractConfigOptions(update: SessionUpdate): SessionConfigOption[] | null {
  const configOptionUpdate = update as SessionUpdate & ConfigOptionUpdate;
  if (configOptionUpdate.sessionUpdate !== "config_option_update") {
    return null;
  }

  if (!Array.isArray(configOptionUpdate.configOptions)) {
    return null;
  }

  return configOptionUpdate.configOptions;
}

function toModelSelectionFromConfigOptions(
  configOptions: SessionConfigOption[] | undefined,
): SessionModelSelection | null {
  if (!configOptions) {
    return null;
  }

  const modelOption = configOptions.find((option) => option.category === "model");
  if (!modelOption) {
    return null;
  }

  return {
    configId: modelOption.id,
    currentModelId: modelOption.currentValue,
    models: flattenConfigOptions(modelOption.options),
    source: "config_option",
  };
}

function flattenConfigOptions(
  options: SessionConfigOption["options"],
): SelectableModel[] {
  if (options.length === 0) {
    return [];
  }

  const first = options[0];
  if (first && "value" in first) {
    return (options as SessionConfigSelectOption[]).map((option) => ({
      id: option.value,
      name: option.name,
      description: option.description ?? undefined,
    }));
  }

  return (options as SessionConfigSelectGroup[]).flatMap((group) =>
    group.options.map((option) => ({
      id: option.value,
      name: `${group.name} / ${option.name}`,
      description: option.description ?? undefined,
    }))
  );
}
