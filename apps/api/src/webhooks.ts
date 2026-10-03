import { createHmac, timingSafeEqual } from "node:crypto";
import { eq, merchants, webhookEvents, type DbHandle } from "@offerlayer/db";
import { attributeOrder, attributedRefund, orderObject, type AttributedLine } from "./attribution.ts";
import { applyRefund, findOrder, findTokenRow, loadOffer, recordPaidOrder } from "./conversion-machine.ts";
import { ApiError, jsonError } from "./errors.ts";
import { logJson } from "./logger.ts";

export function verifyShopifyHmac(rawBody: string, hmacHeader: string | undefined, secret: string): boolean {
  if (!hmacHeader) return false;
  const digest = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(hmacHeader);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.startsWith("olt_")) return trimmed.split(/[\s&]/)[0] ?? trimmed;
  const match = trimmed.match(/olt_[A-Za-z0-9._~-]+/);
  return match ? match[0] : null;
}

function attrName(rec: Record<string, unknown>): string {
  return String(rec.name ?? rec.key ?? "").toLowerCase();
}

function attrsOf(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(asRecord(item)));
}

function tokenFromNamedAttrs(attrs: Record<string, unknown>[], names: string[]): string | null {
  const want = new Set(names.map((n) => n.toLowerCase()));
  for (const attr of attrs) {
    const name = attrName(attr);
    if (want.has(name) || (want.has("agent_ref") && (name === "attributes[agent_ref]" || name.endsWith("agent_ref")))) {
      const token = asToken(attr.value);
      if (token) return token;
    }
  }
  return null;
}

function namedAttrRaw(attrs: Record<string, unknown>[], names: string[]): string | null {
  const want = new Set(names.map((n) => n.toLowerCase()));
  for (const attr of attrs) {
    const name = attrName(attr);
    if (want.has(name) && typeof attr.value === "string" && attr.value.trim()) {
      return attr.value.trim();
    }
  }
  return null;
}

function collectNoteAttributes(order: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  out.push(...attrsOf(order.note_attributes));
  out.push(...attrsOf(order.noteAttributes));
  const inner = asRecord(order.order);
  if (inner) {
    out.push(...attrsOf(inner.note_attributes));
    out.push(...attrsOf(inner.noteAttributes));
  }
  const checkout = asRecord(order.checkout);
  if (checkout) {
    out.push(...attrsOf(checkout.note_attributes));
    out.push(...attrsOf(checkout.attributes));
  }
  out.push(...attrsOf(order.cart_attributes));
  return out;
}

function collectLineItemAttrs(order: Record<string, unknown>): Record<string, unknown>[] {
  const items = Array.isArray(order.line_items) ? order.line_items : [];
  const inner = asRecord(order.order);
  const innerItems = inner && Array.isArray(inner.line_items) ? inner.line_items : [];
  const out: Record<string, unknown>[] = [];
  for (const item of [...items, ...innerItems]) {
    const rec = asRecord(item);
    if (!rec) continue;
    out.push(...attrsOf(rec.properties));
  }
  return out;
}

function tokenFromUrlish(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = value.startsWith("http") ? new URL(value) : new URL(value, "https://example.myshopify.com");
    for (const key of ["utm_content", "agent_ref", "attributes[agent_ref]"]) {
      const token = asToken(url.searchParams.get(key));
      if (token) return token;
    }
  } catch {
    // fall through
  }
  return asToken(value);
}

function orderNote(order: Record<string, unknown>): string | null {
  if (typeof order.note === "string") return order.note;
  const inner = asRecord(order.order);
  if (inner && typeof inner.note === "string") return inner.note;
  return null;
}

/**
 * First valid olt_ wins:
 * 1. Cart / note attribute agent_ref
 * 2. offerlayer_offer is never a token (offer id only)
 * 3. Order note containing olt_
 * 4. landing_site / referring_site query utm_content or agent_ref
 * 5. Line item property agent_ref
 */
