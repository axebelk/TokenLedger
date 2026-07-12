import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { TOKEN_PREFIX } from "@tokentrail/shared";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Cryptographically random base62 string of the given length, without modulo bias. */
export function randomBase62(length: number): string {
  const out: string[] = [];
  while (out.length < length) {
    // Rejection sampling: accept bytes < 248 (largest multiple of 62 ≤ 256)
    for (const byte of randomBytes(length)) {
      if (byte < 248) {
        out.push(BASE62[byte % 62]!);
        if (out.length === length) break;
      }
    }
  }
  return out.join("");
}

export interface MintedToken {
  /** Full token — shown to the caller exactly once, never stored. */
  token: string;
  /** SHA-256 hex of the full token — the only thing persisted. */
  hash: string;
  last4: string;
}

function mint(prefix: string, entropyChars: number): MintedToken {
  const token = prefix + randomBase62(entropyChars);
  return { token, hash: sha256Hex(token), last4: token.slice(-4) };
}

/** Virtual key: `tt_live_` + 24 base62 chars (~143 bits of entropy). */
export const mintVirtualKey = (): MintedToken => mint(TOKEN_PREFIX.virtualKey, 24);

/** Personal access token: `ttp_` + 32 base62 chars. */
export const mintPersonalAccessToken = (): MintedToken => mint(TOKEN_PREFIX.personalAccessToken, 32);

/** Invitation token: `tti_` + 32 base62 chars. */
export const mintInviteToken = (): MintedToken => mint(TOKEN_PREFIX.invite, 32);

/** Refresh token (cookie-borne, rotated on every use): `ttr_` + 48 base62 chars. */
export const mintRefreshToken = (): MintedToken => mint("ttr_", 48);

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time comparison of a presented token against a stored hash. */
export function verifyTokenHash(presentedToken: string, storedHash: string): boolean {
  const presented = Buffer.from(sha256Hex(presentedToken), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}
