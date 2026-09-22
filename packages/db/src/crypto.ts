import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function hashPrincipal(ref?: string | null): string {
  if (!ref || ref === "anon") return "anon";
  if (ref.startsWith("sha256:")) return ref;
  return `sha256:${createHash("sha256").update(ref, "utf8").digest("hex")}`;
}

function aesKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/** AES-256-GCM blob for Shopify access tokens. Format: enc1.{iv}.{tag}.{ct} (base64url). */
export function encryptSecret(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey(secret), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc1.${iv.toString("base64url")}.${tag.toString("base64url")}.${enc.toString("base64url")}`;
}

export function decryptSecret(blob: string, secret: string): string {
  const parts = blob.split(".");
  if (parts.length !== 4 || parts[0] !== "enc1") {
    throw new Error("invalid ciphertext");
  }
  const [, ivB, tagB, dataB] = parts;
  const decipher = createDecipheriv("aes-256-gcm", aesKey(secret), Buffer.from(ivB, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataB, "base64url")), decipher.final()]).toString("utf8");
}
