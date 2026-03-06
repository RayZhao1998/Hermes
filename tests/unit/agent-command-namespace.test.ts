import { describe, expect, it } from "vitest";
import {
  rewriteAgentCommandPrompt,
  toAgentChatCommandDefinition,
  toTelegramCommandAlias,
} from "../../src/core/router/AgentCommandNamespace.js";

describe("AgentCommandNamespace", () => {
  it("builds namespaced chat commands", () => {
    expect(
      toAgentChatCommandDefinition("codex", {
        name: "logout",
        description: "Log out of the current account.",
      }),
    ).toEqual({
      name: "codex:logout",
      description: "Log out of the current account.",
    });
  });

  it("rewrites namespaced commands back to the raw agent command", () => {
    expect(
      rewriteAgentCommandPrompt("/codex:logout now", "codex", [{ name: "logout" }]),
    ).toBe("/logout now");
  });

  it("accepts Telegram-safe aliases for namespaced commands", () => {
    expect(toTelegramCommandAlias("codex:logout")).toBe("codex__logout");
    expect(
      rewriteAgentCommandPrompt("/codex__logout", "codex", [{ name: "logout" }]),
    ).toBe("/logout");
  });
});
