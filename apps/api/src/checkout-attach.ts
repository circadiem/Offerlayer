import type { Offer } from "@offerlayer/schema";

const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/(\d+)$/i;
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/(\d+)$/i;

export type AgenticHandoff = {
  shop_domain: string;
  currency: string;
  line_items?: { quantity: number; item: { id: string } }[];
  attributes: { key: string; value: string }[];
  note: string;
  utm: {
    utm_source: "offerlayer";
    utm_medium: "agentic_commerce";
    utm_campaign: string;
    utm_content: string;
  };
  warning?: "NO_VARIANT_GID";
};

export type CheckoutHandoff = {
  permalink: string;
  agentic: AgenticHandoff;
};

export function cartNumericId(template: string): string | null {
  return template.match(/\/cart\/(\d+)/)?.[1] ?? null;
}

/** ProductVariant gid if we have one. Seed Product/1001 + cart/1001 is not a variant. */
export function resolveVariantGid(offer: Offer): string | null {
  for (const id of offer.selector.ids ?? []) {
    if (VARIANT_GID.test(id)) return id;
  }
  const cartNum = cartNumericId(offer.checkout.tracked_url_template);
  if (!cartNum) return null;
  const productNums = (offer.selector.ids ?? [])
    .map((id) => id.match(PRODUCT_GID)?.[1])
    .filter((n): n is string => Boolean(n));
  if (productNums.includes(cartNum)) return null;
  return `gid://shopify/ProductVariant/${cartNum}`;
}

export function shopSupportsShopPay(shopDomain: string): boolean {
  const host = shopDomain.replace(/^https?:\/\//, "").split("/")[0] ?? "";
  return /\.myshopify\.com$/i.test(host);
}

function stampToken(template: string, token: string): string {
  if (template.includes("{token}")) return template.replaceAll("{token}", token);
  const join = template.includes("?") ? "&" : "?";
  return `${template}${join}agent_ref=${encodeURIComponent(token)}`;
}

function appendQuery(url: string, params: Record<string, string>): string {
  const qs = new URLSearchParams(params).toString();
  if (!qs) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${qs}`;
}

export function buildPermalink(args: {
  template: string;
  token: string;
  offerId: string;
  shopDomain: string;
  discountCode?: string;
}): string {
  const stamped = stampToken(args.template, args.token);
  const extra: Record<string, string> = {
    utm_source: "offerlayer",
    utm_medium: "agentic_commerce",
    utm_campaign: args.offerId,
    utm_content: args.token,
  };
  if (args.discountCode) extra.discount = args.discountCode;
  if (shopSupportsShopPay(args.shopDomain)) extra.payment = "shop_pay";
  return appendQuery(stamped, extra);
}

export function buildCheckoutHandoff(args: {
  offer: Offer;
  token: string;
  discountCode?: string;
}): CheckoutHandoff {
  const shop = args.offer.merchant.shop_domain;
  const permalink = buildPermalink({
    template: args.offer.checkout.tracked_url_template,
    token: args.token,
    offerId: args.offer.id,
    shopDomain: shop,
    discountCode: args.discountCode,
  });
  const variantGid = resolveVariantGid(args.offer);
  const currency = args.offer.selector.currency ?? args.offer.reward.currency;
  const agentic: AgenticHandoff = {
    shop_domain: shop,
    currency,
    attributes: [
      { key: "agent_ref", value: args.token },
      { key: "offerlayer_offer", value: args.offer.id },
    ],
    note: `offerlayer ${args.token}`,
    utm: {
      utm_source: "offerlayer",
      utm_medium: "agentic_commerce",
      utm_campaign: args.offer.id,
      utm_content: args.token,
    },
  };
  if (variantGid) {
    agentic.line_items = [{ quantity: 1, item: { id: variantGid } }];
  } else {
    agentic.warning = "NO_VARIANT_GID";
  }
  return { permalink, agentic };
}
