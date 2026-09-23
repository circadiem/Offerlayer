export type Offer = {
  id: string;
  protocol: string;
  merchant: { shop_domain: string; name: string; website?: string };
  status: "draft" | "live" | "paused";
  selector: {
    type: string;
    ids?: string[];
    title?: string;
    currency?: string;
    list_price?: string;
  };
  reward: { type: string; amount: string; currency: string; recipient: string };
  finder_fee?: { type: string; amount: string; currency: string; recipient: string };
  constraints: {
    clawback_days: number;
    ship_to?: string[];
    max_per_principal_per_day?: number;
    new_customer_only?: boolean;
  };
  checkout: { tracked_url_template: string; ucp?: boolean };
  disclosure: string;
};

export type Conversion = {
  token: string;
  status: string;
  order_total?: string;
  currency?: string;
  reward_amount?: string;
  finder_fee_amount?: string;
  hold_until?: string;
  payouts?: { party: string; amount: string; status: string }[];
};

export type AgenticHandoff = {
  shop_domain: string;
  currency: string;
  line_items?: { quantity: number; item: { id: string } }[];
  attributes: { key: string; value: string }[];
  note: string;
  utm: {
    utm_source: string;
    utm_medium: string;
    utm_campaign: string;
    utm_content: string;
  };
  warning?: "NO_VARIANT_GID";
};

export type TrackedCheckout = {
  token: string;
  offer_id?: string;
  expires_at: string;
  checkout_url: string;
  disclosure: string;
  reward: Offer["reward"];
  finder_fee?: Offer["finder_fee"];
  checkout?: {
    permalink: string;
    agentic: AgenticHandoff;
  };
};

export const SEED_OFFER: Offer = {
  id: "off_towel_organic_set",
  protocol: "offerlayer/0.1",
  merchant: {
    shop_domain: "demo-towels.myshopify.com",
    name: "Demo Towels",
    website: "https://demo-towels.myshopify.com",
  },
  status: "live",
  selector: {
    type: "product",
    ids: ["gid://shopify/Product/1001"],
    title: "Organic Turkish Towel Set",
    currency: "USD",
    list_price: "32.00",
  },
  reward: { type: "percent", amount: "10", currency: "USD", recipient: "buyer" },
  finder_fee: { type: "percent", amount: "2", currency: "USD", recipient: "agent" },
  constraints: {
    clawback_days: 14,
    ship_to: ["US"],
    max_per_principal_per_day: 1,
    new_customer_only: false,
  },
  checkout: {
    tracked_url_template:
      "https://demo-towels.myshopify.com/cart/1001:1?attributes[agent_ref]={token}",
    ucp: false,
  },
  disclosure:
    "10% off this checkout of the Organic Turkish Towel Set. The code works once, on this cart only, and cannot be shared.",
};

function playground(role: "shopper" | "seller", json = false): Record<string, string> {
  const headers: Record<string, string> = { "x-offerlayer-playground": role };
  if (json) headers["content-type"] = "application/json";
  return headers;
}

async function parse<T>(res: Response): Promise<T> {
  const body = (await res.json()) as T & { error?: { code: string; message: string; card_text?: string } };
  if (!res.ok) {
    const extra = body.error?.card_text ? ` ${body.error.card_text}` : "";
    throw new Error(`${body.error?.message ?? `Request failed (${res.status})`}${extra}`);
  }
  return body;
}

export async function getHealth(): Promise<{ ok: boolean; version?: string }> {
  const res = await fetch("/health");
  return parse(res);
}

export async function searchOffers(q: string, shipTo = "US"): Promise<Offer[]> {
  const qs = new URLSearchParams({ q, ship_to: shipTo });
  const res = await fetch(`/v1/offers?${qs.toString()}`);
  const body = await parse<{ offers: Offer[] }>(res);
  return body.offers;
}

export async function createCheckout(offerId: string, principalRef?: string): Promise<TrackedCheckout> {
  const res = await fetch("/v1/checkouts", {
    method: "POST",
    headers: {
      ...playground("shopper", true),
    },
    body: JSON.stringify({ offer_id: offerId, principal_ref: principalRef }),
  });
  return parse(res);
}

