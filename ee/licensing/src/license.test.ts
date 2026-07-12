import { afterEach, describe, expect, it } from "vitest";
import {
  EE_FEATURES, generateLicenseKeyPair, signLicense, verifyLicense, type LicensePayload,
} from "./license.js";
import { entitled, initLicensing, resetLicensingForTests } from "./runtime.js";

const { publicKeyPem, privateKeyPem } = generateLicenseKeyPair();

function payload(overrides: Partial<LicensePayload> = {}): LicensePayload {
  return {
    licensee: "Acme Corp",
    plan: "enterprise",
    seats: 100,
    features: [...EE_FEATURES],
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    ...overrides,
  };
}

afterEach(resetLicensingForTests);

describe("license sign/verify", () => {
  it("round-trips a valid license", () => {
    const key = signLicense(payload(), privateKeyPem);
    expect(key).toMatch(/^ttl_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const result = verifyLicense(key, publicKeyPem);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.payload.licensee).toBe("Acme Corp");
  });

  it("rejects expired licenses", () => {
    const key = signLicense(payload({ expiresAt: new Date(Date.now() - 1000).toISOString() }), privateKeyPem);
    expect(verifyLicense(key, publicKeyPem)).toMatchObject({ valid: false, reason: "license expired" });
  });

  it("rejects tampered payloads", () => {
    const key = signLicense(payload(), privateKeyPem);
    const [head, sig] = key.slice(4).split(".") as [string, string];
    const forged = JSON.parse(Buffer.from(head, "base64url").toString()) as LicensePayload;
    forged.seats = 10_000;
    const tampered = `ttl_${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${sig}`;
    expect(verifyLicense(tampered, publicKeyPem)).toMatchObject({ valid: false });
  });

  it("rejects licenses signed with a different key", () => {
    const other = generateLicenseKeyPair();
    const key = signLicense(payload(), other.privateKeyPem);
    expect(verifyLicense(key, publicKeyPem)).toMatchObject({
      valid: false,
      reason: "signature verification failed",
    });
  });

  it("fails closed with no public key configured", () => {
    const key = signLicense(payload(), privateKeyPem);
    delete process.env.LICENSE_PUBLIC_KEY;
    expect(verifyLicense(key)).toMatchObject({ valid: false, reason: "no license public key configured" });
  });
});

describe("runtime entitlements", () => {
  it("gates features on the active license", () => {
    expect(entitled("budget_enforcement")).toBe(false);
    const key = signLicense(payload({ features: ["budget_enforcement"] }), privateKeyPem);
    const { license } = initLicensing(key, publicKeyPem);
    expect(license?.plan).toBe("enterprise");
    expect(entitled("budget_enforcement")).toBe(true);
    expect(entitled("sso")).toBe(false);
  });

  it("treats an invalid key as community edition", () => {
    const { license, reason } = initLicensing("ttl_garbage.garbage", publicKeyPem);
    expect(license).toBeNull();
    expect(reason).toBeTruthy();
    expect(entitled("budget_enforcement")).toBe(false);
  });
});
