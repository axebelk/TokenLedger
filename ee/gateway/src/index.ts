import type { Redis } from "@tokentrail/queue";

export interface BudgetScopes {
  workspaceId: string;
  projectId: string;
  userId: string;
  teamId?: string;
}

export type BudgetVerdict =
  | { blocked: false }
  | { blocked: true; scope: string; scopeId: string; resetsAt?: string };

/** Redis key that marks a scope as budget-blocked (written by the worker). */
export function budgetBlockKey(scopeType: string, scopeId: string): string {
  return `budget:block:${scopeType}:${scopeId}`;
}

interface BlockRecord {
  budgetId: string;
  resetsAt?: string;
}

/**
 * O(1) gateway budget check (SRS FR-GW-9 / FR-BUD-3): one MGET across the
 * request's four governing scopes. The worker's budget engine maintains the
 * block flags (eventually consistent, ≤ ~60 s lag — the documented overshoot
 * bound). Fails open: Redis trouble must never take AI traffic down.
 */
export class RedisBudgetGuard {
  constructor(private redis: Redis) {}

  async check(scopes: BudgetScopes): Promise<BudgetVerdict> {
    const lookups: [scope: string, id: string][] = [
      ["WORKSPACE", scopes.workspaceId],
      ["PROJECT", scopes.projectId],
      ["USER", scopes.userId],
    ];
    if (scopes.teamId) lookups.push(["TEAM", scopes.teamId]);

    let values: (string | null)[];
    try {
      values = await this.redis.mget(lookups.map(([scope, id]) => budgetBlockKey(scope, id)));
    } catch {
      return { blocked: false };
    }

    for (let i = 0; i < values.length; i++) {
      const raw = values[i];
      if (!raw) continue;
      const [scope, scopeId] = lookups[i]!;
      let record: BlockRecord = { budgetId: "" };
      try {
        record = JSON.parse(raw) as BlockRecord;
      } catch {
        /* legacy/plain flag — still a block */
      }
      return {
        blocked: true,
        scope,
        scopeId,
        ...(record.resetsAt ? { resetsAt: record.resetsAt } : {}),
      };
    }
    return { blocked: false };
  }
}
