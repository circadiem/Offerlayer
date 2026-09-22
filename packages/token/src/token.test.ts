import { describe, expect, it } from "vitest";
import { issueToken, verifyToken, TokenError } from "./index.ts";

const secret = "offerlayer_token_secret_v0_change_me_32b";

describe("HMAC tokens", () => {
  it("round-trips", () => {
    const { token, payload } = issueToken(
      { offerId: "off_towel_organic_set", agentId: "agt_demo", principalHash: "anon" },
      secret,
    );
    expect(token.startsWith("olt_")).toBe(true);
    const verified = verifyToken(token, secret);
    expect(verified.off).toBe(payload.off);
    expect(verified.nce).toBe(payload.nce);
  });

  it("rejects expiry", () => {
    const { token } = issueToken(
      {
        offerId: "off_towel_organic_set",
        agentId: "agt_demo",
        principalHash: "anon",
        exp: Math.floor(Date.now() / 1000) - 1,
      },
      secret,
    );
    expect(() => verifyToken(token, secret)).toThrow(TokenError);
  });

  it("rejects tampering", () => {
    const { token } = issueToken(
      { offerId: "off_towel_organic_set", agentId: "agt_demo", principalHash: "anon" },
      secret,
    );
    const bad = token.slice(0, -2) + "aa";
    expect(() => verifyToken(bad, secret)).toThrow(TokenError);
  });
});
