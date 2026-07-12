import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";
import { signAccessToken, verifyAccessToken } from "./jwt.js";

describe("password hashing", () => {
  it("round-trips and rejects wrong passwords", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("wrong", stored)).toBe(false);
  });

  it("salts every hash", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
  });

  it("rejects malformed stored values without throwing", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "argon2id$future$format")).toBe(false);
  });
});

describe("access tokens", () => {
  const secret = "test-secret-at-least-32-characters!!";

  it("signs and verifies claims", async () => {
    const token = await signAccessToken({ sub: "user-1", email: "a@b.co" }, secret);
    expect(await verifyAccessToken(token, secret)).toEqual({ sub: "user-1", email: "a@b.co" });
  });

  it("rejects tampered and wrong-secret tokens", async () => {
    const token = await signAccessToken({ sub: "user-1", email: "a@b.co" }, secret);
    expect(await verifyAccessToken(token + "x", secret)).toBeNull();
    expect(await verifyAccessToken(token, "another-secret-32-characters-long!!")).toBeNull();
  });

  it("rejects expired tokens", async () => {
    const token = await signAccessToken({ sub: "u", email: "a@b.co" }, secret, -10);
    expect(await verifyAccessToken(token, secret)).toBeNull();
  });
});
