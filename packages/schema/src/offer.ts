import { z } from "zod";

const money2 = z.string().regex(/^[0-9]+\.[0-9]{2}$/);
const moneyLoose = z.string().regex(/^[0-9]+(\.[0-9]{1,2})?$/);
const iso2 = z.string().length(2);

export const offerSchema = z
  .object({
    id: z.string().regex(/^off_[a-zA-Z0-9_]+$/),
    protocol: z.literal("offerlayer/0.1"),
    merchant: z
      .object({
        shop_domain: z.string().min(1),
        name: z.string().min(1),
        website: z.string().url().optional(),
      })
      .strict(),
    status: z.enum(["draft", "live", "paused"]),
    selector: z
      .object({
        type: z.enum(["product", "collection", "shop"]),
        ids: z.array(z.string()).optional(),
        title: z.string().optional(),
        currency: z.string().length(3).optional(),
        list_price: money2.optional(),
      })
      .strict(),
    reward: z
      .object({
        type: z.enum(["flat", "percent"]),
        amount: moneyLoose,
        currency: z.string().length(3),
        recipient: z.literal("buyer"),
      })
      .strict(),
    finder_fee: z
      .object({
        type: z.enum(["flat", "percent"]),
        amount: moneyLoose,
        currency: z.string().length(3),
        recipient: z.literal("agent"),
      })
      .strict()
      .optional(),
    constraints: z
      .object({
        new_customer_only: z.boolean().optional(),
        ship_to: z.array(iso2).optional(),
        max_per_principal_per_day: z.number().int().min(1).optional(),
        max_units_per_order: z.number().int().min(1).optional(),
        clawback_days: z.number().int().min(0).max(90),
      })
      .strict(),
    checkout: z
      .object({
        ucp: z.boolean().optional(),
        tracked_url_template: z.string().min(1),
      })
      .strict(),
    disclosure: z.string().min(16),
  })
  .strict();

export type Offer = z.infer<typeof offerSchema>;

export const trackedCheckoutSchema = z
  .object({
    token: z.string().startsWith("olt_"),
    offer_id: z.string().regex(/^off_[a-zA-Z0-9_]+$/).optional(),
    expires_at: z.string(),
    checkout_url: z.string(),
    disclosure: z.string().min(16),
    reward: z.object({
      type: z.enum(["flat", "percent"]),
      amount: moneyLoose,
      currency: z.string(),
      recipient: z.literal("buyer"),
    }),
    finder_fee: z
      .object({
        type: z.enum(["flat", "percent"]),
        amount: moneyLoose,
        currency: z.string(),
        recipient: z.literal("agent"),
      })
      .optional(),
    checkout: z
      .object({
        permalink: z.string(),
        agentic: z.object({
          shop_domain: z.string(),
          currency: z.string(),
          line_items: z
            .array(
              z.object({
                quantity: z.number().int().min(1),
                item: z.object({ id: z.string() }),
              }),
            )
            .optional(),
          attributes: z.array(z.object({ key: z.string(), value: z.string() })),
          note: z.string(),
          utm: z.object({
            utm_source: z.string(),
            utm_medium: z.string(),
            utm_campaign: z.string(),
            utm_content: z.string(),
          }),
          warning: z.literal("NO_VARIANT_GID").optional(),
        }),
      })
      .optional(),
  })
  .strict();

export const conversionStatusSchema = z.enum([
  "issued",
  "pending_hold",
  "cleared",
  "clawed_back",
  "invalid",
  "expired",
]);

export type ConversionStatus = z.infer<typeof conversionStatusSchema>;

export const conversionSchema = z.object({
  token: z.string(),
  status: conversionStatusSchema,
  order_total: moneyLoose.optional(),
  currency: z.string().optional(),
  reward_amount: moneyLoose.optional(),
  finder_fee_amount: moneyLoose.optional(),
  hold_until: z.string().optional(),
  payouts: z
    .array(
      z.object({
        party: z.enum(["buyer", "agent"]),
        amount: moneyLoose,
        status: z.string(),
      }),
    )
    .optional(),
});

export type Conversion = z.infer<typeof conversionSchema>;

