import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { hashApiKey } from "./crypto.ts";
import { closeDatabase, openDatabase } from "./client.ts";
import { loadEnv } from "./env.ts";
import { agents, merchants, offers, shopGrants } from "./schema.ts";

export const SEED_OFFER_ID = "off_towel_organic_set";
export const SEED_MERCHANT_ID = "mer_demo_towels";
export const SEED_AGENT_DEMO = "agt_demo";
export const SEED_AGENT_MUSE = "agt_muse";
export const SEED_AGENT_SELLER = "agt_seller";

export const SEED_DISCLOSURE =
  "10% off this checkout of the Organic Turkish Towel Set. The code works once, on this cart only, and cannot be shared.";

export const SEED_OFFER = {
  id: SEED_OFFER_ID,
  protocol: "offerlayer/0.1" as const,
  merchant: {
    shop_domain: "demo-towels.myshopify.com",
    name: "Demo Towels",
    website: "https://demo-towels.myshopify.com",
  },
  status: "live" as const,
  selector: {
    type: "product" as const,
    ids: ["gid://shopify/Product/1001"],
    title: "Organic Turkish Towel Set",
    currency: "USD",
    list_price: "32.00",
  },
  reward: {
    type: "percent" as const,
    amount: "10",
    currency: "USD",
    recipient: "buyer" as const,
  },
  finder_fee: {
    type: "percent" as const,
    amount: "2",
    currency: "USD",
    recipient: "agent" as const,
  },
  constraints: {
    new_customer_only: false,
    ship_to: ["US"],
    max_per_principal_per_day: 1,
    max_units_per_order: 4,
    clawback_days: 14,
  },
  checkout: {
    ucp: false,
    tracked_url_template:
      "https://demo-towels.myshopify.com/cart/1001:1?attributes[agent_ref]={token}",
  },
  disclosure: SEED_DISCLOSURE,
};

