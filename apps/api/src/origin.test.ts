import { describe, expect, it } from "vitest";
import { loadEnv } from "@offerlayer/db";
import { PRODUCTION_ORIGIN, requestPublicOrigin, rewritePublicUrl } from "./origin.ts";

function headers(map: Record<string, string>) {
  return { header: (n: string) => map[n.toLowerCase()] };
}

describe("requestPublicOrigin", () => {
  const env = loadEnv({ DATABASE_URL: "file::memory:" });

  it("uses x-forwarded-host over loopback env", () => {
    const origin = requestPublicOrigin(
      headers({ "x-forwarded-host": "offerlayer.grok.me", "x-forwarded-proto": "https" }),
      env,
    );
    expect(origin).toBe("https://offerlayer.grok.me");
  });

  it("rewrites stored localhost install URLs", () => {
    const next = rewritePublicUrl(
      "http://localhost:3000/auth/login?seller_link=lnk_x",
      PRODUCTION_ORIGIN,
    );
    expect(next).toBe("https://offerlayer.grok.me/auth/login?seller_link=lnk_x");
    expect(next).not.toContain(":3000");
  });

  it("strips a stray port on an already-public install URL", () => {
    const next = rewritePublicUrl(
      "https://offerlayer.grok.me:3000/auth/login?seller_link=lnk_x",
      PRODUCTION_ORIGIN,
    );
    expect(next).toBe("https://offerlayer.grok.me/auth/login?seller_link=lnk_x");
  });

  it("strips stray ports from public hosts", () => {
    const origin = requestPublicOrigin(
      headers({ host: "offerlayer.grok.me:3000", "x-forwarded-proto": "https" }),
      env,
    );
    expect(origin).toBe("https://offerlayer.grok.me");
  });

  it("on Vercel without Host falls back to offerlayer.grok.me", () => {
    const prev = process.env.VERCEL;
    process.env.VERCEL = "1";
    try {
      const origin = requestPublicOrigin(headers({}), env);
      expect(origin).toBe(PRODUCTION_ORIGIN);
    } finally {
      if (prev === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = prev;
    }
  });
});
