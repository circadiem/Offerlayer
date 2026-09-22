import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { loadEnv, openDatabase, seedDatabase } from "@offerlayer/db";
import { createApp } from "../apps/api/src/app.ts";

async function req(
  base: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${JSON.stringify(body)}`);
  }
  return { status: res.status, body };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "offerlayer-agentic-demo-"));
  const env = loadEnv({ DATABASE_URL: `file:${join(dir, "demo.db")}` });
  const handle = openDatabase(env);
  const keys = seedDatabase(handle);
  const app = createApp(handle);
  let stop: (() => void) | undefined;
  const port = await new Promise<number>((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve(info.port));
    stop = () => {
      server.close();
      handle.sqlite.close();
    };
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    const shopper = keys.demoAgentKey;

    const offerDoc = await req(base, "/v1/offers/off_towel_organic_set");
    const checkoutDoc = (offerDoc.body.checkout ?? {}) as { ucp?: boolean; tracked_url_template?: string };
    process.stdout.write(`offer_checkout_ucp ${checkoutDoc.ucp}\n`);
    process.stdout.write(`offer_tracked_url ${checkoutDoc.tracked_url_template}\n`);

    const first = await req(base, "/v1/checkouts", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${shopper}` },
      body: JSON.stringify({ offer_id: "off_towel_organic_set", principal_ref: "agentic-one" }),
    });
    const checkout = first.body.checkout as {
      permalink: string;
      agentic: Record<string, unknown>;
    };
    const token = first.body.token as string;
    if (first.body.checkout_url !== checkout.permalink) {
      throw new Error("checkout_url must equal checkout.permalink");
    }
    process.stdout.write(`permalink ${checkout.permalink}\n`);
    process.stdout.write(`agentic ${JSON.stringify(checkout.agentic, null, 2)}\n`);

    const paidNote = JSON.stringify({
      id: 94001,
      total_price: "32.00",
      currency: "USD",
      email: "buyer@example.com",
      note_attributes: [{ name: "agent_ref", value: token }],
    });
    const hmacNote = createHmac("sha256", env.shopifyApiSecret).update(paidNote, "utf8").digest("base64");
    const noteHook = await req(base, "/v1/webhooks/shopify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-topic": "orders/paid",
        "x-shopify-hmac-sha256": hmacNote,
      },
      body: paidNote,
    });
    const noteStatus = (noteHook.body.conversion as { status: string }).status;
    if (noteStatus !== "pending_hold") throw new Error(`note_attributes expected pending_hold, got ${noteStatus}`);
    process.stdout.write(`webhook_note_attributes ${noteStatus}\n`);

    const second = await req(base, "/v1/checkouts", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${shopper}` },
      body: JSON.stringify({ offer_id: "off_towel_organic_set", principal_ref: "agentic-two" }),
    });
    const token2 = second.body.token as string;
    const paidLand = JSON.stringify({
      id: 94002,
      total_price: "32.00",
      currency: "USD",
      landing_site: `/?utm_content=${token2}`,
    });
    const hmacLand = createHmac("sha256", env.shopifyApiSecret).update(paidLand, "utf8").digest("base64");
    const landHook = await req(base, "/v1/webhooks/shopify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-topic": "orders/paid",
        "x-shopify-hmac-sha256": hmacLand,
      },
      body: paidLand,
    });
    const landStatus = (landHook.body.conversion as { status: string }).status;
    if (landStatus !== "pending_hold") throw new Error(`landing_site expected pending_hold, got ${landStatus}`);
    process.stdout.write(`webhook_landing_site ${landStatus}\n`);
    process.stdout.write("demo_agentic_exit:0\n");
  } finally {
    stop?.();
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : err}\n`);
  process.exit(1);
});
