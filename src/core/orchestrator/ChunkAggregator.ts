export interface ChunkAggregatorOptions {
  flushIntervalMs: number;
  flushCharThreshold: number;
  onFlush: (text: string) => Promise<void>;
}

export class ChunkAggregator {
  private readonly flushIntervalMs: number;
  private readonly flushCharThreshold: number;
  private readonly onFlush: (text: string) => Promise<void>;

  private buffer = "";
  private timer?: NodeJS.Timeout;
  private queue = Promise.resolve();

  constructor(options: ChunkAggregatorOptions) {
    this.flushIntervalMs = options.flushIntervalMs;
    this.flushCharThreshold = options.flushCharThreshold;
    this.onFlush = options.onFlush;
  }

  push(text: string): void {
    if (!text) {
      return;
    }

    this.buffer += text;

    if (this.buffer.length >= this.flushCharThreshold) {
      this.enqueueFlush();
      return;
    }

    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.enqueueFlush();
      }, this.flushIntervalMs);
    }
  }

  async flush(): Promise<void> {
    this.enqueueFlush();
    await this.queue;
  }

  close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private enqueueFlush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    this.queue = this.queue.then(async () => {
      if (!this.buffer) {
        return;
      }

      const payload = this.buffer;
      this.buffer = "";
      await this.onFlush(payload);
    });
  }
}
