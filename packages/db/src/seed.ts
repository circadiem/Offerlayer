import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { hashApiKey } from "./crypto.ts";
import { closeDatabase, openDatabase, type DbHandle } from "./client.ts";
import { loadEnv } from "./env.ts";
import { agents, merchants, offers, shopGrants } from "./schema.ts";

export const SEED_OFFER_ID = "off_towel_organic_set";
export const SEED_MERCHANT_ID = "mer_demo_towels";
export const SEED_AGENT_DEMO = "agt_demo";
export const SEED_AGENT_MUSE = "agt_muse";
export const SEED_AGENT_SELLER = "agt_seller";
export const SEED_AGENT_SHOPPER = "agt_shopper";

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

export type SeedKeys = {
  shopperAgentKey: string;
  sellerAgentKey: string;
  /** Demo mode only (empty in production). */
  demoAgentKey: string;
  museAgentKey: string;
  demoKey: string;
};

async function upsertAgent(
  handle: DbHandle,
  id: string,
  name: string,
  apiKey: string,
  role: "shopper" | "seller",
): Promise<void> {
  if (!apiKey) throw new Error(`[offerlayer] no API key configured for seeded agent ${id}`);
  const now = new Date().toISOString();
  const apiKeyHash = hashApiKey(apiKey);
  await handle.db
    .insert(agents)
    .values({ id, name, publicKey: null, apiKeyHash, status: "active", role, createdAt: now })
    .onConflictDoUpdate({ target: agents.id, set: { apiKeyHash, name, status: "active", role } });
}

/**
 * Bootstrap agents for this deploy: one shopper key and one seller key, from
 * SHOPPER_AGENT_KEY / SELLER_AGENT_KEY. In demo mode, also the demo catalog
 * (seedDemoData). Idempotent; runs on every boot.
 */
export async function seedDatabase(handle: DbHandle): Promise<SeedKeys> {
  const { env } = handle;
  await upsertAgent(
    handle,
    SEED_AGENT_SHOPPER,
    "Default shopper agent",
    env.shopperAgentKey,
    "shopper",
  );
  await upsertAgent(
    handle,
    SEED_AGENT_SELLER,
    "Default seller agent",
    env.sellerAgentKey,
    "seller",
  );
  if (env.demoMode) await seedDemoData(handle);
  return {
    shopperAgentKey: env.shopperAgentKey,
    sellerAgentKey: env.sellerAgentKey,
    demoAgentKey: env.demoAgentKey,
    museAgentKey: env.museAgentKey,
    demoKey: env.demoKey,
  };
}

/**
 * Demo-only data: the Demo Towels shop and offer, the default seller's grant
 * on it, and two demo shopper agents (the playground's, and a stand-in for one
 * named agent). Never runs in production; tests may call it directly.
 */
export async function seedDemoData(handle: DbHandle): Promise<void> {
  const now = new Date().toISOString();
  const { db, env } = handle;
  if (env.demoAgentKey)
    await upsertAgent(handle, SEED_AGENT_DEMO, "Demo agent", env.demoAgentKey, "shopper");
  if (env.museAgentKey)
    await upsertAgent(handle, SEED_AGENT_MUSE, "Muse (demo)", env.museAgentKey, "shopper");

  await db
    .insert(merchants)
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
    });

  await db
    .insert(offers)
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
    });

  const grantExisting = (
    await db.select().from(shopGrants).where(eq(shopGrants.merchantId, SEED_MERCHANT_ID))
  ).find((g) => g.sellerAgentId === SEED_AGENT_SELLER);
  if (grantExisting) {
    await db
      .update(shopGrants)
      .set({ status: "active" })
      .where(eq(shopGrants.id, grantExisting.id));
  } else {
    await db.insert(shopGrants).values({
      id: "grn_demo_towels_seller",
      merchantId: SEED_MERCHANT_ID,
      sellerAgentId: SEED_AGENT_SELLER,
      status: "active",
      createdAt: now,
    });
  }
}

async function main(): Promise<void> {
  // `pnpm seed` is a demo affordance (public demo keys). Production deploys
  // seed through their own entrypoint with real secrets, never this CLI.
  process.env.OFFERLAYER_DEMO ??= "1";
  const env = loadEnv();
  const handle = await openDatabase(env);
  const keys = await seedDatabase(handle);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        database: handle.kind,
        merchant: SEED_OFFER.merchant.shop_domain,
        offer: SEED_OFFER_ID,
        agents: {
          agt_shopper: keys.shopperAgentKey,
          agt_seller: keys.sellerAgentKey,
          agt_demo: keys.demoAgentKey,
          agt_muse: keys.museAgentKey,
        },
        demo_key: keys.demoKey,
        note: "API keys are stored hashed. Plaintext is printed for local demo only.",
      },
      null,
      2,
    )}\n`,
  );
  await closeDatabase(handle);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  void main();
}
