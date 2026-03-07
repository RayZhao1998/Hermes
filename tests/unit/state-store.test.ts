import { describe, expect, it } from "vitest";
import { InMemoryChatStateStore } from "../../src/core/state/InMemoryChatStateStore.js";

describe("InMemoryChatStateStore", () => {
  it("manages chat state transitions", () => {
    const store = new InMemoryChatStateStore();
    const state = store.getOrCreate("telegram:1", "codex", "default");
    expect(state.activeAgentId).toBe("codex");
    expect(state.activeWorkspaceId).toBe("default");

    store.setSession("telegram:1", "session-1");
    store.setActiveTurn("telegram:1", "turn-1");
    store.setActiveAgent("telegram:1", "claude");

    const updated = store.get("telegram:1");
    expect(updated?.activeAgentId).toBe("claude");
    expect(updated?.activeWorkspaceId).toBe("default");
    expect(updated?.sessionId).toBeUndefined();
    expect(updated?.activeTurnId).toBeUndefined();

    store.setSession("telegram:1", "session-2");
    store.setActiveWorkspace("telegram:1", "repo");

    const workspaceUpdated = store.get("telegram:1");
    expect(workspaceUpdated?.activeWorkspaceId).toBe("repo");
    expect(workspaceUpdated?.sessionId).toBeUndefined();
    expect(workspaceUpdated?.activeTurnId).toBeUndefined();
  });
});
