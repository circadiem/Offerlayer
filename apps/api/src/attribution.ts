import { fromCents } from "@offerlayer/schema";

/** One order line counted toward an offer, with its post-discount amount. */
export type AttributedLine = { id: string; amount: string };

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(rec).filter((r): r is Record<string, unknown> => r !== null)
    : [];
}

/**
 * Shopify sends money as decimal strings ("32.00"), occasionally as numbers.
 * Parse to integer cents without going through floats; extra decimals are
 * truncated. Anything unparseable is null.
 */
export function moneyCents(value: unknown): bigint | null {
  const raw = typeof value === "number" ? String(value) : value;
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(-)?(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const cents = BigInt(m[2]) * 100n + BigInt(((m[3] ?? "") + "00").slice(0, 2));
  return m[1] ? -cents : cents;
}

function numericId(value: unknown): string | null {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return null;
  return value.match(/(\d+)\s*$/)?.[1] ?? null;
}

/** The order object, whether the payload is the order or wraps it. */
export function orderObject(payload: unknown): Record<string, unknown> {
  const outer = rec(payload) ?? {};
  return rec(outer.order) && !Array.isArray(outer.line_items) ? (rec(outer.order) ?? outer) : outer;
}

function lineAmount(line: Record<string, unknown>): bigint {
  const price = moneyCents(line.price) ?? 0n;
  const qty = BigInt(
    typeof line.quantity === "number" && line.quantity > 0 ? Math.floor(line.quantity) : 1,
  );
  const allocations = list(line.discount_allocations);
  const discount =
    allocations.length > 0
      ? allocations.reduce((sum, a) => sum + (moneyCents(a.amount) ?? 0n), 0n)
      : (moneyCents(line.total_discount) ?? 0n);
  const net = price * qty - discount;
  return net > 0n ? net : 0n;
}

/**
 * Work out which of an order's lines the offer drove, and what they came to.
 *
 * 1. If our single-use discount code is on the order, the lines Shopify
 *    allocated it to are exactly the eligible lines, for any selector type.
 * 2. Otherwise match the offer selector: product ids / variant ids for a
 *    product selector; every line for a shop selector. A collection selector
 *    cannot be checked from the webhook alone, so it also counts every line.
 *
 * Returns null when the payload carries no line items (simulated purchases,
 * legacy fixtures); the caller then falls back to the order total.
 */
export function attributeOrder(
  payload: unknown,
  offer: { selectorType: string; selectorIds: string[]; discountCode?: string | null },
): { total: string; lines: AttributedLine[] } | null {
  const order = orderObject(payload);
  const lines = list(order.line_items);
  if (lines.length === 0) return null;

  let picked: Record<string, unknown>[] | null = null;
  if (offer.discountCode) {
    const want = offer.discountCode.toUpperCase();
    const index = list(order.discount_applications).findIndex(
      (app) => typeof app.code === "string" && app.code.toUpperCase() === want,
    );
    if (index >= 0) {
      picked = lines.filter((line) =>
        list(line.discount_allocations).some((a) => Number(a.discount_application_index) === index),
      );
    }
  }
  if (!picked) {
    if (offer.selectorType === "product") {
      const productIds = new Set<string>();
      const variantIds = new Set<string>();
      for (const id of offer.selectorIds) {
        const n = numericId(id);
        if (!n) continue;
        if (/ProductVariant/i.test(id)) variantIds.add(n);
        else productIds.add(n);
      }
      picked = lines.filter((line) => {
        const p = numericId(line.product_id);
        const v = numericId(line.variant_id);
        return (p !== null && productIds.has(p)) || (v !== null && variantIds.has(v));
      });
    } else {
      picked = lines;
    }
  }

  const out: AttributedLine[] = picked.map((line) => ({
    id: numericId(line.id) ?? String(line.id ?? ""),
    amount: fromCents(lineAmount(line)),
  }));
  const total = picked.reduce((sum, line) => sum + lineAmount(line), 0n);
  return { total: fromCents(total), lines: out };
}

/**
 * How much of a refund falls on the attributed lines.
 *
 * - Line-item refunds: sum the refunded subtotals of attributed lines (each
 *   capped at what that line was attributed). With no stored lines (the whole
 *   order was attributed), every refunded line counts.
 * - Amount-only refunds (no line items): prorate the refunded amount by the
 *   attributed share of the order.
 */
export function attributedRefund(
  payload: unknown,
  stored: { total: string; orderTotal: string | null; lines: AttributedLine[] | null },
): bigint {
  const refund = rec(payload) ?? {};
  const refundLines = list(refund.refund_line_items);
  if (refundLines.length > 0) {
    const caps = stored.lines
      ? new Map(stored.lines.map((l) => [l.id, moneyCents(l.amount) ?? 0n]))
      : null;
    let sum = 0n;
    for (const rl of refundLines) {
      const lineId = numericId(rl.line_item_id) ?? numericId(rec(rl.line_item)?.id);
      const amount = moneyCents(rl.subtotal) ?? 0n;
      if (!caps) {
        sum += amount;
        continue;
      }
      if (!lineId || !caps.has(lineId)) continue;
      const cap = caps.get(lineId) ?? 0n;
      sum += amount < cap ? amount : cap;
    }
    return sum;
  }
  const refunded = list(refund.transactions)
    .filter((t) => t.kind === undefined || t.kind === "refund")
    .filter((t) => t.status === undefined || t.status === "success")
    .reduce((sum, t) => sum + (moneyCents(t.amount) ?? 0n), 0n);
  if (refunded <= 0n) return 0n;
  const attributed = moneyCents(stored.total) ?? 0n;
  const whole = stored.orderTotal ? (moneyCents(stored.orderTotal) ?? 0n) : 0n;
  if (whole <= 0n || attributed >= whole) return refunded;
  return (refunded * attributed) / whole;
}
