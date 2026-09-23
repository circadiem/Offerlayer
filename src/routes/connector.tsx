import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/connector")({ component: Connector });

const FALLBACK_ORIGIN = "https://offerlayer.vercel.app";

function brief(origin: string): string {
  return `You are connecting to Offerlayer. The store owner wants a private discount that only applies when a customer buys through an AI agent. Do not make it a public coupon.

Base URL: ${origin}
Auth: Authorization: Bearer only. Do not HMAC-sign Offerlayer requests.

Two credentials — never mix them. Two Muse connectors or two vaults:

  OFFERLAYER_SELLER_KEY=agt_sell_…   (operator vault only — not printed on the site)
  OFFERLAYER_AGENT_KEY=agt_live_…    (operator vault only — not printed on the site)

This page does not contain API keys. Do not use any key you previously saw here.
The old public seed keys are dead on this host.

Seller script (this thread, seller key only):
  1. POST /v1/seller/links {"shop_domain":"<shop>.myshopify.com"}
     Show install_url + disclosure. Human opens install_url and approves Shopify OAuth.
     When a Partners app is configured, that URL redirects to Shopify. GET /auth/callback
     writes the seller link through. There is no agent-only install.
     This host does not have a Partners app yet. Demo path: POST /v1/simulate/shopify_oauth
     (seller Bearer + x-demo-key) after the human says yes.
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
"Always allow Offerlayer" does not let you exceed mandate caps.`;
}

function Connector() {
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState(FALLBACK_ORIGIN);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const snippet = brief(origin);

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-8 sm:py-12">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Builder docs</p>
      <h1 className="mt-3 font-display text-3xl tracking-tight sm:text-4xl">
        For the agent.
        <span className="mt-1 block">Not the store owner.</span>
      </h1>
      <p className="mt-3 text-muted-foreground">
        A store owner was told this is a private discount that only applies when a customer buys through an
        AI agent. Follow the brief below. Do not create a public coupon. Do not look for API keys on this
        page.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <Card className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Seller thread</p>
          <CardTitle>OFFERLAYER_SELLER_KEY</CardTitle>
          <p className="text-sm text-muted-foreground">
            Starts with <span className="font-mono">agt_sell_</span>. The operator keeps it in a password
            manager and pastes it into the seller vault. It is not on this page.
          </p>
        </Card>
        <Card className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Shopper thread</p>
          <CardTitle>OFFERLAYER_AGENT_KEY</CardTitle>
          <p className="text-sm text-muted-foreground">
            Starts with <span className="font-mono">agt_live_</span>. Same rule: vault only. Keys that used
            to be printed here no longer work.
          </p>
        </Card>
      </div>

      <Card className="mt-4 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Paste into Muse</CardTitle>
            <CardDescription className="mt-1">
              Base URL is {origin}. Shopify install redirects stay off until a Partners app is connected.
              Until then, simulate OAuth after the human says yes.
            </CardDescription>
          </div>
          <Button onClick={() => void copy()}>
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied ? "Copied" : "Copy brief"}
          </Button>
        </div>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background px-4 py-3 font-mono text-xs leading-relaxed text-muted-foreground">
          {snippet}
        </pre>
      </Card>
    </main>
  );
}
