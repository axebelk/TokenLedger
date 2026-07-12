import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM envelope for provider credentials.
 * Layout: [1B keyId][12B iv][NB ciphertext][16B authTag]
 * The keyId prefix supports master-key rotation: new writes use the newest
 * key; decryption picks the key the envelope names.
 */

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export interface MasterKeyRing {
  /** keyId (0–255) → 32-byte key. Highest id is used for new encryptions. */
  keys: Map<number, Buffer>;
}

export function keyRingFromEnv(masterKeyBase64: string): MasterKeyRing {
  const key = Buffer.from(masterKeyBase64, "base64");
  if (key.length !== 32) {
    throw new Error("TOKENTRAIL_MASTER_KEY must decode to exactly 32 bytes");
  }
  return { keys: new Map([[0, key]]) };
}

export function encryptSecret(plaintext: string, ring: MasterKeyRing): Buffer {
  const keyId = Math.max(...ring.keys.keys());
  const key = ring.keys.get(keyId)!;
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([keyId]), iv, ciphertext, cipher.getAuthTag()]);
}

export function decryptSecret(envelope: Buffer, ring: MasterKeyRing): string {
  if (envelope.length < 1 + IV_LENGTH + TAG_LENGTH) {
    throw new Error("Invalid secret envelope");
  }
  const keyId = envelope[0]!;
  const key = ring.keys.get(keyId);
  if (!key) throw new Error(`Unknown master key id ${keyId} — was the key rotated away?`);
  const iv = envelope.subarray(1, 1 + IV_LENGTH);
  const tag = envelope.subarray(envelope.length - TAG_LENGTH);
  const ciphertext = envelope.subarray(1 + IV_LENGTH, envelope.length - TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
