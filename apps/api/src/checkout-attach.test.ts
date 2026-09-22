import { describe, expect, it } from "vitest";
import { SEED_OFFER } from "@offerlayer/db";
import type { Offer } from "@offerlayer/schema";
import {
  buildCheckoutHandoff,
  buildPermalink,
  resolveVariantGid,
  shopSupportsShopPay,
} from "./checkout-attach.ts";
import { extractOrderToken } from "./webhooks.ts";

const seed = SEED_OFFER as Offer;
const TOKEN = "olt_testtokenvalue";

describe("checkout attach v0.3", () => {
  it("seed Product/1001 has no variant gid", () => {
    expect(resolveVariantGid(seed)).toBeNull();
  });

  it("distinct cart numeric id becomes a ProductVariant gid", () => {
    const offer: Offer = {
      ...seed,
      selector: { ...seed.selector, ids: ["gid://shopify/Product/9001001"] },
      checkout: {
        ucp: true,
        tracked_url_template:
          "https://towels-dev.myshopify.com/cart/9002001:1?attributes[agent_ref]={token}",
      },
    };
    expect(resolveVariantGid(offer)).toBe("gid://shopify/ProductVariant/9002001");
  });

  it("explicit ProductVariant gid wins", () => {
    const offer: Offer = {
      ...seed,
      selector: {
        ...seed.selector,
        ids: ["gid://shopify/Product/9001001", "gid://shopify/ProductVariant/9002001"],
      },
    };
    expect(resolveVariantGid(offer)).toBe("gid://shopify/ProductVariant/9002001");
  });

  it("myshopify.com shops get payment=shop_pay", () => {
    expect(shopSupportsShopPay("demo-towels.myshopify.com")).toBe(true);
    expect(shopSupportsShopPay("https://demo-towels.myshopify.com/cart")).toBe(true);
    expect(shopSupportsShopPay("merchant.example.com")).toBe(false);
  });

  it("permalink stamps agent_ref, utm, and shop_pay", () => {
    const url = buildPermalink({
      template: seed.checkout.tracked_url_template,
      token: TOKEN,
      offerId: seed.id,
      shopDomain: seed.merchant.shop_domain,
    });
    expect(url).toContain(`attributes[agent_ref]=${TOKEN}`);
    expect(url).toContain("utm_source=offerlayer");
    expect(url).toContain("utm_medium=agentic_commerce");
    expect(url).toContain(`utm_campaign=${seed.id}`);
    expect(url).toContain(`utm_content=${TOKEN}`);
    expect(url).toContain("payment=shop_pay");
  });

  it("seed handoff omits line_items and warns", () => {
    const handoff = buildCheckoutHandoff({ offer: seed, token: TOKEN });
    expect(handoff.agentic.line_items).toBeUndefined();
    expect(handoff.agentic.warning).toBe("NO_VARIANT_GID");
    expect(handoff.agentic.attributes).toEqual([
      { key: "agent_ref", value: TOKEN },
      { key: "offerlayer_offer", value: seed.id },
    ]);
    expect(handoff.agentic.note).toContain(TOKEN);
    expect(handoff.permalink).toBe(buildPermalink({
      template: seed.checkout.tracked_url_template,
      token: TOKEN,
      offerId: seed.id,
      shopDomain: seed.merchant.shop_domain,
    }));
  });

  it("real variant produces agentic line_items", () => {
    const offer: Offer = {
      ...seed,
      merchant: { ...seed.merchant, shop_domain: "towels-dev.myshopify.com" },
      selector: {
        ...seed.selector,
        ids: ["gid://shopify/Product/9001001", "gid://shopify/ProductVariant/9002001"],
      },
      checkout: {
        ucp: true,
        tracked_url_template:
          "https://towels-dev.myshopify.com/cart/9002001:1?attributes[agent_ref]={token}",
      },
    };
    const handoff = buildCheckoutHandoff({ offer, token: TOKEN });
    expect(handoff.agentic.line_items?.[0].item.id).toBe("gid://shopify/ProductVariant/9002001");
    expect(handoff.agentic.warning).toBeUndefined();
    expect(handoff.permalink).toContain("9002001:1");
  });
});

describe("webhook token extract v0.3", () => {
  const token = "olt_abc.def-ghi";

  it("prefers note_attributes agent_ref", () => {
    expect(
      extractOrderToken({
        note_attributes: [{ name: "agent_ref", value: token }],
        note: "offerlayer olt_other",
        landing_site: "/?utm_content=olt_land",
      }),
    ).toBe(token);
  });

  it("reads order note when attributes missing", () => {
    expect(extractOrderToken({ note: `please use offerlayer ${token} thanks` })).toBe(token);
  });

  it("reads landing_site utm_content", () => {
    expect(extractOrderToken({ landing_site: `/?utm_content=${token}` })).toBe(token);
  });

  it("reads referring_site agent_ref", () => {
    expect(
      extractOrderToken({ referring_site: `https://demo-towels.myshopify.com/?agent_ref=${token}` }),
    ).toBe(token);
  });

  it("reads line item property agent_ref", () => {
    expect(
      extractOrderToken({
        line_items: [{ properties: [{ name: "agent_ref", value: token }] }],
      }),
    ).toBe(token);
  });

  it("does not attribute offerlayer_offer without a token", () => {
    expect(
      extractOrderToken({
        note_attributes: [{ name: "offerlayer_offer", value: "off_towel_organic_set" }],
      }),
    ).toBeNull();
  });
});
