import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/connector")({ component: Connector });

const SELLER_KEY = "agt_sell_demo_v0_offerlayer_seed";
const AGENT_KEY = "agt_live_demo_v0_offerlayer_seed";

const snippet = `You are connecting to Offerlayer, a purchase-offer protocol.

Base URL: https://offerlayer.grok.me
Auth: Authorization: Bearer only. Do not HMAC-sign Offerlayer requests.

Two credentials — never mix them. Two Muse connectors or two vaults:

  OFFERLAYER_SELLER_KEY=agt_sell_demo_v0_offerlayer_seed
  OFFERLAYER_AGENT_KEY=agt_live_demo_v0_offerlayer_seed

Seller script (this thread, seller key only):
  1. POST /v1/seller/links {"shop_domain":"<shop>.myshopify.com"}
     Show install_url + disclosure. Human opens install_url and approves Shopify OAuth.
     When Partners is configured, that URL redirects to Shopify. GET /auth/callback
     writes the seller link through. There is no agent-only install.
     Demo without Partners: POST /v1/simulate/shopify_oauth (seller Bearer + x-demo-key).
  2. GET /v1/seller/shops — non-empty, oauth_bound true after a real/sim OAuth.
  3. GET /v1/seller/shops/{merchant_id}/products
     Use a real product gid, not gid://shopify/Product/1001 (demo seed).
  4. POST /v1/seller/mandates with that gid. Show card_text verbatim.
  5. After the human approves that exact text:
     POST /v1/seller/mandates/{id}/activate {"human_confirmed": true}
     Never set human_confirmed because you think they would agree.
  6. POST /v1/seller/offers status live using the product gid AND checkout_template
     (variant cart URL with attributes[agent_ref]={token}) → 201, mandate_id set.
  7. $8 reward → 409 MANDATE_EXCEEDED. Show error.card_text. Stop.

Shopper script (other thread, agent key only):
  Discover the product however Muse already does (Catalog / Shop Pay).
  GET  /v1/offers for that shop + product.
  Always show disclosure on the same Muse purchase card as the Shop Pay total.
  Purchase approval every time. Do not auto-buy.
  POST /v1/checkouts {"offer_id":"..."}
  Prefer checkout.agentic (attributes, note, utm) for native Muse / Shop Pay.
  If the tool only takes a URL, use checkout.permalink
    (cart URL with attributes[agent_ref], payment=shop_pay, utm).
  Do not open a second unpaid cart if Muse already started Shop Pay.
  Until orders/paid fires, conversion stays simulated:
    POST /v1/simulate/purchase {"token":"olt_...","order_total":"32.00","currency":"USD"}
  GET  /v1/conversions/{token} → pending_hold is not paid.

On MANDATE_REQUIRED or MANDATE_EXCEEDED, show card_text and propose a new mandate. Do not retry in a loop.
Always allow Offerlayer does not let you exceed caps.`;

type CopyTarget = "snippet" | "seller" | "shopper";

function Connector() {
  const [copied, setCopied] = useState<CopyTarget | null>(null);

  async function copy(text: string, which: CopyTarget) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      window.setTimeout(() => setCopied(null), 1800);
    } catch {
      setCopied(null);
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-8 sm:py-12">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Muse connector</p>
      <h1 className="mt-3 font-display text-3xl tracking-tight sm:text-4xl">
        Two vaults.
        <span className="mt-1 block">One protocol.</span>
      </h1>
      <p className="mt-3 text-muted-foreground">
        Two Muse connectors (or two vault entries). Bearer only — no request HMAC. Seller thread: connect,
        mandate, publish a real product gid. Shopper thread: disclose and wait for purchase approval every
        time. Mixing keys returns ROLE_MISMATCH.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <Card className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Seller thread</p>
          <CardTitle>OFFERLAYER_SELLER_KEY</CardTitle>
          <p className="break-all font-mono text-xs text-muted-foreground">{SELLER_KEY}</p>
          <Button variant="outline" onClick={() => copy(SELLER_KEY, "seller")}>
            {copied === "seller" ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied === "seller" ? "Copied" : "Copy seller key"}
          </Button>
        </Card>
        <Card className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Shopper thread</p>
          <CardTitle>OFFERLAYER_AGENT_KEY</CardTitle>
          <p className="break-all font-mono text-xs text-muted-foreground">{AGENT_KEY}</p>
          <Button variant="outline" onClick={() => copy(AGENT_KEY, "shopper")}>
            {copied === "shopper" ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied === "shopper" ? "Copied" : "Copy shopper key"}
          </Button>
        </Card>
      </div>

      <Card className="mt-4 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Paste into Muse</CardTitle>
            <CardDescription className="mt-1">
              Base URL is https://offerlayer.grok.me. Demo bind still needs a human yes, then complete
              with the seller Bearer.
            </CardDescription>
          </div>
          <Button onClick={() => copy(snippet, "snippet")}>
            {copied === "snippet" ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied === "snippet" ? "Copied" : "Copy brief"}
          </Button>
        </div>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background px-4 py-3 font-mono text-xs leading-relaxed text-muted-foreground">
          {snippet}
        </pre>
      </Card>
    </main>
  );
}
