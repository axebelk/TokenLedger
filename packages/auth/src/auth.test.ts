import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, keyRingFromEnv } from "./crypto.js";
import { mintVirtualKey, verifyTokenHash } from "./tokens.js";

describe("virtual key minting", () => {
  it("mints tt_live_ keys with 24 chars of base62 entropy", () => {
    const { token, hash, last4 } = mintVirtualKey();
    expect(token).toMatch(/^tt_live_[0-9A-Za-z]{24}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(last4).toBe(token.slice(-4));
  });

  it("verifies against the stored hash in constant time, rejects others", () => {
    const a = mintVirtualKey();
    const b = mintVirtualKey();
    expect(verifyTokenHash(a.token, a.hash)).toBe(true);
    expect(verifyTokenHash(b.token, a.hash)).toBe(false);
  });

  it("never mints the same key twice", () => {
    const seen = new Set(Array.from({ length: 1000 }, () => mintVirtualKey().token));
    expect(seen.size).toBe(1000);
  });
});

describe("credential encryption", () => {
  const ring = keyRingFromEnv(Buffer.alloc(32, 7).toString("base64"));

  it("round-trips a provider secret", () => {
    const secret = "sk-ant-api03-example-secret";
    const envelope = encryptSecret(secret, ring);
    expect(decryptSecret(envelope, ring)).toBe(secret);
  });

  it("produces distinct envelopes for the same plaintext (fresh IV)", () => {
    const one = encryptSecret("same", ring);
    const two = encryptSecret("same", ring);
    expect(one.equals(two)).toBe(false);
  });

  it("rejects tampered ciphertext", () => {
    const envelope = encryptSecret("secret", ring);
    const at = envelope.length - 20;
    envelope.writeUInt8(envelope.readUInt8(at) ^ 0xff, at);
    expect(() => decryptSecret(envelope, ring)).toThrow();
  });

  it("rejects a wrong-size master key", () => {
    expect(() => keyRingFromEnv(Buffer.alloc(16).toString("base64"))).toThrow();
  });
});
