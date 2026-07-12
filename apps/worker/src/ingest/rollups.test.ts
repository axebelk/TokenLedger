import { describe, expect, it } from "vitest";
import type { UsageEventMessage } from "@tokentrail/queue";
import { formatScaled, groupRollups, parseDecimalScaled, truncateUtc } from "./rollups.js";

function event(overrides: Partial<UsageEventMessage>): UsageEventMessage {
  return {
    id: crypto.randomUUID(),
    occurredAt: "2026-07-12T10:15:30.000Z",
    workspaceId: "ws1",
    projectId: "p1",
    teamId: "t1",
    userId: "u1",
    virtualKeyId: "k1",
    provider: "ANTHROPIC",
    modelRaw: "claude-sonnet-4-5",
    model: "claude-sonnet-4-5",
    endpoint: "/v1/messages",
    requestId: "req_x",
    status: "OK",
    httpStatus: 200,
    streamed: false,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: "0.00105000",
    costBasis: "ACTUAL",
    latencyMs: 200,
    ...overrides,
  };
}

describe("groupRollups", () => {
  it("aggregates same-tuple events into one increment", () => {
    const groups = groupRollups([event({}), event({ inputTokens: 900, costUsd: "0.00945000", latencyMs: 100 })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      requests: 2,
      errors: 0,
      inputTokens: 1000n,
      outputTokens: 100n,
      costUsd: "0.01050000",
      latencyMsSum: 300n,
      latencyCount: 2,
    });
    expect(groups[0]!.bucketHour.toISOString()).toBe("2026-07-12T10:00:00.000Z");
    expect(groups[0]!.bucketDay.toISOString()).toBe("2026-07-12T00:00:00.000Z");
  });

  it("splits on every dimension and on the hour bucket", () => {
    const groups = groupRollups([
      event({}),
      event({ userId: "u2" }),
      event({ model: "claude-opus-4-1" }),
      event({ occurredAt: "2026-07-12T11:00:00.000Z" }),
    ]);
    expect(groups).toHaveLength(4);
  });

  it("counts non-OK statuses as errors", () => {
    const groups = groupRollups([event({}), event({ status: "PROVIDER_ERROR", httpStatus: 429, costUsd: "0" })]);
    expect(groups[0]).toMatchObject({ requests: 2, errors: 1 });
  });

  it("sums money exactly where floats would drift", () => {
    // 0.1 + 0.2 — the classic
    const groups = groupRollups([event({ costUsd: "0.1" }), event({ costUsd: "0.2" })]);
    expect(groups[0]!.costUsd).toBe("0.30000000");
  });
});

describe("decimal helpers", () => {
  it("round-trips scaled decimals", () => {
    expect(parseDecimalScaled("0.0105", 8)).toBe(1_050_000n);
    expect(formatScaled(1_050_000n, 8)).toBe("0.01050000");
    expect(formatScaled(-1n, 8)).toBe("-0.00000001");
  });

  it("rejects over-precise and malformed input", () => {
    expect(() => parseDecimalScaled("0.000000001", 8)).toThrow();
    expect(() => parseDecimalScaled("1e5", 8)).toThrow();
  });
});

describe("truncateUtc", () => {
  it("truncates in UTC regardless of local timezone", () => {
    const date = new Date("2026-07-12T23:59:59.999Z");
    expect(truncateUtc(date, "hour").toISOString()).toBe("2026-07-12T23:00:00.000Z");
    expect(truncateUtc(date, "day").toISOString()).toBe("2026-07-12T00:00:00.000Z");
  });
});
