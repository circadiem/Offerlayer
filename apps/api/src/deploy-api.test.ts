import { describe, expect, it } from "vitest";
import offerlayerApi from "../../../server/middleware/offerlayer-api.ts";
import { VERSION } from "./version.ts";

describe("production API middleware", () => {
  it("GET /health is 200 JSON without waiting on sqlite", async () => {
    const event = {
      url: new URL("https://offerlayer.grok.me/health"),
      req: new Request("https://offerlayer.grok.me/health"),
    };
    const res = (await offerlayerApi(event, async () => {
      throw new Error("should not fall through");
    })) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = await res.json();
    expect(body).toEqual({ ok: true, version: VERSION });
  });

  it("GET /v1/offers through middleware is 200 JSON", async () => {
    const event = {
      url: new URL("https://offerlayer.grok.me/v1/offers?q=towel&ship_to=US"),
      req: new Request("https://offerlayer.grok.me/v1/offers?q=towel&ship_to=US"),
    };
    const res = (await offerlayerApi(event, async () => {
      throw new Error("should not fall through");
    })) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { offers: { id: string }[] };
    expect(Array.isArray(body.offers)).toBe(true);
    expect(body.offers.some((o) => o.id === "off_towel_organic_set")).toBe(true);
  });

  it("POST /v1/seller/links through public Host rewrites off localhost", async () => {
    const event = {
      url: new URL("https://offerlayer.grok.me/v1/seller/links"),
      req: new Request("https://offerlayer.grok.me/v1/seller/links", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer agt_sell_demo_v0_offerlayer_seed",
        },
        body: JSON.stringify({ shop_domain: "demo-towels.myshopify.com" }),
      }),
    };
    const res = (await offerlayerApi(event, async () => {
      throw new Error("should not fall through");
    })) as Response;
    expect(res.status).toBe(201);
    const body = (await res.json()) as { install_url: string; demo_complete_url: string };
    expect(body.install_url).toMatch(/^https:\/\/offerlayer\.grok\.me\/auth\/login/);
    expect(body.demo_complete_url).toMatch(/^https:\/\/offerlayer\.grok\.me\/v1\/seller\/links\//);
    expect(body.install_url).not.toContain("localhost");
    expect(body.demo_complete_url).not.toContain("127.0.0.1");
  });

  it("GET /auth/login through middleware is the install HTML", async () => {
    const event = {
      url: new URL("https://offerlayer.grok.me/auth/login?seller_link=lnk_mw&shop=demo-towels.myshopify.com"),
      req: new Request("https://offerlayer.grok.me/auth/login?seller_link=lnk_mw&shop=demo-towels.myshopify.com"),
    };
    const res = (await offerlayerApi(event, async () => {
      throw new Error("should not fall through");
    })) as Response;
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Approve this shop install");
    expect(html).toContain("lnk_mw");
    expect(html).toContain("https://offerlayer.grok.me/v1/seller/links/lnk_mw/complete");
  });
});
