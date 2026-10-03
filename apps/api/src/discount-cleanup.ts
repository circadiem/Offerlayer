import {
  and,
  eq,
  isNotNull,
  isNull,
  lt,
  merchants,
  offers,
  tokens,
  type DbHandle,
} from "@offerlayer/db";
import { logJson } from "./logger.ts";
import { decryptAccessToken, deleteCheckoutDiscount } from "./shopify-admin.ts";

export type CleanupResult = { checked: number; deleted: number; failed: number };

/**
 * Delete the Shopify discount behind every checkout token that expired
 * without being used. The codes already stop working at their endsAt; this
 * keeps them out of the merchant's Discounts list.
 *
 * Failures are recorded on the token row and retried on the next run.
 */
export async function cleanupExpiredDiscounts(
  handle: DbHandle,
  opts: { now?: Date; limit?: number } = {},
): Promise<CleanupResult> {
  const now = opts.now ?? new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const rows = handle.db
    .select({
      tokenId: tokens.tokenId,
      nodeId: tokens.discountNodeId,
      shopDomain: merchants.shopDomain,
      accessTokenEnc: merchants.accessTokenEnc,
    })
    .from(tokens)
    .innerJoin(offers, eq(offers.id, tokens.offerId))
    .innerJoin(merchants, eq(merchants.id, offers.merchantId))
    .where(
      and(
        isNotNull(tokens.discountNodeId),
        isNull(tokens.discountDeletedAt),
        isNull(tokens.consumedAt),
        lt(tokens.exp, nowSec),
      ),
    )
    .limit(opts.limit ?? 250)
    .all();

  const result: CleanupResult = { checked: rows.length, deleted: 0, failed: 0 };
  for (const row of rows) {
    let error: string | null = null;
    if (!row.accessTokenEnc || !row.nodeId) {
      error = "shop has no access token";
    } else {
      try {
        const accessToken = decryptAccessToken(
          row.accessTokenEnc,
          handle.env.accessTokenEncryptionKey,
          handle.env.accessTokenEncryptionKeyPrevious,
        );
        const res = await deleteCheckoutDiscount({
          shop: row.shopDomain,
          accessToken,
          nodeId: row.nodeId,
        });
        if (!res.ok) error = res.error;
      } catch (err) {
        error = err instanceof Error ? err.message : "delete failed";
      }
    }
    if (error) {
      result.failed += 1;
      handle.db
        .update(tokens)
        .set({ discountCleanupError: error })
        .where(eq(tokens.tokenId, row.tokenId))
        .run();
    } else {
      result.deleted += 1;
      handle.db
        .update(tokens)
        .set({ discountDeletedAt: now.toISOString(), discountCleanupError: null })
        .where(eq(tokens.tokenId, row.tokenId))
        .run();
    }
  }
  logJson({ level: result.failed > 0 ? "warn" : "info", msg: "discount_cleanup", ...result });
  return result;
}
