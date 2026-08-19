import type { EeFeature, LicensePayload } from "./license.js";

let active: LicensePayload | null = null;

export function initLicensing(
  _licenseKey: string | undefined,
  _publicKeyPem?: string,
): { license: LicensePayload | null; reason?: string } {
  active = null;
  return { license: null, reason: "community edition" };
}

export function entitled(_feature: EeFeature): boolean {
  return false;
}

export function activeLicense(): LicensePayload | null {
  return active;
}

export function resetLicensingForTests(): void {
  active = null;
}

