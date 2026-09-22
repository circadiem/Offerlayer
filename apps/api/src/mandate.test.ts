import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, loadEnv, openDatabase, seedDatabase, type DbHandle } from "@offerlayer/db";
import { SELLER_TOOL_DEFS, SELLER_TOOL_NAMES } from "../../mcp/src/index.ts";
import { createApp } from "./app.ts";

const SHOP = "demo-towels.myshopify.com";
const TOWEL = "gid://shopify/Product/1001";

describe("offerlayer v0.2 mandates", () => {
  let handle: DbHandle;
  let app: ReturnType<typeof createApp>;
  let demoKey: string;
  let sellerKey: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "ol-man-"));
    const env = loadEnv({ DATABASE_URL: `file:${join(dir, "t.db")}` });
    handle = openDatabase(env);
    const keys = seedDatabase(handle);
    demoKey = keys.demoKey;
    sellerKey = keys.sellerAgentKey;
    app = createApp(handle);
  });

  afterEach(() => {
    closeDatabase(handle);
  });

  async function json(path: string, init: RequestInit = {}) {
    const res = await app.request(path, init);
    const body = await res.json();
    return { res, body };
  }

  function auth(extra: HeadersInit = {}): HeadersInit {
    return { "content-type": "application/json", authorization: `Bearer ${sellerKey}`, ...extra };
  }

  async function connect() {
    await json("/v1/simulate/connect_shop", {
      method: "POST",
      headers: auth({ "x-demo-key": demoKey }),
      body: JSON.stringify({ shop_domain: SHOP }),
    });
  }

  async function propose(caps: Record<string, unknown> = {}, selector: Record<string, unknown> = {}) {
    return json("/v1/seller/mandates", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        shop_domain: SHOP,
        selector: { type: "product", ids: [TOWEL], ...selector },
        caps: {
          max_reward_flat: "5.00",
          max_reward_percent: "15",
          max_finder_fee_flat: "2.00",
          max_finder_fee_percent: "3",
          max_daily_liability: "200.00",
          max_clawback_days: 14,
          ...caps,
        },
      }),
    });
  }

  it("propose returns proposed + card_text", async () => {
    await connect();
    const { res, body } = await propose();
    expect(res.status).toBe(201);
    expect(body.status).toBe("proposed");
    expect(body.id).toMatch(/^man_/);
    expect(typeof body.card_text).toBe("string");
    expect(body.card_text.length).toBeGreaterThan(40);
    expect(body.card_text).toContain(SHOP);
  });

  it("activate without human_confirmed is CONFIRMATION_REQUIRED", async () => {
    await connect();
    const proposed = await propose();
    const { res, body } = await json(`/v1/seller/mandates/${proposed.body.id}/activate`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("CONFIRMATION_REQUIRED");
  });

  it("activate with human_confirmed becomes active and supersedes prior", async () => {
    await connect();
    const first = await propose();
    const a1 = await json(`/v1/seller/mandates/${first.body.id}/activate`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ human_confirmed: true }),
    });
    expect(a1.res.status).toBe(200);
    expect(a1.body.status).toBe("active");
    expect(a1.body.human_confirmed_at).toBeTruthy();

    const second = await propose();
    const a2 = await json(`/v1/seller/mandates/${second.body.id}/activate`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ human_confirmed: true }),
    });
    expect(a2.body.status).toBe("active");
    const old = await json(`/v1/seller/mandates/${first.body.id}`, { headers: auth() });
    expect(old.body.status).toBe("revoked");
    expect(old.body.superseded_by).toBe(second.body.id);
  });

  it("live offer inside caps stores mandate_id; $8 and fat finder and wrong selector exceed; draft/pause without mandate", async () => {
    await connect();
    const proposed = await propose();
    await json(`/v1/seller/mandates/${proposed.body.id}/activate`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ human_confirmed: true }),
    });

    const ok = await json("/v1/seller/offers", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        shop_domain: SHOP,
        status: "live",
        selector: { type: "product", ids: [TOWEL], title: "Organic Turkish Towel Set", currency: "USD", list_price: "32.00" },
        reward: { type: "flat", amount: "4.00", currency: "USD" },
        finder_fee: { type: "percent", amount: "2", currency: "USD" },
        constraints: { clawback_days: 14, ship_to: ["US"] },
      }),
    });
    expect(ok.res.status).toBe(201);
    expect(ok.body.mandate_id).toBe(proposed.body.id);

    const high = await json("/v1/seller/offers", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        shop_domain: SHOP,
        status: "live",
        selector: { type: "product", ids: [TOWEL], title: "Too much", currency: "USD", list_price: "32.00" },
        reward: { type: "flat", amount: "8.00", currency: "USD" },
        constraints: { clawback_days: 14 },
      }),
    });
    expect(high.res.status).toBe(409);
    expect(high.body.error.code).toBe("MANDATE_EXCEEDED");
    expect(high.body.error.card_text).toBeTruthy();

    const fee = await json("/v1/seller/offers", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        shop_domain: SHOP,
        status: "live",
        selector: { type: "product", ids: [TOWEL], title: "Fee", currency: "USD", list_price: "32.00" },
        reward: { type: "flat", amount: "4.00", currency: "USD" },
        finder_fee: { type: "percent", amount: "10", currency: "USD" },
        constraints: { clawback_days: 14 },
      }),
    });
    expect(fee.res.status).toBe(409);
    expect(fee.body.error.code).toBe("MANDATE_EXCEEDED");

    const outside = await json("/v1/seller/offers", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        shop_domain: SHOP,
        status: "live",
        selector: { type: "product", ids: ["gid://shopify/Product/9999"], title: "Other", currency: "USD", list_price: "32.00" },
        reward: { type: "flat", amount: "4.00", currency: "USD" },
        constraints: { clawback_days: 14 },
      }),
    });
    expect(outside.res.status).toBe(409);
    expect(outside.body.error.code).toBe("MANDATE_EXCEEDED");

    await json(`/v1/seller/mandates/${proposed.body.id}/revoke`, { method: "POST", headers: auth() });

    const liveAfter = await json("/v1/seller/offers", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        shop_domain: SHOP,
        status: "live",
        selector: { type: "product", ids: [TOWEL], title: "After revoke", currency: "USD", list_price: "32.00" },
        reward: { type: "flat", amount: "4.00", currency: "USD" },
        constraints: { clawback_days: 14 },
      }),
    });
    expect(liveAfter.res.status).toBe(403);
    expect(liveAfter.body.error.code).toBe("MANDATE_REQUIRED");

    const draft = await json("/v1/seller/offers", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        shop_domain: SHOP,
        status: "draft",
        selector: { type: "product", ids: [TOWEL], title: "Draft towels", currency: "USD", list_price: "32.00" },
        reward: { type: "flat", amount: "4.00", currency: "USD" },
        constraints: { clawback_days: 14 },
      }),
    });
    expect(draft.res.status).toBe(201);
    const paused = await json(`/v1/seller/offers/${ok.body.id}/pause`, { method: "POST", headers: auth() });
    expect(paused.res.status).toBe(200);
  });

  it("expired mandate is treated as required-new", async () => {
    await connect();
    const past = new Date(Date.now() + 1000).toISOString();
    const proposed = await json("/v1/seller/mandates", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        shop_domain: SHOP,
        selector: { type: "product", ids: [TOWEL] },
        caps: { max_reward_flat: "5.00", max_reward_percent: "15", max_finder_fee_flat: "2.00", max_finder_fee_percent: "3", max_daily_liability: "200.00", max_clawback_days: 14 },
        expires_at: past,
      }),
    });
    await json(`/v1/seller/mandates/${proposed.body.id}/activate`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ human_confirmed: true }),
    });
    handle.sqlite.prepare("UPDATE mandates SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", proposed.body.id);
    const live = await json("/v1/seller/offers", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        shop_domain: SHOP,
        status: "live",
        selector: { type: "product", ids: [TOWEL], title: "Expired", currency: "USD", list_price: "32.00" },
        reward: { type: "flat", amount: "4.00", currency: "USD" },
        constraints: { clawback_days: 14 },
      }),
    });
    expect(live.res.status).toBe(403);
    expect(live.body.error.code).toBe("MANDATE_REQUIRED");
    const row = handle.sqlite.prepare("SELECT status FROM mandates WHERE id = ?").get(proposed.body.id) as { status: string };
    expect(row.status).toBe("expired");
  });

  it("MCP mandate tools and activate_mandate description", () => {
    expect(SELLER_TOOL_NAMES).toEqual(
      expect.arrayContaining(["propose_mandate", "activate_mandate", "list_mandates", "revoke_mandate"]),
    );
    const activate = SELLER_TOOL_DEFS.find((t) => t.name === "activate_mandate");
    expect(activate?.description).toContain("human_confirmed");
    expect(activate?.description.toLowerCase()).toContain("exact card_text");
    expect(activate?.description).toMatch(/only after the human approved/i);
  });
});
