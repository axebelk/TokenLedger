import { verifyLicense, type EeFeature, type LicensePayload } from "./license.js";

/**
 * Process-wide entitlement state. Apps call initLicensing() once at boot;
 * feature gates call entitled() everywhere else. An absent or invalid
 * license simply means every gate answers false — CE behavior.
 */

let active: LicensePayload | null = null;

export function initLicensing(
  licenseKey: string | undefined,
  publicKeyPem?: string,
): { license: LicensePayload | null; reason?: string } {
  if (!licenseKey) {
    active = null;
    return { license: null, reason: "no license key configured" };
  }
  const result = verifyLicense(licenseKey, publicKeyPem);
  if (!result.valid) {
    active = null;
    return { license: null, reason: result.reason };
  }
  active = result.payload;
  return { license: active };
}

export function entitled(feature: EeFeature): boolean {
  if (!active) return false;
  if (Date.parse(active.expiresAt) < Date.now()) return false;
  return active.features.includes(feature);
}

export function activeLicense(): LicensePayload | null {
  return active;
}

/** Test helper — never call from app code. */
export function resetLicensingForTests(): void {
  active = null;
}
