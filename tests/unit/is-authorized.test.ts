import { describe, expect, it } from "vitest";
import { isAuthorizedMessage } from "../../src/core/security/isAuthorized.js";
import type { MessageEnvelope } from "../../src/core/channel/MessageEnvelope.js";

function message(overrides: Partial<MessageEnvelope>): MessageEnvelope {
  return {
    platform: "telegram",
    chatId: "100",
    userId: "200",
    messageId: "1",
    text: "hello",
    isCommand: false,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("isAuthorizedMessage", () => {
  it("allows matching chat whitelist", () => {
    const allowed = isAuthorizedMessage(message({}), {
      allowChats: ["telegram:100"],
      allowUsers: [],
    });
    expect(allowed).toBe(true);
  });

  it("also allows unscoped chat id for compatibility", () => {
    const allowed = isAuthorizedMessage(message({}), {
      allowChats: ["100"],
      allowUsers: [],
    });
    expect(allowed).toBe(true);
  });

  it("allows matching user whitelist", () => {
    const allowed = isAuthorizedMessage(message({}), {
      allowChats: [],
      allowUsers: ["telegram:200"],
    });
    expect(allowed).toBe(true);
  });

  it("also allows unscoped user id for compatibility", () => {
    const allowed = isAuthorizedMessage(message({}), {
      allowChats: [],
      allowUsers: ["200"],
    });
    expect(allowed).toBe(true);
  });

  it("rejects non-whitelisted messages", () => {
    const allowed = isAuthorizedMessage(message({}), {
      allowChats: ["telegram:999"],
      allowUsers: ["telegram:888"],
    });
    expect(allowed).toBe(false);
  });
});