export async function simulatePurchase(token: string, emailHash: string): Promise<Conversion> {
  const res = await fetch("/v1/simulate/purchase", {
    method: "POST",
    headers: {
      ...playground("shopper", true),
    },
    body: JSON.stringify({
      token,
      order_total: "32.00",
      currency: "USD",
      email_hash: emailHash,
    }),
  });
  return parse(res);
}

export async function simulateClear(token: string): Promise<Conversion> {
  const res = await fetch("/v1/simulate/clear", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...playground("shopper"),
    },
    body: JSON.stringify({ token }),
  });
  return parse(res);
}

export async function publishOffer(input: {
  title: string;
  list_price: string;
  reward_type: "flat" | "percent";
  reward_amount: string;
  finder_fee_amount: string;
  clawback_days: number;
  ship_to: string;
  new_customer_only: boolean;
  max_per_principal_per_day: number;
  disclosure: string;
  shop_domain: string;
}): Promise<Offer> {
  const res = await fetch("/v1/internal/offers", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...playground("shopper"),
    },
    body: JSON.stringify({
      shop_domain: input.shop_domain,
      merchant_name: input.shop_domain,
      status: "live",
      selector: {
        type: "product",
        ids: [`gid://shopify/Product/${Date.now()}`],
        title: input.title,
        currency: "USD",
        list_price: input.list_price,
      },
      reward: {
        type: input.reward_type,
        amount: input.reward_amount,
        currency: "USD",
        recipient: "buyer",
      },
      finder_fee: input.finder_fee_amount
        ? {
            type: "percent",
            amount: input.finder_fee_amount,
            currency: "USD",
            recipient: "agent",
          }
        : undefined,
      constraints: {
        new_customer_only: input.new_customer_only,
        ship_to: input.ship_to
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        max_per_principal_per_day: input.max_per_principal_per_day,
        clawback_days: input.clawback_days,
      },
      checkout: {
        tracked_url_template: `https://${input.shop_domain}/cart/1:1?attributes[agent_ref]={token}`,
      },
      disclosure: input.disclosure,
    }),
  });
  return parse(res);
}

export type SellerLink = {
  pending_link_id: string;
  install_url: string;
  expires_at?: string;
  disclosure: string;
  demo_complete_url?: string;
  status?: string;
  shop_domain?: string;
};

export type SellerShop = {
  merchant_id: string;
  shop_domain: string;
  name: string;
  grant_status: string;
  oauth_bound?: boolean;
  shopify_shop_id?: string | null;
};

export type CatalogProduct = {
  id: string;
  title: string;
  variant_id: string;
  list_price: string;
  currency: string;
  checkout_template: string;
};

export type SellerMe = {
  agent_id: string;
  role: string;
  name: string;
  shopify_oauth?: boolean;
  app_url?: string;
  redirect_uri?: string;
  webhook_uri?: string;
};

export type OfferPerformance = {
  offer_id: string;
  attributed_orders: number;
  pending_hold: { count: number; gmv: string; reward: string; finder_fee: string };
  cleared: { count: number; gmv: string; reward: string; finder_fee: string };
  clawed_back: { count: number; gmv: string };
};

export async function createSellerLink(shopDomain: string): Promise<SellerLink> {
  const res = await fetch("/v1/seller/links", {
    method: "POST",
    headers: {
      ...playground("seller", true),
    },
    body: JSON.stringify({ shop_domain: shopDomain }),
  });
  return parse(res);
}

export async function connectDemoShop(shopDomain: string): Promise<SellerLink> {
  const res = await fetch("/v1/simulate/connect_shop", {
    method: "POST",
    headers: {
      ...playground("seller", true),
    },
    body: JSON.stringify({ shop_domain: shopDomain }),
  });
  return parse(res);
}

export async function listSellerShops(): Promise<SellerShop[]> {
  const res = await fetch("/v1/seller/shops", {
    headers: playground("seller"),
  });
  const body = await parse<{ shops: SellerShop[] }>(res);
  return body.shops;
}

