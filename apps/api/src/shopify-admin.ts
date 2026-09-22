import { createHmac, timingSafeEqual } from "node:crypto";
import { decryptSecret, encryptSecret } from "@offerlayer/db";

export const SHOPIFY_API_VERSION = "2025-01";
export const WEBHOOK_TOPICS = ["orders/paid", "orders/cancelled", "refunds/create"] as const;

export type ShopifyFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const shopifyAdmin: { fetch: ShopifyFetch } = {
  fetch: (input, init) => globalThis.fetch(input, init),
};

export type CatalogProduct = {
  id: string;
  title: string;
  variant_id: string;
  list_price: string;
  currency: string;
  checkout_template: string;
};

/** Demo catalog for a real-looking shop — not the seed Product/1001. */
export const FIXTURE_CATALOG_PRODUCTS: Omit<CatalogProduct, "checkout_template">[] = [
  {
    id: "gid://shopify/Product/9001001",
    title: "Organic Turkish Towel Set",
    variant_id: "gid://shopify/ProductVariant/9002001",
    list_price: "32.00",
    currency: "USD",
  },
];

export function normalizeShopDomain(shop: string): string {
  let s = shop.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  const slash = s.indexOf("/");
  if (slash >= 0) s = s.slice(0, slash);
  s = s.replace(/:\d+$/, "");
  if (!s.includes(".")) s = `${s}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s)) {
    throw new Error(`Invalid shop domain: ${shop}`);
  }
  return s;
}

export function numericId(gidOrNum: string): string {
  return gidOrNum.match(/(\d+)\s*$/)?.[1] ?? (gidOrNum.replace(/\D/g, "") || "1");
}

export function trackedCartUrl(shopDomain: string, variantGidOrNumeric: string): string {
  const shop = shopDomain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return `https://${shop}/cart/${numericId(variantGidOrNumeric)}:1?attributes[agent_ref]={token}`;
}

export function withCheckoutTemplate(
  shopDomain: string,
  product: Omit<CatalogProduct, "checkout_template">,
): CatalogProduct {
  return { ...product, checkout_template: trackedCartUrl(shopDomain, product.variant_id) };
}

export function authorizeUrl(args: {
  shop: string;
  clientId: string;
  scopes: string;
  redirectUri: string;
  state: string;
}): string {
  const shop = normalizeShopDomain(args.shop);
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("scope", args.scopes);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("state", args.state);
  return url.toString();
}

export function verifyOAuthHmac(query: Record<string, string>, secret: string): boolean {
  const hmac = query.hmac;
  if (!hmac) return false;
  const message = Object.keys(query)
    .filter((k) => k !== "hmac" && k !== "signature")
    .sort()
    .map((k) => `${k}=${query[k]}`)
    .join("&");
  const digest = createHmac("sha256", secret).update(message).digest("hex");
  try {
    const a = Buffer.from(digest, "utf8");
    const b = Buffer.from(hmac, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function signOAuthQuery(query: Record<string, string>, secret: string): string {
  const message = Object.keys(query)
    .filter((k) => k !== "hmac" && k !== "signature")
    .sort()
    .map((k) => `${k}=${query[k]}`)
    .join("&");
  return createHmac("sha256", secret).update(message).digest("hex");
}

export function encryptAccessToken(token: string, secret: string): string {
  return encryptSecret(token, secret);
}

export function decryptAccessToken(blob: string, secret: string): string {
  return decryptSecret(blob, secret);
}

export async function exchangeCodeForToken(args: {
  shop: string;
  code: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ access_token: string; scope?: string }> {
  const shop = normalizeShopDomain(args.shop);
  const res = await shopifyAdmin.fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code: args.code,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; scope?: string; error?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(body.error || `Shopify token exchange failed (${res.status})`);
  }
  return { access_token: body.access_token, scope: body.scope };
}

export async function fetchShopInfo(args: {
  shop: string;
  accessToken: string;
}): Promise<{ id: string; name: string; domain: string }> {
  const shop = normalizeShopDomain(args.shop);
  const res = await shopifyAdmin.fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/shop.json`, {
    headers: { "x-shopify-access-token": args.accessToken, accept: "application/json" },
  });
  const body = (await res.json().catch(() => ({}))) as {
    shop?: { id?: number | string; name?: string; domain?: string; myshopify_domain?: string };
  };
  const info = body.shop;
  if (!res.ok || !info) {
    return { id: "", name: shop, domain: shop };
  }
  return {
    id: String(info.id ?? ""),
    name: info.name || shop,
    domain: info.myshopify_domain || info.domain || shop,
  };
}

export async function registerWebhooks(args: {
  shop: string;
  accessToken: string;
  webhookUri: string;
}): Promise<{ topic: string; ok: boolean }[]> {
  const shop = normalizeShopDomain(args.shop);
  const out: { topic: string; ok: boolean }[] = [];
  for (const topic of WEBHOOK_TOPICS) {
    try {
      const res = await shopifyAdmin.fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-shopify-access-token": args.accessToken,
        },
        body: JSON.stringify({
          webhook: {
            topic,
            address: args.webhookUri,
            format: "json",
          },
        }),
      });
      out.push({ topic, ok: res.ok || res.status === 422 });
    } catch {
      out.push({ topic, ok: false });
    }
  }
  return out;
}

const PRODUCTS_QUERY = `{
  products(first: 25) {
    nodes {
      id
      title
      variants(first: 1) {
        nodes { id price }
      }
    }
  }
}`;

export async function fetchShopProducts(args: {
  shop: string;
  accessToken: string;
}): Promise<CatalogProduct[]> {
  const shop = normalizeShopDomain(args.shop);
  const res = await shopifyAdmin.fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-shopify-access-token": args.accessToken,
    },
    body: JSON.stringify({ query: PRODUCTS_QUERY }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    data?: {
      products?: {
        nodes?: {
          id: string;
          title: string;
          variants?: { nodes?: { id: string; price?: string }[] };
        }[];
      };
    };
  };
  const nodes = body.data?.products?.nodes ?? [];
  return nodes.map((p) => {
    const variant = p.variants?.nodes?.[0];
    const variantId = variant?.id ?? p.id;
    const price = variant?.price ?? "0.00";
    const list = typeof price === "string" && price.includes(".") ? price : `${price}.00`;
    return withCheckoutTemplate(shop, {
      id: p.id,
      title: p.title,
      variant_id: variantId,
      list_price: /^\d+\.\d{2}$/.test(list) ? list : "0.00",
      currency: "USD",
    });
  });
}

export function parseCatalogJson(raw: string | null | undefined, shopDomain: string): CatalogProduct[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Omit<CatalogProduct, "checkout_template">[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map((p) => withCheckoutTemplate(shopDomain, p));
  } catch {
    return [];
  }
}