export function extractOrderToken(payload: unknown): string | null {
  const order = asRecord(payload);
  if (!order) return null;
  const notes = collectNoteAttributes(order);
  const fromAgentRef = tokenFromNamedAttrs(notes, ["agent_ref"]);
  if (fromAgentRef) return fromAgentRef;
  const note = orderNote(order);
  const fromNote = asToken(note);
  if (fromNote) return fromNote;
  for (const field of ["landing_site", "referring_site"] as const) {
    const inner = asRecord(order.order);
    const token = tokenFromUrlish(order[field]) ?? (inner ? tokenFromUrlish(inner[field]) : null);
    if (token) return token;
  }
  return tokenFromNamedAttrs(collectLineItemAttrs(order), ["agent_ref"]);
}

function shopifyOrderId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const rec = payload as Record<string, unknown>;
  if (typeof rec.order_id === "number" || typeof rec.order_id === "string") return String(rec.order_id);
  if (rec.order && typeof rec.order === "object") {
    const inner = rec.order as Record<string, unknown>;
    if (typeof inner.id === "number" || typeof inner.id === "string") return String(inner.id);
  }
  if (typeof rec.id === "number" || typeof rec.id === "string") return String(rec.id);
  return null;
}

function orderMoney(payload: unknown): { total: string; currency: string; email: string | null } {
  const rec = orderObject(payload);
  const totalRaw = rec.total_price ?? rec.current_total_price ?? "0.00";
  const total = typeof totalRaw === "string" ? totalRaw : String(totalRaw);
  const currency = typeof rec.currency === "string" ? rec.currency : "USD";
  const email = typeof rec.email === "string" && rec.email.trim() ? rec.email : null;
  return { total, currency, email };
}

function shopFromPayload(payload: unknown): string | null {
  const rec = asRecord(payload);
  if (!rec) return null;
  for (const key of ["myshopify_domain", "shop_domain", "shop"]) {
    if (typeof rec[key] === "string" && rec[key]) return rec[key] as string;
  }
  const inner = asRecord(rec.order);
  if (inner && typeof inner.shop === "string") return inner.shop;
  return null;
}

export type WebhookResult = {
  ok: true;
  conversion?: unknown;
  ignored?: boolean;
  reason?: string;
  duplicate?: boolean;
};

/**
 * Verified Shopify webhooks are the only production path that consumes a
 * token or records a paid order.
 *
 * Business rejections (unknown or spent token, wrong shop, cap hit) are
 * answered 200 with `ignored` and a reason: they are deterministic, and a
 * non-2xx would make Shopify retry for days and eventually drop the
 * subscription. Unexpected errors still return 5xx so Shopify retries.
 */
