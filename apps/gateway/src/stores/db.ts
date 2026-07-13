import pg from "pg";
import type { Provider } from "@tokentrail/shared";
import { decryptSecret, type MasterKeyRing } from "@tokentrail/auth";
import type {
  CredentialStore,
  KeyStore,
  ResolvedCredentialSecret,
  ResolvedKeyContext,
} from "../types.js";

/**
 * Raw-pg stores for the hot path (no Prisma on the request path — ADR/doc 10).
 * Both queries are single unique-index point reads; the Redis/LRU cache layer
 * in cached.ts sits in front so these only run on cache misses.
 */

export function createPgPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 2000 });
}

interface VkRow {
  id: string;
  workspaceId: string;
  projectId: string;
  teamId: string | null;
  userId: string;
  status: "ACTIVE" | "REVOKED" | "EXPIRED";
  expiresAt: Date | null;
  providerAllowlist: Provider[];
  credentialAllowlist: string[];
  modelAllowlist: string[];
  rpmLimit: number | null;
}

export class PgKeyStore implements KeyStore {
  constructor(private pool: pg.Pool) {}

  async resolve(keyHash: string): Promise<ResolvedKeyContext | null> {
    const { rows } = await this.pool.query<VkRow>(
      `SELECT vk.id, vk."workspaceId", vk."projectId", p."teamId", vk."userId",
              vk.status, vk."expiresAt", vk."providerAllowlist", vk."credentialAllowlist",
              vk."modelAllowlist", vk."rpmLimit"
         FROM virtual_key vk
         JOIN project p ON p.id = vk."projectId"
        WHERE vk."keyHash" = $1`,
      [keyHash],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      vkId: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      ...(row.teamId ? { teamId: row.teamId } : {}),
      userId: row.userId,
      status: row.status,
      ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
      // node-pg does not parse custom enum-array types (Provider[]); it hands
      // back the raw array literal ("{ANTHROPIC,OPENAI}"), so parse defensively.
      providerAllowlist: parsePgArray(row.providerAllowlist) as Provider[],
      credentialAllowlist: parsePgArray(row.credentialAllowlist),
      modelAllowlist: parsePgArray(row.modelAllowlist),
      ...(row.rpmLimit != null ? { rpmLimit: row.rpmLimit } : {}),
    };
  }
}

/** Coerce a node-pg array value (already-parsed array or "{a,b}" literal) to string[]. */
export function parsePgArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value !== "string") return [];
  const inner = value.replace(/^\{|\}$/g, "");
  if (inner.length === 0) return [];
  return inner.split(",").map((item) => item.replace(/^"|"$/g, ""));
}

interface CredRow {
  id: string;
  encryptedSecret: Buffer | null;
  baseUrl: string | null;
}

export class PgCredentialStore implements CredentialStore {
  constructor(
    private pool: pg.Pool,
    private ring: MasterKeyRing | null,
  ) {}

  async getDefault(
    workspaceId: string,
    provider: Provider,
    allowedIds?: string[],
  ): Promise<ResolvedCredentialSecret | null> {
    // allowedIds present ⇒ restrict to that specific set of credential rows
    // (a key's credentialAllowlist); NULL ⇒ no restriction (old behavior).
    const { rows } = await this.pool.query<CredRow>(
      `SELECT id, "encryptedSecret", "baseUrl"
         FROM provider_credential
        WHERE "workspaceId" = $1 AND provider = $2::"Provider" AND status = 'ACTIVE'
          AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))
        ORDER BY "isDefault" DESC, "createdAt" ASC
        LIMIT 1`,
      [workspaceId, provider, allowedIds && allowedIds.length > 0 ? allowedIds : null],
    );
    const row = rows[0];
    if (!row) return null;
    let secret: string | undefined;
    if (row.encryptedSecret) {
      if (!this.ring) {
        throw new Error(
          "Encrypted credential present but TOKENTRAIL_MASTER_KEY is not configured",
        );
      }
      secret = decryptSecret(row.encryptedSecret, this.ring);
    }
    return {
      credentialId: row.id,
      ...(secret !== undefined ? { secret } : {}),
      ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
    };
  }
}
