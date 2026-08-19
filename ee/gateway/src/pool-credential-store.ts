import type pg from "pg";
import type { Provider } from "@tokenledger/shared";
import {
  getCredentialCooldownTtls, setCredentialCooldown, type CooldownRedis,
} from "@tokenledger/shared";
import { decryptSecret, type MasterKeyRing } from "@tokenledger/auth";

// Structural mirror of apps/gateway/src/types.ts — EE packages don't import
// from the app (wrong dependency direction), so this shape is duplicated the
// same way RedisBudgetGuard duplicates BudgetScopes/BudgetVerdict.
export interface ResolvedCredentialSecret {
  credentialId: string;
  secret?: string;
  baseUrl?: string;
  poolId?: string;
}

export interface CredentialStore {
  getDefault(
    workspaceId: string,
    provider: Provider,
    allowedIds?: string[],
  ): Promise<ResolvedCredentialSecret | null>;
  reportOutcome?(credentialId: string): Promise<void>;
}

interface PoolMemberRow {
  poolId: string;
  strategy: "PRIORITY" | "ROUND_ROBIN" | "WEIGHTED";
  cooldownS: number;
  credentialId: string;
  priority: number;
  weight: number;
  health: "HEALTHY" | "DEGRADED" | "DISABLED";
  encryptedSecret: Buffer | null;
  baseUrl: string | null;
}

/**
 * FR-GW-EE: "always-available LLM usage" across N provider API keys.
 *
 * Wraps the CE single-credential store. When a ProviderPool exists for
 * (workspaceId, provider) it selects among the pool's healthy, non-cooling-
 * down members per the configured strategy; otherwise it falls through to
 * the wrapped CE store unchanged. Fails open: if every member is degraded or
 * cooling down, it still returns the best candidate rather than erroring —
 * availability beats strict correctness for a proxy (same philosophy as
 * RedisBudgetGuard and GATEWAY_FAILURE_POLICY elsewhere in the gateway).
 */
export class PoolAwareCredentialStore implements CredentialStore {
  constructor(
    private pool: pg.Pool,
    private ring: MasterKeyRing | null,
    private redis: CooldownRedis,
    private inner: CredentialStore,
  ) {}

  async getDefault(
    workspaceId: string,
    provider: Provider,
    allowedIds?: string[],
  ): Promise<ResolvedCredentialSecret | null> {
    const pooled = await this.tryPool(workspaceId, provider, allowedIds);
    if (pooled) return pooled;
    return this.inner.getDefault(workspaceId, provider, allowedIds);
  }

  async reportOutcome(credentialId: string): Promise<void> {
    await setCredentialCooldown(this.redis, credentialId);
  }

  private async tryPool(
    workspaceId: string,
    provider: Provider,
    allowedIds?: string[],
  ): Promise<ResolvedCredentialSecret | null> {
    // Oldest pool wins when a workspace has more than one for the same
    // provider — matches the "first one you made is the default" convention
    // used elsewhere (provider_credential.isDefault ordering).
    const { rows } = await this.pool.query<PoolMemberRow>(
      `SELECT pp.id AS "poolId", pp.strategy, pp."cooldownS",
              pm."credentialId", pm.priority, pm.weight, pm.health,
              pc."encryptedSecret", pc."baseUrl"
         FROM provider_pool pp
         JOIN pool_member pm ON pm."poolId" = pp.id
         JOIN provider_credential pc ON pc.id = pm."credentialId"
        WHERE pp."workspaceId" = $1 AND pp.provider = $2::"Provider"
          AND pc.status = 'ACTIVE' AND pm.health != 'DISABLED'
          AND ($3::uuid[] IS NULL OR pm."credentialId" = ANY($3::uuid[]))
        ORDER BY pp."createdAt" ASC, pm.priority ASC`,
      [workspaceId, provider, allowedIds && allowedIds.length > 0 ? allowedIds : null],
    );
    if (rows.length === 0) return null;

    const poolId = rows[0]!.poolId;
    const members = rows.filter((r) => r.poolId === poolId);
    const strategy = rows[0]!.strategy;

    const cooldowns = await getCredentialCooldownTtls(this.redis, members.map((m) => m.credentialId));
    const healthy = members.filter((m) => m.health === "HEALTHY" && cooldowns.get(m.credentialId) == null);
    const candidates = healthy.length > 0 ? healthy : members; // fail open

    const chosen = await this.pick(strategy, poolId, candidates);

    let secret: string | undefined;
    if (chosen.encryptedSecret) {
      if (!this.ring) {
        throw new Error("Encrypted credential present but TOKENLEDGER_MASTER_KEY is not configured");
      }
      secret = decryptSecret(chosen.encryptedSecret, this.ring);
    }
    return {
      credentialId: chosen.credentialId,
      poolId,
      ...(secret !== undefined ? { secret } : {}),
      ...(chosen.baseUrl ? { baseUrl: chosen.baseUrl } : {}),
    };
  }

  private async pick(
    strategy: PoolMemberRow["strategy"],
    poolId: string,
    candidates: PoolMemberRow[],
  ): Promise<PoolMemberRow> {
    if (candidates.length === 1) return candidates[0]!;
    if (strategy === "WEIGHTED") return weightedPick(candidates);
    if (strategy === "ROUND_ROBIN") {
      // Redis INCR gives a shared, monotonic cursor across gateway replicas —
      // no coordination needed beyond the mod. The counter never resets; it
      // just wraps via modulo, which is fine for an ever-growing int64.
      const cursor = await incrRoundRobinCursor(this.redis, poolId);
      return candidates[cursor % candidates.length]!;
    }
    // PRIORITY (default): lowest priority number wins.
    return [...candidates].sort((a, b) => a.priority - b.priority)[0]!;
  }
}

function weightedPick(candidates: PoolMemberRow[]): PoolMemberRow {
  const total = candidates.reduce((sum, c) => sum + Math.max(1, c.weight), 0);
  let r = Math.random() * total;
  for (const c of candidates) {
    r -= Math.max(1, c.weight);
    if (r <= 0) return c;
  }
  return candidates[candidates.length - 1]!;
}

// Minimal Redis surface for the round-robin cursor — separate from
// CooldownRedis since INCR isn't part of that contract.
interface IncrRedis {
  incr(key: string): Promise<number>;
}

async function incrRoundRobinCursor(redis: CooldownRedis, poolId: string): Promise<number> {
  try {
    return await (redis as unknown as IncrRedis).incr(`pool:rr:${poolId}`);
  } catch {
    return Math.floor(Math.random() * 1_000_000); // fail open — random is an acceptable fallback for load distribution
  }
}