export function handleShopifyWebhook(
  handle: DbHandle,
  args: {
    topic: string;
    rawBody: string;
    hmac: string | undefined;
    shopDomain?: string | null;
    webhookId?: string | null;
  },
): WebhookResult {
  if (!verifyShopifyHmac(args.rawBody, args.hmac, handle.env.shopifyApiSecret)) {
    throw jsonError("HMAC_INVALID", "Shopify HMAC verification failed", 401);
  }
  let payload: unknown = {};
  try {
    payload = JSON.parse(args.rawBody);
  } catch {
    throw jsonError("INVALID_JSON", "Webhook body is not JSON", 400);
  }
  const topic = args.topic.toLowerCase();
  const shop = args.shopDomain?.trim().toLowerCase() || null;
  const webhookId = args.webhookId?.trim() || null;

  if (webhookId) {
    const seen = handle.db.select().from(webhookEvents).where(eq(webhookEvents.webhookId, webhookId)).get();
    if (seen) return { ...(JSON.parse(seen.resultJson) as WebhookResult), duplicate: true };
  }

  let result: WebhookResult;
  try {
    result = processWebhook(handle, topic, payload, shop);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status >= 500) throw err;
    logJson({
      level: "warn",
      msg: "WEBHOOK_REJECTED",
      topic,
      shop,
      order_id: shopifyOrderId(payload),
      reason: err.code,
    });
    result = { ok: true, ignored: true, reason: err.code };
  }

  if (webhookId) {
    handle.db
      .insert(webhookEvents)
      .values({
        webhookId,
        topic,
        shopDomain: shop,
        resultJson: JSON.stringify(result),
        receivedAt: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();
  }
  return result;
}

function processWebhook(handle: DbHandle, topic: string, payload: unknown, shop: string | null): WebhookResult {
  if (topic === "orders/paid") {
    const token = extractOrderToken(payload);
    if (!token) {
      const notes = collectNoteAttributes(asRecord(payload) ?? {});
      const offerHint = namedAttrRaw(notes, ["offerlayer_offer"]);
      logJson({
        level: "info",
        msg: "UNATTRIBUTED_PAID_ORDER",
        shop: shop ?? shopFromPayload(payload),
        order_id: shopifyOrderId(payload),
        ...(offerHint ? { offer_hint: offerHint } : {}),
      });
      return { ok: true, ignored: true };
    }
    if (!shop) throw jsonError("SHOP_DOMAIN_MISSING", "X-Shopify-Shop-Domain header is required", 400);
    const money = orderMoney(payload);
    let attributed: { total: string; lines: AttributedLine[] } | null = null;
    const tokenRow = findTokenRow(handle, token);
    if (tokenRow) {
      const { row } = loadOffer(handle, tokenRow.offerId);
      attributed = attributeOrder(payload, {
        selectorType: row.selectorType,
        selectorIds: JSON.parse(row.selectorIdsJson) as string[],
        discountCode: tokenRow.discountCode,
      });
    }
    const conversion = recordPaidOrder(handle, {
      token,
      orderTotal: attributed?.total ?? money.total,
      grossTotal: money.total,
      attributedLines: attributed?.lines ?? null,
      currency: money.currency,
      email: money.email,
      shopifyOrderId: shopifyOrderId(payload),
      expectedShop: shop,
      ignoreExpiry: true,
    });
    return { ok: true, conversion };
  }

  if (topic === "orders/cancelled" || topic === "refunds/create") {
    const token = extractOrderToken(payload);
    const order = findOrder(handle, {
      token: token ?? undefined,
      shopifyOrderId: shopifyOrderId(payload) ?? undefined,
    });
    if (!order) return { ok: true, ignored: true };
    const merchant = handle.db.select().from(merchants).where(eq(merchants.id, order.merchantId)).get();
    if (!shop || !merchant || merchant.shopDomain.toLowerCase() !== shop) {
      throw jsonError("SHOP_MISMATCH", "Order belongs to a different shop", 409);
    }
    if (topic === "orders/cancelled") {
      const result = applyRefund(handle, { order, full: true, refundId: "cancel" });
      return "ignored" in result ? { ok: true, ignored: true } : { ok: true, conversion: result };
    }
    const lines = order.attributedLinesJson ? (JSON.parse(order.attributedLinesJson) as AttributedLine[]) : null;
    const amountCents = attributedRefund(payload, {
      total: order.total,
      orderTotal: order.orderTotal,
      lines,
    });
    const refund = asRecord(payload);
    const refundId = refund && (typeof refund.id === "number" || typeof refund.id === "string") ? String(refund.id) : null;
    // A refunds/create payload with no line items and no transactions (older
    // fixtures) is treated as a full refund.
    const unspecified =
      !Array.isArray(refund?.refund_line_items) && !Array.isArray(refund?.transactions);
    const result = applyRefund(handle, unspecified ? { order, full: true, refundId } : { order, amountCents, refundId });
    return "ignored" in result ? { ok: true, ignored: true } : { ok: true, conversion: result };
  }
  return { ok: true, ignored: true };
}
