import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadEnv } from "@offerlayer/db";
import { authorizeUrl, normalizeShopDomain } from "../api/src/shopify-admin.ts";

const env = loadEnv();
const port = Number(process.env.SHOPIFY_APP_PORT ?? "3000");
const apiBase = process.env.OFFERLAYER_URL ?? `http://127.0.0.1:${env.port}`;

const app = new Hono();

const css = `
  :root { --bg:#0a0a0b; --elev:#121214; --fg:#f4f4f5; --muted:#a1a1aa; --line:rgba(244,244,245,.12); --accent:#c8ccd4; }
  * { box-sizing: border-box; }
  body { margin:0; font: 16px/1.5 "Source Sans 3", system-ui, sans-serif; background:var(--bg); color:var(--fg); }
  header { padding: 20px 24px; border-bottom: 1px solid var(--line); display:flex; justify-content:space-between; align-items:baseline; }
  h1,h2 { font-family: Fraunces, Georgia, serif; font-weight: 500; letter-spacing: -0.03em; }
  main { max-width: 720px; margin: 0 auto; padding: 32px 20px 80px; }
  label { display:block; font-size: 13px; color: var(--muted); margin: 16px 0 6px; }
  input, select, textarea { width:100%; min-height:44px; background:var(--elev); color:var(--fg); border:1px solid var(--line); border-radius:8px; padding: 10px 12px; }
  textarea { min-height: 96px; }
  button, .btn { display:inline-flex; align-items:center; justify-content:center; min-height:44px; padding: 0 16px; border-radius:8px; border:0; background:var(--accent); color:var(--bg); font-weight:600; cursor:pointer; text-decoration:none; }
  .ghost { background: transparent; color: var(--fg); border: 1px solid var(--line); }
  .card { background: var(--elev); border: 1px solid var(--line); border-radius: 16px; padding: 20px; margin: 16px 0; }
  .muted { color: var(--muted); font-size: 14px; }
  .err { color: #e8b4b4; }
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>${title}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Source+Sans+3:wght@400;500;600&display=swap"/>
  <style>${css}</style></head><body>${body}</body></html>`;
}

app.get("/", (c) => c.redirect("/app"));

