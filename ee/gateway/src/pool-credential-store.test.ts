import { describe, expect, it, vi } from "vitest";
import { PoolAwareCredentialStore, type CredentialStore } from "./pool-credential-store.js";

interface FakePoolRow {
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

function fakePgPool(rows: FakePoolRow[]) {
  return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as import("pg").Pool;
}

function fakeRedis(cooldowns: Record<string, number> = {}) {
  const counters = new Map<string, number>();
  return {
    ttl: vi.fn(async (key: string) => {
      const credId = key.replace("cred:cooldown:", "");
      return cooldowns[credId] ?? -2; // -2 = key doesn't exist (ioredis convention)
    }),
    set: vi.fn(async () => "OK"),
    del: vi.fn(async () => 1),
    incr: vi.fn(async (key: string) => {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    }),
  };
}

const inner: CredentialStore = {
  getDefault: vi.fn().mockResolvedValue({ credentialId: "fallback-cred" }),
};

function member(overrides: Partial<FakePoolRow> = {}): FakePoolRow {
  return {
    poolId: "pool-1",
    strategy: "ROUND_ROBIN",
    cooldownS: 60,
    credentialId: "cred-1",
    priority: 0,
    weight: 1,
    health: "HEALTHY",
    encryptedSecret: null,
    baseUrl: "https://mock.example",
    ...overrides,
  };
}

describe("PoolAwareCredentialStore", () => {
  it("falls through to the inner store when no pool exists for the provider", async () => {
    const pg = fakePgPool([]);
    const redis = fakeRedis();
    const store = new PoolAwareCredentialStore(pg, null, redis as never, inner);

    const result = await store.getDefault("ws-1", "ANTHROPIC");
    expect(result).toEqual({ credentialId: "fallback-cred" });
  });

  it("round-robins across healthy members using a Redis-backed cursor", async () => {
    const rows = [
      member({ credentialId: "cred-a" }),
      member({ credentialId: "cred-b" }),
      member({ credentialId: "cred-c" }),
    ];
    const pg = fakePgPool(rows);
    const redis = fakeRedis();
    const store = new PoolAwareCredentialStore(pg, null, redis as never, inner);

    const picks = [
      (await store.getDefault("ws-1", "ANTHROPIC"))?.credentialId,
      (await store.getDefault("ws-1", "ANTHROPIC"))?.credentialId,
      (await store.getDefault("ws-1", "ANTHROPIC"))?.credentialId,
      (await store.getDefault("ws-1", "ANTHROPIC"))?.credentialId,
    ];
    // 4 picks over 3 candidates must wrap — not all identical.
    expect(new Set(picks).size).toBeGreaterThan(1);
    for (const p of picks) expect(["cred-a", "cred-b", "cred-c"]).toContain(p);
  });

  it("skips a credential that is cooling down (recently failed)", async () => {
    const rows = [
      member({ credentialId: "cred-a" }),
      member({ credentialId: "cred-b" }),
    ];
    const pg = fakePgPool(rows);
    const redis = fakeRedis({ "cred-a": 42 }); // cred-a has 42s left on its cooldown
    const store = new PoolAwareCredentialStore(pg, null, redis as never, inner);

    for (let i = 0; i < 5; i++) {
      const result = await store.getDefault("ws-1", "ANTHROPIC");
      expect(result?.credentialId).toBe("cred-b");
    }
  });

  it("fails open — picks a candidate anyway when every member is degraded/cooling down", async () => {
    const rows = [member({ credentialId: "cred-a" })];
    const pg = fakePgPool(rows);
    const redis = fakeRedis({ "cred-a": 42 });
    const store = new PoolAwareCredentialStore(pg, null, redis as never, inner);

    const result = await store.getDefault("ws-1", "ANTHROPIC");
    expect(result?.credentialId).toBe("cred-a"); // still returns it — availability over strictness
  });

  it("PRIORITY strategy picks the lowest priority number among healthy members", async () => {
    const rows = [
      member({ credentialId: "cred-low-priority", priority: 5, strategy: "PRIORITY" }),
      member({ credentialId: "cred-high-priority", priority: 1, strategy: "PRIORITY" }),
    ];
    const pg = fakePgPool(rows);
    const redis = fakeRedis();
    const store = new PoolAwareCredentialStore(pg, null, redis as never, inner);

    const result = await store.getDefault("ws-1", "ANTHROPIC");
    expect(result?.credentialId).toBe("cred-high-priority");
  });

  it("tags the resolved credential with the poolId it came from", async () => {
    const rows = [member({ poolId: "pool-xyz" })];
    const pg = fakePgPool(rows);
    const redis = fakeRedis();
    const store = new PoolAwareCredentialStore(pg, null, redis as never, inner);

    const result = await store.getDefault("ws-1", "ANTHROPIC");
    expect(result?.poolId).toBe("pool-xyz");
  });

  it("reportOutcome writes a cooldown key for the failed credential", async () => {
    const pg = fakePgPool([]);
    const redis = fakeRedis();
    const store = new PoolAwareCredentialStore(pg, null, redis as never, inner);

    await store.reportOutcome("cred-a");
    expect(redis.set).toHaveBeenCalledWith("cred:cooldown:cred-a", expect.any(String), "EX", 60);
  });
});
