import {
  createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify,
} from "node:crypto";

/**
 * Offline Ed25519 license keys.
 * Format: ttl_<base64url(payload JSON)>.<base64url(signature over payload bytes)>
 *
 * Verification uses, in order: an explicitly passed public key, the
 * LICENSE_PUBLIC_KEY env var, or the vendor key embedded at release-build
 * time. This repo intentionally embeds no key — self-hosters who want to
 * exercise EE features generate their own pair with the `license` CLI.
 */

export const EE_FEATURES = [
  "provider_pools",
  "budget_enforcement",
  "scheduled_reports",
  "sso",
  "slack",
  "audit_logs",
  "white_label",
] as const;
export type EeFeature = (typeof EE_FEATURES)[number];

export interface LicensePayload {
  licensee: string;
  plan: string;
  seats: number;
  features: EeFeature[];
  issuedAt: string; // ISO 8601
  expiresAt: string; // ISO 8601
}

export type VerifyResult =
  | { valid: true; payload: LicensePayload }
  | { valid: false; reason: string };

/** Replaced with the TokenTrail vendor public key in official release builds. */
const EMBEDDED_PUBLIC_KEY_PEM = "";

const PREFIX = "ttl_";

export function verifyLicense(licenseKey: string, publicKeyPem?: string): VerifyResult {
  const pem = publicKeyPem ?? process.env.LICENSE_PUBLIC_KEY ?? EMBEDDED_PUBLIC_KEY_PEM;
  if (!pem) return { valid: false, reason: "no license public key configured" };
  if (!licenseKey.startsWith(PREFIX)) return { valid: false, reason: "malformed license key" };

  const parts = licenseKey.slice(PREFIX.length).split(".");
  if (parts.length !== 2) return { valid: false, reason: "malformed license key" };
  const [payloadB64, sigB64] = parts as [string, string];

  let payloadBytes: Buffer;
  let signature: Buffer;
  try {
    payloadBytes = Buffer.from(payloadB64, "base64url");
    signature = Buffer.from(sigB64, "base64url");
  } catch {
    return { valid: false, reason: "malformed license key" };
  }

  try {
    const key = createPublicKey(pem);
    if (!verify(null, payloadBytes, key, signature)) {
      return { valid: false, reason: "signature verification failed" };
    }
  } catch {
    return { valid: false, reason: "signature verification failed" };
  }

  let payload: LicensePayload;
  try {
    payload = JSON.parse(payloadBytes.toString("utf8")) as LicensePayload;
  } catch {
    return { valid: false, reason: "invalid license payload" };
  }
  if (!payload.expiresAt || Number.isNaN(Date.parse(payload.expiresAt))) {
    return { valid: false, reason: "invalid license payload" };
  }
  if (Date.parse(payload.expiresAt) < Date.now()) {
    return { valid: false, reason: "license expired" };
  }
  return { valid: true, payload };
}

export function signLicense(payload: LicensePayload, privateKeyPem: string): string {
  const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = sign(null, payloadBytes, createPrivateKey(privateKeyPem));
  return `${PREFIX}${payloadBytes.toString("base64url")}.${signature.toString("base64url")}`;
}

export function generateLicenseKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}