export function seedDatabase(handle = openDatabase()): {
  demoAgentKey: string;
  museAgentKey: string;
  sellerAgentKey: string;
  demoKey: string;
} {
  const now = new Date().toISOString();
  const { db, env } = handle;

  db.insert(merchants)
    .values({
      id: SEED_MERCHANT_ID,
      shopDomain: SEED_OFFER.merchant.shop_domain,
      shopifyShopId: "gid://shopify/Shop/demo",
      accessTokenEnc: null,
      name: SEED_OFFER.merchant.name,
      website: SEED_OFFER.merchant.website,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: merchants.id,
      set: {
        shopDomain: SEED_OFFER.merchant.shop_domain,
        name: SEED_OFFER.merchant.name,
        website: SEED_OFFER.merchant.website,
      },
    })
    .run();

  db.insert(offers)
    .values({
      id: SEED_OFFER_ID,
      merchantId: SEED_MERCHANT_ID,
      status: "live",
      selectorType: SEED_OFFER.selector.type,
      selectorIdsJson: JSON.stringify(SEED_OFFER.selector.ids),
      selectorTitle: SEED_OFFER.selector.title,
      listPrice: SEED_OFFER.selector.list_price,
      selectorCurrency: SEED_OFFER.selector.currency,
      rewardType: SEED_OFFER.reward.type,
      rewardAmount: SEED_OFFER.reward.amount,
      rewardCurrency: SEED_OFFER.reward.currency,
      rewardRecipient: "buyer",
      finderFeeType: SEED_OFFER.finder_fee.type,
      finderFeeAmount: SEED_OFFER.finder_fee.amount,
      finderFeeCurrency: SEED_OFFER.finder_fee.currency,
      finderFeeRecipient: "agent",
      newCustomerOnly: 0,
      shipToJson: JSON.stringify(SEED_OFFER.constraints.ship_to),
      maxPerPrincipalPerDay: SEED_OFFER.constraints.max_per_principal_per_day,
      maxUnitsPerOrder: SEED_OFFER.constraints.max_units_per_order,
      clawbackDays: SEED_OFFER.constraints.clawback_days,
      disclosure: SEED_OFFER.disclosure,
      checkoutUrlTemplate: SEED_OFFER.checkout.tracked_url_template,
      ucp: 0,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: offers.id,
      set: {
        status: "live",
        selectorTitle: SEED_OFFER.selector.title,
        listPrice: SEED_OFFER.selector.list_price,
        disclosure: SEED_OFFER.disclosure,
        rewardType: SEED_OFFER.reward.type,
        rewardAmount: SEED_OFFER.reward.amount,
        finderFeeAmount: SEED_OFFER.finder_fee.amount,
        maxPerPrincipalPerDay: SEED_OFFER.constraints.max_per_principal_per_day,
        clawbackDays: SEED_OFFER.constraints.clawback_days,
        updatedAt: now,
      },
    })
    .run();

  for (const row of db.select().from(offers).all()) {
    if (!row.disclosure?.includes("finder fee")) continue;
    const disclosure =
      row.id === SEED_OFFER_ID
        ? SEED_DISCLOSURE
        : row.disclosure.replace(/ ?Optional agent finder fee: [^.]+\./, "").replace(
            / ?The presenting agent may earn a 2% finder fee on the paid total\./,
            "",
          );
    db.update(offers).set({ disclosure, updatedAt: now }).where(eq(offers.id, row.id)).run();
  }

  const upsertAgent = (id: string, name: string, apiKeyHash: string, role: "shopper" | "seller") => {
    const existing = db.select().from(agents).where(eq(agents.id, id)).get();
    if (existing) {
      db.update(agents)
        .set({ apiKeyHash, name, status: "active", role })
        .where(eq(agents.id, id))
        .run();
    } else {
      db.insert(agents)
        .values({
          id,
          name,
          publicKey: null,
          apiKeyHash,
          status: "active",
          role,
          createdAt: now,
        })
        .run();
    }
  };

  upsertAgent(SEED_AGENT_DEMO, "Demo Agent", hashApiKey(env.demoAgentKey), "shopper");
  upsertAgent(SEED_AGENT_MUSE, "Muse Demo", hashApiKey(env.museAgentKey), "shopper");
  upsertAgent(SEED_AGENT_SELLER, "Demo Seller", hashApiKey(env.sellerAgentKey), "seller");

  const grantExisting = db
    .select()
    .from(shopGrants)
    .where(eq(shopGrants.merchantId, SEED_MERCHANT_ID))
    .all()
    .find((g) => g.sellerAgentId === SEED_AGENT_SELLER);
  if (grantExisting) {
    db.update(shopGrants)
      .set({ status: "active" })
      .where(eq(shopGrants.id, grantExisting.id))
      .run();
  } else {
    db.insert(shopGrants)
      .values({
        id: "grn_demo_towels_seller",
        merchantId: SEED_MERCHANT_ID,
        sellerAgentId: SEED_AGENT_SELLER,
        status: "active",
        createdAt: now,
      })
      .run();
  }

  return {
    demoAgentKey: env.demoAgentKey,
    museAgentKey: env.museAgentKey,
    sellerAgentKey: env.sellerAgentKey,
    demoKey: env.demoKey,
  };
}

function main(): void {
  // `pnpm seed` is a demo affordance (public demo keys). Production deploys
  // seed through their own entrypoint with real secrets, never this CLI.
  process.env.OFFERLAYER_DEMO ??= "1";
  const env = loadEnv();
  const handle = openDatabase(env);
  const keys = seedDatabase(handle);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        database: handle.path,
        merchant: SEED_OFFER.merchant.shop_domain,
        offer: SEED_OFFER_ID,
        agents: {
          agt_demo: keys.demoAgentKey,
          agt_muse: keys.museAgentKey,
          agt_seller: keys.sellerAgentKey,
        },
        demo_key: keys.demoKey,
        note: "API keys are stored hashed. Plaintext is printed for local demo only.",
      },
      null,
      2,
    )}\n`,
  );
  closeDatabase(handle);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main();
}
