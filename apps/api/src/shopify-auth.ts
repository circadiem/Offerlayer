import type { Hono } from "hono";
import type { DbHandle } from "@offerlayer/db";
import { jsonError } from "./errors.ts";
import { requestPublicOrigin } from "./origin.ts";
import { completeLink } from "./seller.ts";
import {
  authorizeUrl,
  exchangeCodeForToken,
  fetchShopInfo,
  normalizeShopDomain,
  registerWebhooks,
  verifyOAuthHmac,
} from "./shopify-admin.ts";

const COOKIE = "ol_seller_link";

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500&family=Source+Sans+3:wght@400;500;600&display=swap"/>
<style>
  :root { --bg:#0a0a0b; --fg:#f4f4f5; --muted:#a1a1aa; --line:rgba(244,244,245,.12); --accent:#c8ccd4; --elev:#121214; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 "Source Sans 3", system-ui, sans-serif; }
  main { max-width: 36rem; margin: 0 auto; padding: 3rem 1.25rem; }
  h1 { font-family: Fraunces, Georgia, serif; font-weight:500; letter-spacing:-0.03em; font-size:2rem; }
  .card { border:1px solid var(--line); background:var(--elev); border-radius:1rem; padding:1.25rem; margin-top:1.5rem; }
  .muted { color:var(--muted); }
  code { font-family: ui-monospace, monospace; font-size:13px; word-break:break-all; }
  button, .btn { display:inline-flex; align-items:center; justify-content:center; min-height:44px; padding:0 16px; border-radius:8px; border:0; background:var(--accent); color:var(--bg); font-weight:600; cursor:pointer; text-decoration:none; }
  input { width:100%; min-height:44px; background:var(--elev); color:var(--fg); border:1px solid var(--line); border-radius:8px; padding:10px 12px; }
  label { display:block; font-size:13px; color:var(--muted); margin:16px 0 6px; }
</style></head>
<body>${body}</body></html>`;
}

function cookieSellerLink(header: string | undefined): string {
  if (!header) return "";
  const match = header.match(/(?:^|;\s*)ol_seller_link=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

export function installLoginHtml(args: {
  shop: string;
  sellerLink: string;
  completeHint: string;
  oauthConfigured: boolean;
}): string {
  const { shop, sellerLink, completeHint, oauthConfigured } = args;
  const demoForm = sellerLink
    ? `<form class="card" method="post" action="/auth/demo-complete">
         <input type="hidden" name="seller_link" value="${sellerLink}" />
         <input type="hidden" name="shop" value="${shop}" />
         <p class="muted">No Partner app is linked. Complete the seller grant on the demo path — the human still has to click this. There is no agent-only install.</p>
         <p><button type="submit">Approve demo install</button></p>
       </form>`
    : "";
  return page(
    "Approve Offerlayer install",
    `<main>
  <p class="muted" style="letter-spacing:.18em; text-transform:uppercase; font-size:12px;">Seller bind</p>
  <h1>Approve this shop install</h1>
  <p class="muted">Your human must approve this Shopify install. You cannot publish offers until they do. There is no agent-only install.</p>
  <div class="card">
    <p>Shop: <strong>${shop}</strong></p>
    <p class="muted">${sellerLink ? `Link ${sellerLink}` : "No seller_link in this URL."}</p>
    <p>After you say yes in chat, the seller agent calls:</p>
    <p><code>POST ${completeHint}</code></p>
    <p class="muted">Bearer: the seller key. Body: {"shop_domain":"${shop}"}</p>
    ${
      oauthConfigured
        ? `<p class="muted">Partners app is configured. Opening this URL with a shop domain sends the human to Shopify OAuth. The callback writes the seller link through automatically.</p>`
        : `<p class="muted">Set SHOPIFY_API_KEY, SHOPIFY_API_SECRET, and APP_URL on the host to send this human to a real Shopify consent screen.</p>`
    }
  </div>
  ${demoForm}
</main>`,
  );
}

export function registerShopifyAuthRoutes(app: Hono, handle: DbHandle) {
  app.get("/auth/login", (c) => {
    const rawShop = c.req.query("shop") || "demo-towels.myshopify.com";
    const sellerLink = c.req.query("seller_link") ?? "";
    const origin = requestPublicOrigin(c.req, handle.env);
    const completeHint = sellerLink
      ? `${origin}/v1/seller/links/${sellerLink}/complete`
      : `${origin}/v1/seller/links/{id}/complete`;
    const oauthConfigured = Boolean(handle.env.shopifyApiKey);
    const forceDemo = c.req.query("force_demo") === "1";
    if (oauthConfigured && !forceDemo && c.req.query("shop")) {
      let shop: string;
      try {
        shop = normalizeShopDomain(rawShop);
      } catch {
        throw jsonError("INVALID_SHOP", "Shop domain must be example.myshopify.com", 400);
      }
      const redirectUri = `${origin}/auth/callback`;
      const url = authorizeUrl({
        shop,
        clientId: handle.env.shopifyApiKey,
        scopes: handle.env.shopifyScopes,
        redirectUri,
        state: sellerLink,
      });
      if (sellerLink) {
        const secure = origin.startsWith("https") ? "; Secure" : "";
        c.header(
          "set-cookie",
          `${COOKIE}=${encodeURIComponent(sellerLink)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600${secure}`,
        );
      }
      return c.redirect(url, 302);
    }
    c.header("content-type", "text/html; charset=utf-8");
    return c.html(
      installLoginHtml({
        shop: rawShop,
        sellerLink,
        completeHint,
        oauthConfigured,
      }),
    );
  });

  app.get("/auth/callback", async (c) => {
    const origin = requestPublicOrigin(c.req, handle.env);
    const query: Record<string, string> = {};
    const url = new URL(c.req.url);
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });
    const shopRaw = query.shop || "";
    const code = query.code || "";
    const sellerLink =
      query.state || query.seller_link || cookieSellerLink(c.req.header("cookie"));

    if (!handle.env.shopifyApiKey) {
      c.header("content-type", "text/html; charset=utf-8");
      return c.html(
        page(
          "OAuth callback",
          `<main><h1>OAuth callback</h1><p class="muted">Partners credentials are not configured. Use the demo install path.</p></main>`,
        ),
        400,
      );
    }

    if (!verifyOAuthHmac(query, handle.env.shopifyApiSecret)) {
      throw jsonError("HMAC_INVALID", "Shopify OAuth HMAC verification failed", 401);
    }

    let shop: string;
    try {
      shop = normalizeShopDomain(shopRaw);
    } catch {
      throw jsonError("INVALID_SHOP", "Shop domain missing from callback", 400);
    }
    if (!code) throw jsonError("INVALID_CALLBACK", "Missing OAuth code", 400);
    if (!sellerLink) throw jsonError("LINK_REQUIRED", "Missing seller_link on OAuth callback", 400);

    const token = await exchangeCodeForToken({
      shop,
      code,
      clientId: handle.env.shopifyApiKey,
      clientSecret: handle.env.shopifyApiSecret,
    });
    const info = await fetchShopInfo({ shop, accessToken: token.access_token });
    const connected = completeLink(handle, sellerLink, shop, {
      shopifyShopId: info.id ? `gid://shopify/Shop/${info.id}` : null,
      accessToken: token.access_token,
      name: info.name,
    });
    const webhookUri = `${origin}/v1/webhooks/shopify`;
    const hooks = await registerWebhooks({
      shop,
      accessToken: token.access_token,
      webhookUri,
    }).catch(() => []);

    c.header("content-type", "text/html; charset=utf-8");
    return c.html(
      page(
        "Shop connected",
        `<main>
          <p class="muted" style="letter-spacing:.18em; text-transform:uppercase; font-size:12px;">Seller bind</p>
          <h1>Shop connected</h1>
          <div class="card">
            <p>${connected.shop_domain} is bound to this seller agent.</p>
            <p class="muted">Link ${connected.pending_link_id} · merchant ${connected.merchant_id}</p>
            <p class="muted">Webhooks ${hooks.filter((h) => h.ok).map((h) => h.topic).join(", ") || "will retry on next install"}: ${webhookUri}</p>
            <p class="muted">Publish offers on a real product gid from this shop, not Product/1001.</p>
          </div>
        </main>`,
      ),
    );
  });

  app.post("/auth/demo-complete", async (c) => {
    const form = await c.req.parseBody();
    const sellerLink = String(form.seller_link ?? "");
    const shopRaw = String(form.shop ?? "demo-towels.myshopify.com");
    if (!sellerLink) return c.redirect("/auth/login");
    let shop = shopRaw;
    try {
      shop = normalizeShopDomain(shopRaw);
    } catch {
      shop = shopRaw;
    }
    try {
      completeLink(handle, sellerLink, shop);
    } catch {
      // still show the page
    }
    c.header("content-type", "text/html; charset=utf-8");
    return c.html(
      page(
        "Demo shop connected",
        `<main><h1>Demo shop connected</h1><p class="muted">${shop} granted. This path does not store a Shopify access token.</p></main>`,
      ),
    );
  });
}
