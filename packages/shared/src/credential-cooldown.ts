/**
 * Provider-credential cooldown tracking (FR-GW enterprise: always-available
 * LLM proxying across N API keys). Shared between the CE single-credential
 * path (visibility only) and the EE pool-aware path (drives failover).
 *
 * Structurally typed against ioredis rather than importing `@tokenledger/queue`
 * — that package depends on `shared`, so importing it back here would cycle.
 */
export interface CooldownRedis {
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  ttl(key: string): Promise<number>;
}

/** A credential that just failed (429/5xx) cools down for this long before it's
 * trusted again. Kept flat rather than per-pool-configurable to avoid an extra
 * DB round-trip on the hot failure path; ProviderPool.cooldownS documents the
 * intended value operators can expect. */
export const DEFAULT_CREDENTIAL_COOLDOWN_S = 60;

export function credentialCooldownKey(credentialId: string): string {
  return `cred:cooldown:${credentialId}`;
}

/** Best-effort: cooldown tracking must never break the request path. */
export async function setCredentialCooldown(
  redis: CooldownRedis,
  credentialId: string,
  seconds = DEFAULT_CREDENTIAL_COOLDOWN_S,
): Promise<void> {
  try {
    await redis.set(credentialCooldownKey(credentialId), String(Date.now()), "EX", seconds);
  } catch {
    /* best-effort */
  }
}

export async function clearCredentialCooldown(redis: CooldownRedis, credentialId: string): Promise<void> {
  try {
    await redis.del(credentialCooldownKey(credentialId));
  } catch {
    /* best-effort */
  }
}

/** Seconds remaining, or null if not cooling down (or Redis is unreachable — fail open). */
export async function getCredentialCooldownTtl(redis: CooldownRedis, credentialId: string): Promise<number | null> {
  try {
    const ttl = await redis.ttl(credentialCooldownKey(credentialId));
    return ttl > 0 ? ttl : null;
  } catch {
    return null;
  }
}

/** Batch variant for report pages / pool selection — one round trip for N credentials. */
export async function getCredentialCooldownTtls(
  redis: CooldownRedis,
  credentialIds: string[],
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (credentialIds.length === 0) return result;
  try {
    const ttlKeys = credentialIds.map(credentialCooldownKey);
    const values = await Promise.all(ttlKeys.map((k) => redis.ttl(k)));
    credentialIds.forEach((id, i) => result.set(id, values[i]! > 0 ? values[i]! : null));
  } catch {
    credentialIds.forEach((id) => result.set(id, null)); // fail open
  }
  return result;
}
