#!/usr/bin/env node
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import type {
  Agent,
  AgentSideConnection as AgentConn,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
} from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";

interface SessionState {
  abortController?: AbortController;
  mcpServers: NewSessionRequest["mcpServers"];
}

class FakeAgent implements Agent {
  private readonly sessions = new Map<string, SessionState>();

  constructor(private readonly connection: AgentConn) {}

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {};
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, { mcpServers: params.mcpServers });
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          {
            name: "explain",
            description: "Explain the selected code or text.",
          },
          {
            name: "summarize",
            description: "Summarize the latest context.",
          },
        ],
      },
    });
    return { sessionId };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Unknown session ${params.sessionId}`);
    }

    const abortController = new AbortController();
    session.abortController = abortController;

    let text = "";
    for (const block of params.prompt) {
      if (block.type === "text") {
        text = block.text;
        break;
      }
    }

    const chunks = [`Echo: `, text.slice(0, 30), text.length > 30 ? "..." : ""];
    for (const chunk of chunks) {
      if (abortController.signal.aborted) {
        return { stopReason: "cancelled" };
      }
      if (!chunk) {
        continue;
      }
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: chunk,
          },
        },
      });
      await sleep(80);
    }

    if (text.toLowerCase().includes("report mcp")) {
      const names = session.mcpServers.map((server) => server.name).join(",") || "(none)";
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: ` [mcp:${names}]`,
          },
        },
      });
    }

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "fake-tool-1",
        title: "Fake write operation",
        status: "pending",
      },
    });

    const permission = await this.connection.requestPermission({
      sessionId: params.sessionId,
      toolCall: {
        toolCallId: "fake-tool-1",
        title: "Fake write operation",
        status: "pending",
      },
      options: [
        { kind: "allow_once", name: "Allow", optionId: "allow" },
        { kind: "reject_once", name: "Reject", optionId: "reject" },
      ],
    });

    if (permission.outcome.outcome === "cancelled") {
      return { stopReason: "cancelled" };
    }

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: ` [permission:${permission.outcome.optionId}]`,
        },
      },
    });

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "fake-tool-1",
        status: "completed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: `Write permission granted via: ${permission.outcome.optionId}`,
            },
          },
        ],
      },
    });

    if (text.toLowerCase().includes("untitled tool")) {
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_c1f39807384f4f21954d7ffc",
          status: "in_progress",
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: "Title-less tool call update",
              },
            },
          ],
        },
      });
    }

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "fake-tool-2",
        title: "Fake search operation",
        status: "pending",
      },
    });
    await sleep(40);

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "fake-tool-2",
        status: "in_progress",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: `Searching for: ${text}`,
            },
          },
        ],
      },
    });

    if (text.toLowerCase().includes("noop tool update")) {
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "fake-tool-2",
        },
      });
    }

    const isLong = text.toLowerCase().includes("long");
    const hasLateCompletion = text.toLowerCase().includes("late tool");
    const iterations = isLong ? 30 : 4;

    for (let i = 0; i < iterations; i += 1) {
      if (abortController.signal.aborted) {
        return { stopReason: "cancelled" };
      }
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: isLong ? "." : " done",
          },
        },
      });
      await sleep(120);
    }

    const completedUpdate = {
      sessionUpdate: "tool_call_update" as const,
      toolCallId: "fake-tool-2",
      status: "completed" as const,
      content: [
        {
          type: "content" as const,
          content: {
            type: "text" as const,
            text: `Search complete for: ${text}`,
          },
        },
      ],
      rawOutput: {
        result: "ok",
        promptLength: text.length,
      },
    };

    if (hasLateCompletion) {
      void (async () => {
        await sleep(10);
        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: completedUpdate,
        });
      })();
      return { stopReason: "end_turn" };
    }

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: completedUpdate,
    });

    return { stopReason: "end_turn" };
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    session?.abortController?.abort();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const writable = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
const readable = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const stream = ndJsonStream(writable, readable);
new AgentSideConnection((conn) => new FakeAgent(conn), stream);
