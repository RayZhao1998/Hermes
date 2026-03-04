import { describe, expect, it, vi } from "vitest";
import { ChunkAggregator } from "../../src/core/orchestrator/ChunkAggregator.js";

describe("ChunkAggregator", () => {
  it("flushes by threshold", async () => {
    const outputs: string[] = [];
    const aggregator = new ChunkAggregator({
      flushIntervalMs: 1000,
      flushCharThreshold: 5,
      onFlush: async (text) => {
        outputs.push(text);
      },
    });

    aggregator.push("abc");
    aggregator.push("de");
    await aggregator.flush();

    expect(outputs).toEqual(["abcde"]);
  });

  it("flushes by interval", async () => {
    vi.useFakeTimers();

    const outputs: string[] = [];
    const aggregator = new ChunkAggregator({
      flushIntervalMs: 1000,
      flushCharThreshold: 100,
      onFlush: async (text) => {
        outputs.push(text);
      },
    });

    aggregator.push("hello");
    await vi.advanceTimersByTimeAsync(1000);
    await aggregator.flush();

    expect(outputs).toEqual(["hello"]);
    vi.useRealTimers();
  });
});
