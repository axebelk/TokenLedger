import type { UsageEventMessage } from "@tokentrail/queue";

/**
 * Pure rollup aggregation: groups a batch of usage events into hourly/daily
 * dimension-tuple increments. Cost is summed in integer 1e-8 USD units
 * (matching numeric(14,8)) — never floats.
 */

export interface RollupIncrement {
  bucketHour: Date;
  bucketDay: Date;
  workspaceId: string;
  projectId: string;
  teamId: string | null;
  userId: string;
  provider: string;
  model: string;
  requests: number;
  errors: number;
  inputTokens: bigint;
  outputTokens: bigint;
  cacheReadTokens: bigint;
  cacheWriteTokens: bigint;
  reasoningTokens: bigint;
  /** Decimal string with 8 dp, e.g. "0.01050000". */
  costUsd: string;
  latencyMsSum: bigint;
  latencyCount: number;
}

const COST_SCALE = 8;

export function groupRollups(events: UsageEventMessage[]): RollupIncrement[] {
  const groups = new Map<string, RollupIncrement & { cost8: bigint }>();

  for (const e of events) {
    const occurred = new Date(e.occurredAt);
    const bucketHour = truncateUtc(occurred, "hour");
    const bucketDay = truncateUtc(occurred, "day");
    const groupKey = [
      bucketHour.toISOString(), e.workspaceId, e.projectId, e.userId, e.provider, e.model,
    ].join("|");

    let group = groups.get(groupKey);
    if (!group) {
      group = {
        bucketHour, bucketDay,
        workspaceId: e.workspaceId,
        projectId: e.projectId,
        teamId: e.teamId ?? null,
        userId: e.userId,
        provider: e.provider,
        model: e.model,
        requests: 0, errors: 0,
        inputTokens: 0n, outputTokens: 0n,
        cacheReadTokens: 0n, cacheWriteTokens: 0n, reasoningTokens: 0n,
        costUsd: "0", cost8: 0n,
        latencyMsSum: 0n, latencyCount: 0,
      };
      groups.set(groupKey, group);
    }

    group.requests += 1;
    if (e.status !== "OK") group.errors += 1;
    group.inputTokens += BigInt(e.inputTokens);
    group.outputTokens += BigInt(e.outputTokens);
    group.cacheReadTokens += BigInt(e.cacheReadTokens);
    group.cacheWriteTokens += BigInt(e.cacheWriteTokens);
    group.reasoningTokens += BigInt(e.reasoningTokens);
    group.cost8 += parseDecimalScaled(e.costUsd, COST_SCALE);
    group.latencyMsSum += BigInt(e.latencyMs);
    group.latencyCount += 1;
  }

  return [...groups.values()].map(({ cost8, ...group }) => ({
    ...group,
    costUsd: formatScaled(cost8, COST_SCALE),
  }));
}

export function truncateUtc(date: Date, unit: "hour" | "day"): Date {
  const truncated = new Date(date);
  truncated.setUTCMinutes(0, 0, 0);
  if (unit === "day") truncated.setUTCHours(0);
  return truncated;
}

/** "0.0105" with scale 8 → 1050000n. Rejects malformed money strings loudly. */
export function parseDecimalScaled(decimal: string, scale: number): bigint {
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(decimal);
  if (!match || (match[3]?.length ?? 0) > scale) {
    throw new Error(`Invalid decimal '${decimal}' for scale ${scale}`);
  }
  const sign = match[1] ? -1n : 1n;
  const frac = (match[3] ?? "").padEnd(scale, "0");
  return sign * (BigInt(match[2]!) * 10n ** BigInt(scale) + BigInt(frac));
}

export function formatScaled(value: bigint, scale: number): string {
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const divisor = 10n ** BigInt(scale);
  return `${sign}${abs / divisor}.${(abs % divisor).toString().padStart(scale, "0")}`;
}