export async function getSellerMe(): Promise<SellerMe> {
  const res = await fetch("/v1/seller/me", {
    headers: playground("seller"),
  });
  return parse(res);
}

export async function simulateShopifyOauth(shopDomain: string): Promise<
  SellerLink & { merchant_id: string; products: CatalogProduct[]; oauth_bound?: boolean }
> {
  const res = await fetch("/v1/simulate/shopify_oauth", {
    method: "POST",
    headers: {
      ...playground("seller", true),
    },
    body: JSON.stringify({ shop_domain: shopDomain }),
  });
  return parse(res);
}

export async function listShopProducts(merchantId: string): Promise<CatalogProduct[]> {
  const res = await fetch(`/v1/seller/shops/${encodeURIComponent(merchantId)}/products`, {
    headers: playground("seller"),
  });
  const body = await parse<{ products: CatalogProduct[] }>(res);
  return body.products;
}

export async function createSellerOffer(input: {
  shop_domain: string;
  title: string;
  list_price: string;
  reward_amount: string;
  finder_fee_amount: string;
  disclosure?: string;
  product_id?: string;
  variant_id?: string;
  checkout_template?: string;
}): Promise<Offer> {
  const ids = [input.product_id, input.variant_id].filter((id): id is string => Boolean(id));
  const res = await fetch("/v1/seller/offers", {
    method: "POST",
    headers: {
      ...playground("seller", true),
    },
    body: JSON.stringify({
      shop_domain: input.shop_domain,
      status: "live",
      selector: {
        type: "product",
        ids: ids.length ? ids : ["gid://shopify/Product/1001"],
        title: input.title,
        currency: "USD",
        list_price: input.list_price,
      },
      reward: { type: "percent", amount: input.reward_amount, currency: "USD" },
      finder_fee: input.finder_fee_amount
        ? { type: "percent", amount: input.finder_fee_amount, currency: "USD" }
        : undefined,
      constraints: { clawback_days: 14, ship_to: ["US"] },
      checkout: input.checkout_template
        ? { tracked_url_template: input.checkout_template }
        : undefined,
      disclosure: input.disclosure,
    }),
  });
  return parse(res);
}

export async function getOfferPerformance(id: string): Promise<OfferPerformance> {
  const res = await fetch(`/v1/seller/offers/${encodeURIComponent(id)}/performance`, {
    headers: playground("seller"),
  });
  return parse(res);
}

export type Mandate = {
  id: string;
  status: string;
  card_text: string;
  shop_domain?: string;
  caps?: Record<string, string | number>;
  expires_at?: string;
};

export async function proposeMandate(shopDomain: string, productId = "gid://shopify/Product/1001"): Promise<Mandate> {
  const res = await fetch("/v1/seller/mandates", {
    method: "POST",
    headers: {
      ...playground("seller", true),
    },
    body: JSON.stringify({
      shop_domain: shopDomain,
      selector: { type: "product", ids: [productId] },
      caps: {
        max_reward_flat: "5.00",
        max_reward_percent: "15",
        max_finder_fee_flat: "2.00",
        max_finder_fee_percent: "3",
        max_daily_liability: "200.00",
        max_clawback_days: 14,
      },
    }),
  });
  return parse(res);
}

export async function activateMandate(id: string): Promise<Mandate> {
  const res = await fetch(`/v1/seller/mandates/${encodeURIComponent(id)}/activate`, {
    method: "POST",
    headers: {
      ...playground("seller", true),
    },
    body: JSON.stringify({ human_confirmed: true }),
  });
  return parse(res);
}

export async function tryExceedOffer(shopDomain: string, productId = "gid://shopify/Product/1001"): Promise<never> {
  const res = await fetch("/v1/seller/offers", {
    method: "POST",
    headers: {
      ...playground("seller", true),
    },
    body: JSON.stringify({
      shop_domain: shopDomain,
      status: "live",
      selector: {
        type: "product",
        ids: [productId],
        title: "Over-cap towels",
        currency: "USD",
        list_price: "32.00",
      },
      reward: { type: "flat", amount: "8.00", currency: "USD" },
      constraints: { clawback_days: 14, ship_to: ["US"] },
    }),
  });
  return parse(res);
}
