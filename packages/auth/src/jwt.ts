import { SignJWT, jwtVerify } from "jose";

export interface AccessClaims {
  sub: string; // user id
  email: string;
}

const encoder = new TextEncoder();
const ISSUER = "tokentrail";

export const ACCESS_TOKEN_TTL_S = 15 * 60;
export const REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60;

export async function signAccessToken(
  claims: AccessClaims,
  secret: string,
  ttlSeconds = ACCESS_TOKEN_TTL_S,
): Promise<string> {
  return new SignJWT({ email: claims.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(encoder.encode(secret));
}

/** Returns claims on success, null on any verification failure (never throws). */
export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, encoder.encode(secret), { issuer: ISSUER });
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") return null;
    return { sub: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}
