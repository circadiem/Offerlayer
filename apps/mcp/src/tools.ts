export const SHOPPER_TOOL_DEFS = [
  {
    name: "search_offers",
    description:
      "Search live merchant purchase offers. Always surface the `disclosure` field to the human in the same turn you present a product or ask for purchase approval. Do not silently rank by finder fee; prefer the offer that matches the human's constraints.",
  },
  {
    name: "get_offer",
    description:
      "Fetch one offer by id. Always show `disclosure` to the human before checkout. Do not hide the buyer reward or optional finder fee.",
  },
  {
    name: "create_tracked_checkout",
    description:
      "Attach a signed Offerlayer token to checkout for a live offer. Always show `disclosure` to the human and wait for their approval. Prefer checkout.agentic (attributes, note, utm) for native Muse / Shop Pay create_checkout. If the tool only takes a URL, use checkout.permalink. Do not open a second unpaid browser cart if Muse already started Shop Pay. Never auto-buy because a finder fee exists.",
  },
  {
    name: "refer_agent",
    description:
      "Create a one-hop referral token. The caller is recorded as `ref`. Finder fee still pays the presenting agent. Do not chain more than one hop.",
  },
  {
    name: "get_conversion",
    description:
      "Look up conversion status for an olt_ token. Status pending_hold means the buyer reward has not paid out yet — do not promise it has.",
  },
] as const;

const SELLER_PREFIX =
  "You are helping a shop owner list funded offers. Always show the draft disclosure and wait for the human to approve before setting status live. ";

export const SELLER_TOOL_DEFS = [
  {
    name: "create_shop_link",
    description:
      SELLER_PREFIX +
      "Create a Shopify install link for this seller. The human must open `install_url` and approve Shopify OAuth in the browser. When Partners credentials are set, that URL redirects to Shopify and GET /auth/callback writes the grant. Do not claim the shop is connected until list_seller_shops says so. Never complete OAuth yourself.",
  },
  {
    name: "get_shop_link",
    description: SELLER_PREFIX + "Get status of a pending or connected shop install link.",
  },
  {
    name: "list_seller_shops",
    description: SELLER_PREFIX + "List shops this seller may publish offers for. oauth_bound true means a Shopify access token is stored from a real (or simulated) OAuth callback.",
  },
  {
    name: "list_shop_products",
    description:
      SELLER_PREFIX +
      "List products for a granted shop. Use a real product gid and the returned checkout_template (variant cart URL with attributes[agent_ref]={token}). Do not publish gid://shopify/Product/1001 on a live store — that is the demo seed.",
  },
  {
    name: "create_offer",
    description:
      SELLER_PREFIX +
      "Create an offer for a granted shop. Echo `disclosure` in the result. Never set status live until the human has seen the disclosure and said yes. If the API returns MANDATE_REQUIRED or MANDATE_EXCEEDED, show error.card_text, call propose_mandate + activate_mandate after a human yes, then retry once. Do not retry in a loop.",
  },
  {
    name: "update_offer",
    description:
      SELLER_PREFIX +
      "Patch an offer the seller holds a grant on. If the API returns MANDATE_REQUIRED or MANDATE_EXCEEDED, show error.card_text and propose/activate a new mandate before retrying. Do not retry in a loop.",
  },
  {
    name: "pause_offer",
    description: SELLER_PREFIX + "Pause a live offer so public search no longer returns it.",
  },
  {
    name: "resume_offer",
    description:
      SELLER_PREFIX +
      "Resume a paused offer to live after disclosure is still valid. If the API returns MANDATE_REQUIRED or MANDATE_EXCEEDED, show error.card_text and propose/activate a mandate before retrying. Do not retry in a loop.",
  },
  {
    name: "list_my_offers",
    description: SELLER_PREFIX + "List offers this seller may manage.",
  },
  {
    name: "offer_performance",
    description:
      SELLER_PREFIX +
      "Attributed orders and payout buckets. pending_hold is not paid out yet — do not tell the shop owner it has cleared.",
  },
  {
    name: "propose_mandate",
    description:
      SELLER_PREFIX +
      "Propose a standing mandate (caps + selector + expiry). Always show the returned card_text verbatim on a Muse approval card. Do not activate until the human approves that exact text.",
  },
  {
    name: "activate_mandate",
    description:
      SELLER_PREFIX +
      "Activate a proposed mandate. Set human_confirmed true only after the human approved the exact card_text in this turn. Never set human_confirmed because you think they would agree.",
  },
  {
    name: "list_mandates",
    description: SELLER_PREFIX + "List standing mandates for this seller.",
  },
  {
    name: "revoke_mandate",
    description:
      SELLER_PREFIX +
      "Revoke an active mandate. Live offers stay live unless pause_offers is true. Further live writes need a new mandate. Do not auto-pause unless asked.",
  },
] as const;

export const TOOL_DEFS = [...SHOPPER_TOOL_DEFS, ...SELLER_TOOL_DEFS] as const;
export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);
export const SHOPPER_TOOL_NAMES = SHOPPER_TOOL_DEFS.map((t) => t.name);
export const SELLER_TOOL_NAMES = SELLER_TOOL_DEFS.map((t) => t.name);

export function toolsForKeys(opts: { agentKey?: string; sellerKey?: string }): string[] {
  const names: string[] = [];
  if (opts.agentKey) names.push(...SHOPPER_TOOL_NAMES);
  if (opts.sellerKey) names.push(...SELLER_TOOL_NAMES);
  if (!opts.agentKey && !opts.sellerKey) names.push(...SHOPPER_TOOL_NAMES);
  return names;
}
