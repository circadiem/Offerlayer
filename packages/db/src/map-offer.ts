import type { Offer } from "@offerlayer/schema";
import { offerSchema } from "@offerlayer/schema";
import { offers, merchants } from "./schema.ts";

type OfferRow = typeof offers.$inferSelect;
type MerchantRow = typeof merchants.$inferSelect;

export function rowToOffer(offer: OfferRow, merchant: MerchantRow): Offer {
  const ids = JSON.parse(offer.selectorIdsJson) as string[];
  const shipTo = offer.shipToJson ? (JSON.parse(offer.shipToJson) as string[]) : undefined;
  const doc: Offer = {
    id: offer.id,
    protocol: "offerlayer/0.1",
    merchant: {
      shop_domain: merchant.shopDomain,
      name: merchant.name,
      ...(merchant.website ? { website: merchant.website } : {}),
    },
    status: offer.status as Offer["status"],
    selector: {
      type: offer.selectorType as Offer["selector"]["type"],
      ...(ids.length ? { ids } : {}),
      ...(offer.selectorTitle ? { title: offer.selectorTitle } : {}),
      ...(offer.selectorCurrency ? { currency: offer.selectorCurrency } : {}),
      ...(offer.listPrice ? { list_price: offer.listPrice } : {}),
    },
    reward: {
      type: offer.rewardType as Offer["reward"]["type"],
      amount: offer.rewardAmount,
      currency: offer.rewardCurrency,
      recipient: "buyer",
    },
    ...(offer.finderFeeType && offer.finderFeeAmount && offer.finderFeeCurrency
      ? {
          finder_fee: {
            type: offer.finderFeeType as "flat" | "percent",
            amount: offer.finderFeeAmount,
            currency: offer.finderFeeCurrency,
            recipient: "agent" as const,
          },
        }
      : {}),
    constraints: {
      clawback_days: offer.clawbackDays,
      ...(offer.newCustomerOnly ? { new_customer_only: true } : { new_customer_only: false }),
      ...(shipTo ? { ship_to: shipTo } : {}),
      ...(offer.maxPerPrincipalPerDay
        ? { max_per_principal_per_day: offer.maxPerPrincipalPerDay }
        : {}),
      ...(offer.maxUnitsPerOrder ? { max_units_per_order: offer.maxUnitsPerOrder } : {}),
    },
    checkout: {
      tracked_url_template: offer.checkoutUrlTemplate,
      ucp: Boolean(merchant.accessTokenEnc),
    },
    disclosure: offer.disclosure,
  };
  return offerSchema.parse(doc);
}
