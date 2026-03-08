import { describe, expect, it } from "vitest";
import { CommandRouter } from "../../src/core/router/CommandRouter.js";

describe("CommandRouter", () => {
  const router = new CommandRouter();

  it("parses standard commands", () => {
    expect(router.parse("/new")).toEqual({ name: "new", args: [] });
    expect(router.parse("/workspace hermes")).toEqual({ name: "workspace", args: ["hermes"] });
    expect(router.parse("/modes")).toEqual({ name: "modes", args: [] });
    expect(router.parse("/models")).toEqual({ name: "models", args: [] });
  });

  it("parses hidden selection commands used by button actions", () => {
    expect(router.parse("/agent codex")).toEqual({ name: "agent", args: ["codex"] });
    expect(router.parse("/mode auto")).toEqual({ name: "mode", args: ["auto"] });
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
