import { describe, expect, it } from "vitest";
import { CommandRouter } from "../../src/core/router/CommandRouter.js";

describe("CommandRouter", () => {
  const router = new CommandRouter();

  it("parses standard commands", () => {
    expect(router.parse("/new")).toEqual({ name: "new", args: [] });
    expect(router.parse("/agent codex")).toEqual({ name: "agent", args: ["codex"] });
    expect(router.parse("/models")).toEqual({ name: "models", args: [] });
    expect(router.parse("/model gpt-5")).toEqual({ name: "model", args: ["gpt-5"] });
  });

  it("maps legacy /session to /new", () => {
    expect(router.parse("/session")).toEqual({ name: "new", args: [] });
  });

  it("handles telegram mention command forms", () => {
    expect(router.parse("/status@my_bot")).toEqual({ name: "status", args: [] });
  });

  it("returns null for unsupported command", () => {
    expect(router.parse("/help")).toBeNull();
    expect(router.parse("hello")).toBeNull();
  });
});