app.get("/auth/login", (c) => {
  const shopRaw = c.req.query("shop") ?? "";
  const sellerLink = c.req.query("seller_link") ?? "";
  const configured = Boolean(env.shopifyApiKey);
  const appUrl = (env.shopifyAppUrl || env.publicBaseUrl || "").replace(/\/$/, "");
  const origin =
    appUrl && !/localhost|127\.0\.0\.1/i.test(appUrl) ? appUrl : "https://offerlayer.grok.me";
  const headers = new Headers();
  if (sellerLink) {
    headers.append(
      "set-cookie",
      `ol_seller_link=${encodeURIComponent(sellerLink)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`,
    );
  }
  if (configured && shopRaw) {
    const shop = normalizeShopDomain(shopRaw);
    const url = authorizeUrl({
      shop,
      clientId: env.shopifyApiKey,
      scopes: env.shopifyScopes,
      redirectUri: `${origin}/auth/callback`,
      state: sellerLink,
    });
    return c.redirect(url, 302);
  }
  const oauthHint = configured
    ? `Would redirect to Shopify OAuth for ${shopRaw || "your shop"} with scopes ${env.shopifyScopes}.`
    : "Shopify Partner credentials are not configured in this environment. The install route still boots so you can wire SHOPIFY_API_KEY / SHOPIFY_API_SECRET later. Offers can be published through the API with INTERNAL_API_KEY.";
  const shop = shopRaw || "demo-towels.myshopify.com";
  const demoComplete = sellerLink
    ? `<form class="card" method="post" action="/auth/demo-complete">
         <input type="hidden" name="seller_link" value="${sellerLink}" />
         <input type="hidden" name="shop" value="${shop || "demo-towels.myshopify.com"}" />
         <p class="muted">No Partner app is linked. Complete the seller grant on the demo path — the human still has to click this. There is no agent-only install.</p>
         <p><button type="submit">Approve demo install</button></p>
       </form>`
    : "";
  return c.html(
    page(
      "Install Offerlayer",
      `<header><h1>Offerlayer</h1><span class="muted">Shopify publisher</span></header>
       <main>
         <h2>Install</h2>
         <p class="muted">${oauthHint}</p>
         ${sellerLink ? `<p class="muted">Seller link <span>${sellerLink}</span> is stashed for the OAuth callback.</p>` : ""}
         <form class="card" method="get" action="/auth/login">
           <input type="hidden" name="seller_link" value="${sellerLink}" />
           <label for="shop">Shop domain</label>
           <input id="shop" name="shop" placeholder="example.myshopify.com" value="${shop}" required />
           <p style="margin-top:16px"><button type="submit">Begin OAuth install</button></p>
         </form>
         ${
           shop && configured
             ? `<p class="muted">OAuth authorize URL would be:<br/>https://${shop}/admin/oauth/authorize?client_id=${env.shopifyApiKey}&scope=${encodeURIComponent(env.shopifyScopes)}&redirect_uri=${encodeURIComponent(origin + "/auth/callback")}&state=${encodeURIComponent(sellerLink)}</p>`
             : ""
         }
         ${demoComplete}
         <p><a class="btn ghost" href="/app">Open merchant offers</a></p>
       </main>`,
    ),
    200,
    Object.fromEntries(headers),
  );
});

app.get("/auth/callback", async (c) => {
  const cookie = c.req.header("cookie") ?? "";
  const fromCookie = cookie.match(/(?:^|;\s*)ol_seller_link=([^;]+)/)?.[1];
  const sellerLink =
    c.req.query("seller_link") || c.req.query("state") || (fromCookie ? decodeURIComponent(fromCookie) : "");
  const shop = c.req.query("shop") || "demo-towels.myshopify.com";
  let grantNote = "No Partner app is linked. Session install is skipped.";
  if (sellerLink) {
    try {
      const res = await fetch(`${apiBase}/v1/seller/links/${encodeURIComponent(sellerLink)}/complete`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-key": env.internalApiKey,
        },
        body: JSON.stringify({ shop_domain: shop }),
      });
      grantNote = res.ok
        ? `Seller link ${sellerLink} completed for ${shop}.`
        : `Could not complete seller link (${res.status}). Demo path still works.`;
    } catch {
      grantNote = "Could not reach Offerlayer API to complete the seller link.";
    }
  }
  return c.html(
    page(
      "OAuth callback",
      `<main><h2>OAuth callback</h2><p class="muted">${grantNote} Continue to the offer form for local API publishing.</p><p><a class="btn" href="/app">Continue</a></p></main>`,
    ),
  );
});

app.post("/auth/demo-complete", async (c) => {
  const form = await c.req.parseBody();
  const sellerLink = String(form.seller_link ?? "");
  const shop = String(form.shop ?? "demo-towels.myshopify.com");
  if (!sellerLink) return c.redirect("/auth/login");
  await fetch(`${apiBase}/v1/seller/links/${encodeURIComponent(sellerLink)}/complete`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-key": env.internalApiKey,
    },
    body: JSON.stringify({ shop_domain: shop }),
  }).catch(() => undefined);
  return c.redirect("/app");
});

app.get("/app", async (c) => {
  let offers: { id: string; selector?: { title?: string }; status: string }[] = [];
  try {
    const res = await fetch(`${apiBase}/v1/offers?shop=demo-towels.myshopify.com`);
    const data = (await res.json()) as { offers?: typeof offers };
    offers = data.offers ?? [];
  } catch {
    offers = [];
  }
  const rows = offers
    .map(
      (o) =>
        `<div class="card"><strong>${o.selector?.title ?? o.id}</strong><div class="muted">${o.id} · ${o.status}</div></div>`,
    )
    .join("");
  return c.html(
    page(
      "Offerlayer offers",
      `<header><h1>Offerlayer</h1><a class="muted" href="/auth/login">Install</a></header>
       <main>
         <h2>Live offers</h2>
         ${rows || `<p class="muted">No live offers yet.</p>`}
         <p><a class="btn" href="/app/offers/new">New offer</a> <a class="btn ghost" href="/app/settings">Settings</a></p>
       </main>`,
    ),
  );
});

app.get("/app/offers/new", (c) => {
  return c.html(
    page(
      "New offer",
      `<header><h1>New offer</h1><a class="muted" href="/app">Back</a></header>
       <main>
         <form class="card" method="post" action="/app/offers">
           <label>Shop domain</label>
           <input name="shop_domain" value="demo-towels.myshopify.com" required />
           <label>Product title</label>
           <input name="title" value="Organic Turkish Towel Set" required />
           <label>List price</label>
           <input name="list_price" value="32.00" required />
           <label>Reward type</label>
           <select name="reward_type"><option value="flat" selected>flat $</option><option value="percent">percent</option></select>
           <label>Reward amount</label>
           <input name="reward_amount" value="4.00" required />
           <label>Finder fee type</label>
           <select name="finder_fee_type"><option value="percent" selected>percent</option><option value="flat">flat $</option></select>
           <label>Finder fee amount</label>
           <input name="finder_fee_amount" value="2" />
           <label>Clawback days</label>
           <input name="clawback_days" value="14" />
           <label>Ship-to (ISO2, comma separated)</label>
           <input name="ship_to" value="US" />
           <label>Max per principal per day</label>
           <input name="max_per_principal_per_day" value="1" />
           <label>New customer only</label>
           <select name="new_customer_only"><option value="false" selected>No</option><option value="true">Yes</option></select>
           <label>Disclosure (shown to the human before purchase)</label>
           <textarea name="disclosure" required>If you buy this product through a tracked checkout, the merchant funds a disclosed buyer reward after the refund hold. Finder fees, if any, are also disclosed. Nothing is paid on click.</textarea>
           <p style="margin-top:16px"><button type="submit">Publish live offer</button></p>
         </form>
       </main>`,
    ),
  );
});

app.post("/app/offers", async (c) => {
  const form = await c.req.parseBody();
  const shop = String(form.shop_domain ?? "");
  const payload = {
    shop_domain: shop,
    merchant_name: shop,
    status: "live",
    selector: {
      type: "product",
      ids: ["gid://shopify/Product/local"],
      title: String(form.title ?? "Untitled"),
      currency: "USD",
      list_price: String(form.list_price ?? "0.00"),
    },
    reward: {
      type: String(form.reward_type ?? "flat"),
      amount: String(form.reward_amount ?? "0.00"),
      currency: "USD",
      recipient: "buyer",
    },
    finder_fee: form.finder_fee_amount
      ? {
          type: String(form.finder_fee_type ?? "percent"),
          amount: String(form.finder_fee_amount),
          currency: "USD",
          recipient: "agent",
        }
      : undefined,
    constraints: {
      new_customer_only: String(form.new_customer_only) === "true",
      ship_to: String(form.ship_to ?? "US")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      max_per_principal_per_day: Number(form.max_per_principal_per_day ?? 1),
      clawback_days: Number(form.clawback_days ?? 14),
    },
    checkout: {
      tracked_url_template: `https://${shop}/cart/1:1?attributes[agent_ref]={token}`,
    },
    disclosure: String(form.disclosure ?? ""),
  };
  const res = await fetch(`${apiBase}/v1/internal/offers`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-demo-key": env.demoKey,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.text();
    return c.html(page("Error", `<main class="err"><p>Publish failed.</p><pre>${err}</pre></main>`), 400);
  }
  return c.redirect("/app");
});

app.get("/app/settings", (c) => {
  return c.html(
    page(
      "Settings",
      `<header><h1>Settings</h1><a class="muted" href="/app">Back</a></header>
       <main class="card">
         <p>Default clawback: 14 days</p>
         <p>Disclosure template: merchant-funded buyer reward after the refund hold; finder fees disclosed; never paid on click.</p>
         <p class="muted">Webhooks registered when a Partner app is configured: ORDERS_PAID, ORDERS_CANCELLED, REFUNDS_CREATE → ${apiBase}/v1/webhooks/shopify</p>
       </main>`,
    ),
  );
});

serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => {
  process.stdout.write(
    `${JSON.stringify({ level: "info", msg: "shopify_app_listen", port, oauth: "/auth/login" })}\n`,
  );
});
