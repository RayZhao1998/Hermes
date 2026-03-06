import type { AvailableCommand } from "@agentclientprotocol/sdk";

export interface ChatState {
  chatKey: string;
  activeAgentId: string;
  sessionId?: string;
  activeTurnId?: string;
  availableCommands: AvailableCommand[];
}

export class InMemoryChatStateStore {
  private readonly states = new Map<string, ChatState>();

  get(chatKey: string): ChatState | undefined {
    return this.states.get(chatKey);
  }

  getOrCreate(chatKey: string, defaultAgentId: string): ChatState {
    const existing = this.states.get(chatKey);
    if (existing) {
      return existing;
    }

    const created: ChatState = {
      chatKey,
      activeAgentId: defaultAgentId,
      availableCommands: [],
    };
    this.states.set(chatKey, created);
    return created;
  }

  setActiveAgent(chatKey: string, activeAgentId: string): ChatState {
    const state = this.require(chatKey);
    state.activeAgentId = activeAgentId;
    state.sessionId = undefined;
    state.activeTurnId = undefined;
    state.availableCommands = [];
    return state;
  }

  setSession(chatKey: string, sessionId: string): ChatState {
    const state = this.require(chatKey);
    state.sessionId = sessionId;
    state.activeTurnId = undefined;
    state.availableCommands = [];
    return state;
  }

  setActiveTurn(chatKey: string, turnId?: string): ChatState {
    const state = this.require(chatKey);
    state.activeTurnId = turnId;
    return state;
  }

  setAvailableCommands(chatKey: string, availableCommands: AvailableCommand[]): ChatState {
    const state = this.require(chatKey);
    state.availableCommands = [...availableCommands];
    return state;
  }

  private require(chatKey: string): ChatState {
    const state = this.states.get(chatKey);
    if (!state) {
      throw new Error(`Chat state not found: ${chatKey}`);
    }
    return state;
  }
}
