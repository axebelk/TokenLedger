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
  issuedAt: string;
  expiresAt: string;
}

export type VerifyResult =
  | { valid: true; payload: LicensePayload }
  | { valid: false; reason: string };

export function verifyLicense(_licenseKey: string, _publicKeyPem?: string): VerifyResult {
  return { valid: false, reason: "community edition — no license verification" };
}

export function signLicense(_payload: LicensePayload, _privateKeyPem: string): string {
  throw new Error("License signing is not available in the community edition");
}

export function generateLicenseKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  throw new Error("License key generation is not available in the community edition");
}