export const checkoutRequestSchema = z
  .object({
    offer_id: z.string().regex(/^off_[a-zA-Z0-9_]+$/),
    principal_ref: z.string().min(1).optional(),
    return_url: z.string().optional(),
  })
  .strict();

export const referRequestSchema = z
  .object({
    offer_id: z.string().regex(/^off_[a-zA-Z0-9_]+$/),
    to_agent_id: z.string().regex(/^agt_[a-zA-Z0-9_]+$/).optional(),
  })
  .strict();

export const simulatePurchaseSchema = z
  .object({
    token: z.string().startsWith("olt_"),
    order_total: moneyLoose,
    currency: z.string().length(3),
    email_hash: z.string().min(1).optional(),
  })
  .strict();

export const simulateClearSchema = z
  .object({
    token: z.string().startsWith("olt_"),
  })
  .strict();

export const upsertOfferSchema = z
  .object({
    id: z.string().regex(/^off_[a-zA-Z0-9_]+$/).optional(),
    shop_domain: z.string().min(1),
    merchant_name: z.string().min(1).optional(),
    website: z.string().url().optional(),
    status: z.enum(["draft", "live", "paused"]).default("live"),
    selector: z.object({
      type: z.enum(["product", "collection", "shop"]),
      ids: z.array(z.string()).optional(),
      title: z.string().optional(),
      currency: z.string().length(3).optional(),
      list_price: money2.optional(),
    }),
    reward: z.object({
      type: z.enum(["flat", "percent"]),
      amount: moneyLoose,
      currency: z.string().length(3),
      recipient: z.literal("buyer").optional(),
    }),
    finder_fee: z
      .object({
        type: z.enum(["flat", "percent"]),
        amount: moneyLoose,
        currency: z.string().length(3),
        recipient: z.literal("agent").optional(),
      })
      .optional(),
    constraints: z.object({
      new_customer_only: z.boolean().optional(),
      ship_to: z.array(iso2).optional(),
      max_per_principal_per_day: z.number().int().min(1).optional(),
      max_units_per_order: z.number().int().min(1).optional(),
      clawback_days: z.number().int().min(0).max(90),
    }),
    checkout: z.object({
      ucp: z.boolean().optional(),
      tracked_url_template: z.string().min(1),
    }),
    disclosure: z.string().min(16),
  })
  .strict();

export type UpsertOfferInput = z.infer<typeof upsertOfferSchema>;

export const sellerCreateOfferSchema = z
  .object({
    id: z.string().regex(/^off_[a-zA-Z0-9_]+$/).optional(),
    merchant_id: z.string().regex(/^mer_[a-zA-Z0-9_]+$/).optional(),
    shop_domain: z.string().min(1).optional(),
    merchant_name: z.string().min(1).optional(),
    website: z.string().url().optional(),
    status: z.enum(["draft", "live", "paused"]).default("draft"),
    selector: z.object({
      type: z.enum(["product", "collection", "shop"]),
      ids: z.array(z.string()).optional(),
      title: z.string().optional(),
      currency: z.string().length(3).optional(),
      list_price: money2.optional(),
    }),
    reward: z.object({
      type: z.enum(["flat", "percent"]),
      amount: moneyLoose,
      currency: z.string().length(3),
      recipient: z.literal("buyer").optional(),
    }),
    finder_fee: z
      .object({
        type: z.enum(["flat", "percent"]),
        amount: moneyLoose,
        currency: z.string().length(3),
        recipient: z.literal("agent").optional(),
      })
      .optional(),
    constraints: z
      .object({
        new_customer_only: z.boolean().optional(),
        ship_to: z.array(iso2).optional(),
        max_per_principal_per_day: z.number().int().min(1).optional(),
        max_units_per_order: z.number().int().min(1).optional(),
        clawback_days: z.number().int().min(0).max(90).default(14),
      })
      .default({ clawback_days: 14 }),
    checkout: z
      .object({
        ucp: z.boolean().optional(),
        tracked_url_template: z.string().min(1),
      })
      .optional(),
    disclosure: z.string().min(16).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.merchant_id || v.shop_domain), {
    message: "merchant_id or shop_domain is required",
  });

export type SellerCreateOfferInput = z.infer<typeof sellerCreateOfferSchema>;

