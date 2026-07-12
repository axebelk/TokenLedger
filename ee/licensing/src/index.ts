/**
 * Enterprise license verification (Ed25519, offline) — full implementation
 * lands in Phase 4 (docs/12). The entitlement surface is defined now so CE
 * code can gate against it from day one.
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

export interface LicenseInfo {
  plan: string;
  seats: number;
  expiresAt: Date;
  features: EeFeature[];
}

let activeLicense: LicenseInfo | null = null;

/** Phase 4: verify Ed25519 signature of LICENSE_KEY and populate this. */
export function loadLicense(_keyText: string | undefined): LicenseInfo | null {
  return activeLicense;
}

export function entitled(feature: EeFeature): boolean {
  if (!activeLicense) return false;
  if (activeLicense.expiresAt.getTime() < Date.now()) return false;
  return activeLicense.features.includes(feature);
}
