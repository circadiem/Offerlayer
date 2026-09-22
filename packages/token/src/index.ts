import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { newNonce } from "@offerlayer/schema";

/**
 * v0 tokens are HMAC-SHA256 compact payloads prefixed with `olt_`.
 * Swap the body of issueToken / verifyToken to Ed25519 JWS later
 * without changing callers.
 */

export const tokenPayloadSchema = z.object({
  iss: z.literal("offerlayer"),
  off: z.string().regex(/^off_[a-zA-Z0-9_]+$/),
  agt: z.string().regex(/^agt_[a-zA-Z0-9_]+$/),
  prn: z.string().min(1),
  ref: z.string().nullable(),
  nce: z.string().min(8),
  exp: z.number().int(),
  aud: z.literal("checkout"),
});

export type TokenPayload = z.infer<typeof tokenPayloadSchema>;

export class TokenError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID_TOKEN" | "EXPIRED_TOKEN" | "MALFORMED_TOKEN",
  ) {
    super(message);
    this.name = "TokenError";
  }
}

export interface IssueTokenInput {
  offerId: string;
  agentId: string;
  principalHash: string;
  referrerAgentId?: string | null;
  ttlSeconds?: number;
  now?: Date;
  nonce?: string;
  exp?: number;
}

function hmac(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function issueToken(input: IssueTokenInput, secret: string): { token: string; payload: TokenPayload } {
  if (!secret || secret.length < 16) {
    throw new Error("TOKEN_SECRET must be at least 16 characters");
  }
  const now = input.now ?? new Date();
  const ttl = input.ttlSeconds ?? 60 * 60;
  const payload: TokenPayload = {
    iss: "offerlayer",
    off: input.offerId,
    agt: input.agentId,
    prn: input.principalHash,
    ref: input.referrerAgentId ?? null,
    nce: input.nonce ?? newNonce(),
    exp: input.exp ?? Math.floor(now.getTime() / 1000) + ttl,
    aud: "checkout",
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = hmac(secret, body);
  return { token: `olt_${body}.${sig}`, payload };
}

export function verifyToken(token: string, secret: string, now?: Date): TokenPayload {
  if (!token.startsWith("olt_")) {
    throw new TokenError("Token must start with olt_", "MALFORMED_TOKEN");
  }
  const raw = token.slice(4);
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) {
    throw new TokenError("Token is missing signature", "MALFORMED_TOKEN");
  }
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = hmac(secret, body);
  if (!safeEqual(sig, expected)) {
    throw new TokenError("Token signature mismatch", "INVALID_TOKEN");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new TokenError("Token payload is not JSON", "MALFORMED_TOKEN");
  }
  const payload = tokenPayloadSchema.parse(parsed);
  const ts = Math.floor((now ?? new Date()).getTime() / 1000);
  if (payload.exp <= ts) {
    throw new TokenError("Token expired", "EXPIRED_TOKEN");
  }
  return payload;
}

export function tokenExpiresAt(payload: TokenPayload): string {
  return new Date(payload.exp * 1000).toISOString();
}