export const sellerPatchOfferSchema = z
  .object({
    status: z.enum(["draft", "live", "paused"]).optional(),
    selector: z
      .object({
        type: z.enum(["product", "collection", "shop"]).optional(),
        ids: z.array(z.string()).optional(),
        title: z.string().optional(),
        currency: z.string().length(3).optional(),
        list_price: money2.optional(),
      })
      .optional(),
    reward: z
      .object({
        type: z.enum(["flat", "percent"]).optional(),
        amount: moneyLoose.optional(),
        currency: z.string().length(3).optional(),
      })
      .optional(),
    finder_fee: z
      .object({
        type: z.enum(["flat", "percent"]),
        amount: moneyLoose,
        currency: z.string().length(3),
        recipient: z.literal("agent").optional(),
      })
      .nullable()
      .optional(),
    constraints: z
      .object({
        new_customer_only: z.boolean().optional(),
        ship_to: z.array(iso2).optional(),
        max_per_principal_per_day: z.number().int().min(1).optional(),
        max_units_per_order: z.number().int().min(1).optional(),
        clawback_days: z.number().int().min(0).max(90).optional(),
      })
      .optional(),
    checkout: z
      .object({
        ucp: z.boolean().optional(),
        tracked_url_template: z.string().min(1).optional(),
      })
      .optional(),
    disclosure: z.string().min(16).optional(),
  })
  .strict();

export type SellerPatchOfferInput = z.infer<typeof sellerPatchOfferSchema>;

export const sellerLinkRequestSchema = z
  .object({
    shop_domain: z.string().min(1).optional(),
  })
  .strict();

export const sellerCompleteLinkSchema = z
  .object({
    shop_domain: z.string().min(1),
  })
  .strict();

export const simulateConnectShopSchema = z
  .object({
    shop_domain: z.string().min(1).default("demo-towels.myshopify.com"),
  })
  .strict();

export const catalogProductSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    variant_id: z.string().min(1),
    list_price: money2.optional(),
    currency: z.string().length(3).optional(),
  })
  .strict();

export const simulateShopifyOauthSchema = z
  .object({
    shop_domain: z.string().min(1),
    seller_link: z.string().optional(),
    shopify_shop_id: z.string().optional(),
    shop_name: z.string().optional(),
    products: z.array(catalogProductSchema).optional(),
  })
  .strict();

export const mandateCapsSchema = z
  .object({
    max_reward_flat: money2.default("5.00"),
    max_reward_percent: moneyLoose.default("15"),
    max_finder_fee_flat: money2.default("2.00"),
    max_finder_fee_percent: moneyLoose.default("3"),
    max_daily_liability: money2.default("200.00"),
    max_clawback_days: z.number().int().min(0).max(90).default(14),
  })
  .strict();

export const mandateSelectorSchema = z
  .object({
    type: z.enum(["product", "collection", "shop"]),
    ids: z.array(z.string()).optional(),
  })
  .strict();

export const mandateAllowSchema = z
  .object({
    publish: z.boolean().default(true),
    pause: z.boolean().default(true),
    resume: z.boolean().default(true),
    update_within_caps: z.boolean().default(true),
  })
  .strict();

export const proposeMandateSchema = z
  .object({
    shop_domain: z.string().min(1).optional(),
    merchant_id: z.string().regex(/^mer_[a-zA-Z0-9_]+$/).optional(),
    caps: mandateCapsSchema.default({
      max_reward_flat: "5.00",
      max_reward_percent: "15",
      max_finder_fee_flat: "2.00",
      max_finder_fee_percent: "3",
      max_daily_liability: "200.00",
      max_clawback_days: 14,
    }),
    selector: mandateSelectorSchema,
    allow: mandateAllowSchema.default({
      publish: true,
      pause: true,
      resume: true,
      update_within_caps: true,
    }),
    expires_at: z.string().optional(),
  })
  .strict()
  .refine((v) => Boolean(v.merchant_id || v.shop_domain), {
    message: "merchant_id or shop_domain is required",
  });

export type ProposeMandateInput = z.infer<typeof proposeMandateSchema>;
export type MandateCaps = z.infer<typeof mandateCapsSchema>;
export type MandateSelector = z.infer<typeof mandateSelectorSchema>;
export type MandateAllow = z.infer<typeof mandateAllowSchema>;
