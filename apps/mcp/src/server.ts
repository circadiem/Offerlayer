import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SELLER_TOOL_DEFS, SHOPPER_TOOL_DEFS, toolsForKeys } from "./tools.ts";

export interface McpOptions {
  apiBase: string;
  agentKey?: string;
  sellerKey?: string;
}

async function apiFetch(
  opts: McpOptions,
  path: string,
  init: RequestInit = {},
  key?: string,
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  const bearer = key ?? opts.agentKey ?? opts.sellerKey;
  if (bearer && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${bearer}`);
  }
  const res = await fetch(`${opts.apiBase}${path}`, { ...init, headers });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // keep text
  }
  if (!res.ok) {
    throw new Error(`Offerlayer API ${res.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return body;
}

function asText(data: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function createOfferlayerMcp(opts: McpOptions): McpServer {
  const server = new McpServer({ name: "offerlayer", version: "0.1.0" });
  const enabled = new Set(toolsForKeys(opts));
  const shopperDesc = (name: string) =>
    SHOPPER_TOOL_DEFS.find((t) => t.name === name)?.description ?? name;
  const sellerDesc = (name: string) =>
    SELLER_TOOL_DEFS.find((t) => t.name === name)?.description ?? name;

  if (enabled.has("search_offers")) {
    server.tool(
      "search_offers",
      shopperDesc("search_offers"),
      {
        q: z.string().optional(),
        ship_to: z.string().length(2).optional(),
        max_price: z.string().optional(),
        shop: z.string().optional(),
        product_id: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      async (args) => {
        const qs = new URLSearchParams();
        if (args.q) qs.set("q", args.q);
        if (args.ship_to) qs.set("ship_to", args.ship_to);
        if (args.max_price) qs.set("max_price", args.max_price);
        if (args.shop) qs.set("shop", args.shop);
        if (args.product_id) qs.set("product_id", args.product_id);
        if (args.limit) qs.set("limit", String(args.limit));
        const data = await apiFetch(opts, `/v1/offers?${qs.toString()}`);
        return asText(data);
      },
    );
  }

  if (enabled.has("get_offer")) {
    server.tool(
      "get_offer",
      shopperDesc("get_offer"),
      { id: z.string() },
      async (args) => asText(await apiFetch(opts, `/v1/offers/${encodeURIComponent(args.id)}`)),
    );
  }

  if (enabled.has("create_tracked_checkout")) {
    server.tool(
      "create_tracked_checkout",
      shopperDesc("create_tracked_checkout"),
      {
        offer_id: z.string(),
        principal_ref: z.string().optional(),
        return_url: z.string().optional(),
      },
      async (args) =>
        asText(
          await apiFetch(
            opts,
            "/v1/checkouts",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(args),
            },
            opts.agentKey,
          ),
        ),
    );
  }

  if (enabled.has("refer_agent")) {
    server.tool(
      "refer_agent",
      shopperDesc("refer_agent"),
      {
        offer_id: z.string(),
        to_agent_id: z.string().optional(),
      },
      async (args) =>
        asText(
          await apiFetch(
            opts,
            "/v1/refer",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(args),
            },
            opts.agentKey,
          ),
        ),
    );
  }

  if (enabled.has("get_conversion")) {
    server.tool(
      "get_conversion",
      shopperDesc("get_conversion"),
      { token: z.string() },
      async (args) =>
        asText(
          await apiFetch(opts, `/v1/conversions/${encodeURIComponent(args.token)}`, {}, opts.agentKey),
        ),
    );
  }

  if (enabled.has("create_shop_link")) {
    server.tool(
      "create_shop_link",
      sellerDesc("create_shop_link"),
      { shop_domain: z.string().optional() },
      async (args) =>
        asText(
          await apiFetch(
            opts,
            "/v1/seller/links",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(args),
            },
            opts.sellerKey,
          ),
        ),
    );
  }

  if (enabled.has("get_shop_link")) {
    server.tool(
      "get_shop_link",
      sellerDesc("get_shop_link"),
      { id: z.string() },
      async (args) =>
        asText(await apiFetch(opts, `/v1/seller/links/${encodeURIComponent(args.id)}`, {}, opts.sellerKey)),
    );
  }

  if (enabled.has("list_seller_shops")) {
    server.tool("list_seller_shops", sellerDesc("list_seller_shops"), {}, async () =>
      asText(await apiFetch(opts, "/v1/seller/shops", {}, opts.sellerKey)),
    );
  }

  if (enabled.has("list_shop_products")) {
    server.tool(
      "list_shop_products",
      sellerDesc("list_shop_products"),
      { merchant_id: z.string().optional(), shop_domain: z.string().optional() },
      async (args) => {
        const id = args.merchant_id || args.shop_domain;
        if (!id) throw new Error("merchant_id or shop_domain is required");
        return asText(
          await apiFetch(opts, `/v1/seller/shops/${encodeURIComponent(id)}/products`, {}, opts.sellerKey),
        );
      },
    );
  }

  if (enabled.has("create_offer")) {
    server.tool(
      "create_offer",
      sellerDesc("create_offer"),
      {
        shop_domain: z.string().optional(),
        merchant_id: z.string().optional(),
        status: z.enum(["draft", "live", "paused"]).optional(),
        title: z.string().optional(),
        list_price: z.string().optional(),
        reward_type: z.enum(["flat", "percent"]),
        reward_amount: z.string(),
        reward_currency: z.string().optional(),
        finder_fee_type: z.enum(["flat", "percent"]).optional(),
        finder_fee_amount: z.string().optional(),
        clawback_days: z.number().int().optional(),
        ship_to: z.array(z.string()).optional(),
        disclosure: z.string().optional(),
        checkout_url_template: z.string().optional(),
        product_id: z.string().optional(),
        variant_id: z.string().optional(),
      },
      async (args) => {
        const ids = args.product_id ? [args.product_id] : undefined;
        const template =
          args.checkout_url_template ??
          (args.variant_id && args.shop_domain
            ? `https://${args.shop_domain}/cart/${args.variant_id.replace(/\D/g, "")}:1?attributes[agent_ref]={token}`
            : undefined);
        const body = {
          shop_domain: args.shop_domain,
          merchant_id: args.merchant_id,
          status: args.status ?? "draft",
          selector: {
            type: "product" as const,
            ids,
            title: args.title,
            list_price: args.list_price,
            currency: "USD",
          },
          reward: {
            type: args.reward_type,
            amount: args.reward_amount,
            currency: args.reward_currency ?? "USD",
            recipient: "buyer" as const,
          },
          finder_fee:
            args.finder_fee_type && args.finder_fee_amount
              ? {
                  type: args.finder_fee_type,
                  amount: args.finder_fee_amount,
                  currency: "USD",
                  recipient: "agent" as const,
                }
              : undefined,
          constraints: {
            clawback_days: args.clawback_days ?? 14,
            ship_to: args.ship_to,
          },
          checkout: template ? { tracked_url_template: template } : undefined,
          disclosure: args.disclosure,
        };
        const data = await apiFetch(
          opts,
          "/v1/seller/offers",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
          opts.sellerKey,
        );
        return asText(data);
      },
    );
  }

  if (enabled.has("update_offer")) {
    server.tool(
      "update_offer",
      sellerDesc("update_offer"),
      {
        id: z.string(),
        status: z.enum(["draft", "live", "paused"]).optional(),
        disclosure: z.string().optional(),
      },
      async (args) => {
        const { id, ...patch } = args;
        return asText(
          await apiFetch(
            opts,
            `/v1/seller/offers/${encodeURIComponent(id)}`,
            {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(patch),
            },
            opts.sellerKey,
          ),
        );
      },
    );
  }

  if (enabled.has("pause_offer")) {
    server.tool("pause_offer", sellerDesc("pause_offer"), { id: z.string() }, async (args) =>
      asText(
        await apiFetch(
          opts,
          `/v1/seller/offers/${encodeURIComponent(args.id)}/pause`,
          { method: "POST" },
          opts.sellerKey,
        ),
      ),
    );
  }

  if (enabled.has("resume_offer")) {
    server.tool("resume_offer", sellerDesc("resume_offer"), { id: z.string() }, async (args) =>
      asText(
        await apiFetch(
          opts,
          `/v1/seller/offers/${encodeURIComponent(args.id)}/resume`,
          { method: "POST" },
          opts.sellerKey,
        ),
      ),
    );
  }

  if (enabled.has("list_my_offers")) {
    server.tool(
      "list_my_offers",
      sellerDesc("list_my_offers"),
      { shop_domain: z.string().optional(), status: z.string().optional() },
      async (args) => {
        const qs = new URLSearchParams();
        if (args.shop_domain) qs.set("shop_domain", args.shop_domain);
        if (args.status) qs.set("status", args.status);
        const suffix = qs.toString() ? `?${qs}` : "";
        return asText(await apiFetch(opts, `/v1/seller/offers${suffix}`, {}, opts.sellerKey));
      },
    );
  }

  if (enabled.has("offer_performance")) {
    server.tool("offer_performance", sellerDesc("offer_performance"), { id: z.string() }, async (args) =>
      asText(
        await apiFetch(
          opts,
          `/v1/seller/offers/${encodeURIComponent(args.id)}/performance`,
          {},
          opts.sellerKey,
        ),
      ),
    );
  }

  if (enabled.has("propose_mandate")) {
    server.tool(
      "propose_mandate",
      sellerDesc("propose_mandate"),
      {
        shop_domain: z.string().optional(),
        merchant_id: z.string().optional(),
        expires_at: z.string().optional(),
        selector_type: z.enum(["product", "collection", "shop"]),
        selector_ids: z.array(z.string()).optional(),
        max_reward_flat: z.string().optional(),
        max_reward_percent: z.string().optional(),
        max_finder_fee_flat: z.string().optional(),
        max_finder_fee_percent: z.string().optional(),
        max_daily_liability: z.string().optional(),
        max_clawback_days: z.number().int().optional(),
      },
      async (args) =>
        asText(
          await apiFetch(
            opts,
            "/v1/seller/mandates",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                shop_domain: args.shop_domain,
                merchant_id: args.merchant_id,
                expires_at: args.expires_at,
                selector: { type: args.selector_type, ids: args.selector_ids },
                caps: {
                  max_reward_flat: args.max_reward_flat,
                  max_reward_percent: args.max_reward_percent,
                  max_finder_fee_flat: args.max_finder_fee_flat,
                  max_finder_fee_percent: args.max_finder_fee_percent,
                  max_daily_liability: args.max_daily_liability,
                  max_clawback_days: args.max_clawback_days,
                },
              }),
            },
            opts.sellerKey,
          ),
        ),
    );
  }

  if (enabled.has("activate_mandate")) {
    server.tool(
      "activate_mandate",
      sellerDesc("activate_mandate"),
      {
        id: z.string(),
        human_confirmed: z.boolean(),
      },
      async (args) =>
        asText(
          await apiFetch(
            opts,
            `/v1/seller/mandates/${encodeURIComponent(args.id)}/activate`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ human_confirmed: args.human_confirmed }),
            },
            opts.sellerKey,
          ),
        ),
    );
  }

  if (enabled.has("list_mandates")) {
    server.tool(
      "list_mandates",
      sellerDesc("list_mandates"),
      { shop_domain: z.string().optional() },
      async (args) => {
        const qs = args.shop_domain ? `?shop_domain=${encodeURIComponent(args.shop_domain)}` : "";
        return asText(await apiFetch(opts, `/v1/seller/mandates${qs}`, {}, opts.sellerKey));
      },
    );
  }

  if (enabled.has("revoke_mandate")) {
    server.tool(
      "revoke_mandate",
      sellerDesc("revoke_mandate"),
      { id: z.string(), pause_offers: z.boolean().optional() },
      async (args) => {
        const qs = args.pause_offers ? "?pause_offers=true" : "";
        return asText(
          await apiFetch(
            opts,
            `/v1/seller/mandates/${encodeURIComponent(args.id)}/revoke${qs}`,
            { method: "POST" },
            opts.sellerKey,
          ),
        );
      },
    );
  }

  return server;
}
