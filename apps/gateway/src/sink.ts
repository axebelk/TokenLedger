import { publishUsageEvent, type Redis, type UsageEventMessage } from "@tokentrail/queue";
import type { Counter } from "prom-client";
import type { Logger } from "@tokentrail/telemetry";
import type { EventSink } from "./types.js";

/**
 * Redis Stream sink — fire-and-forget off the response path. A Redis outage
 * loses events only after the bounded retry buffer overflows, and every loss
 * is counted (FR-GW-8 / NFR-4).
 */
export class RedisStreamSink implements EventSink {
  private buffer: UsageEventMessage[] = [];
  private flushing = false;

  constructor(
    private redis: Redis,
    private logger: Logger,
    private dropped: Counter,
    private maxBuffer = 10_000,
  ) {}

  emit(event: UsageEventMessage): void {
    publishUsageEvent(this.redis, event).catch(() => this.bufferEvent(event));
  }

  private bufferEvent(event: UsageEventMessage): void {
    if (this.buffer.length >= this.maxBuffer) {
      this.dropped.inc();
      return;
    }
    this.buffer.push(event);
    if (!this.flushing) void this.flushLoop();
  }

  private async flushLoop(): Promise<void> {
    this.flushing = true;
    while (this.buffer.length > 0) {
      const event = this.buffer[0]!;
      try {
        await publishUsageEvent(this.redis, event);
        this.buffer.shift();
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    this.flushing = false;
  }
}
