import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  activateMandate,
  connectDemoShop,
  createSellerLink,
  createSellerOffer,
  getOfferPerformance,
  getSellerMe,
  listSellerShops,
  listShopProducts,
  proposeMandate,
  simulateShopifyOauth,
  tryExceedOffer,
  type CatalogProduct,
  type Mandate,
  type Offer,
  type OfferPerformance,
  type SellerLink,
  type SellerMe,
  type SellerShop,
} from "@/lib/offerlayer";

export function SellerConsole() {
  const [shop, setShop] = useState("towels-dev.myshopify.com");
  const [productId, setProductId] = useState("gid://shopify/Product/9001001");
  const [checkoutTemplate, setCheckoutTemplate] = useState(
    "https://towels-dev.myshopify.com/cart/9002001:1?attributes[agent_ref]={token}",
  );
  const [link, setLink] = useState<SellerLink | null>(null);
  const [shops, setShops] = useState<SellerShop[]>([]);
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [mandate, setMandate] = useState<Mandate | null>(null);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [perf, setPerf] = useState<OfferPerformance | null>(null);
  const [me, setMe] = useState<SellerMe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [origin, setOrigin] = useState("https://offerlayer.vercel.app");

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    getSellerMe()
      .then(setMe)
      .catch(() => undefined);
  }, []);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  const connected = shops.find((s) => s.shop_domain === shop) ?? shops[0];

  return (
    <section className="mt-16 border-t border-border pt-10">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Playground</p>
      <h2 className="mt-3 font-display text-3xl tracking-tight">Set up a shop in the demo.</h2>
      <p className="mt-3 text-muted-foreground">
        Shopify install is not connected on this site. These buttons simulate it so you can see a discount
        get published.
      </p>

      <Card className="mt-8 space-y-4">
        <CardTitle>Partners URLs</CardTitle>
        <CardDescription>
          Shopify’s own install is not connected here. Use simulate to bind the demo shop.
        </CardDescription>
        <dl className="space-y-2 font-mono text-xs text-muted-foreground">
          <div>
            <dt className="text-[0.7rem] uppercase tracking-wide">App URL</dt>
            <dd className="break-all text-foreground">{me?.app_url ?? origin}</dd>
          </div>
          <div>
            <dt className="text-[0.7rem] uppercase tracking-wide">Redirect</dt>
            <dd className="break-all text-foreground">{me?.redirect_uri ?? `${origin}/auth/callback`}</dd>
          </div>
          <div>
            <dt className="text-[0.7rem] uppercase tracking-wide">Webhook</dt>
            <dd className="break-all text-foreground">
              {me?.webhook_uri ?? `${origin}/v1/webhooks/shopify`}
            </dd>
          </div>
          <div>
            <dt className="text-[0.7rem] uppercase tracking-wide">Partners app</dt>
            <dd>{me?.shopify_oauth ? "Will redirect to Shopify" : "Not connected"}</dd>
          </div>
        </dl>
      </Card>

      <Card className="mt-4 space-y-4">
        <div>
          <Label htmlFor="shop">Shop domain</Label>
          <Input id="shop" className="mt-2" value={shop} onChange={(e) => setShop(e.target.value)} />
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button
            disabled={busy !== null}
            onClick={() =>
              run("link", async () => {
                setLink(await createSellerLink(shop));
              })
            }
          >
            Create install link
          </Button>
          <Button
            variant="outline"
            disabled={busy !== null || !link?.install_url}
            onClick={() => {
              if (link?.install_url) window.open(link.install_url, "_blank", "noopener,noreferrer");
            }}
          >
            Open Shopify install
          </Button>
          <Button
            variant="outline"
            disabled={busy !== null}
            onClick={() =>
              run("oauth", async () => {
                const bound = await simulateShopifyOauth(shop);
                setLink(bound);
                setShops(await listSellerShops());
                if (bound.products?.[0]) {
                  setProducts(bound.products);
                  setProductId(bound.products[0].id);
                  setCheckoutTemplate(bound.products[0].checkout_template);
                }
              })
            }
          >
            Simulate install
          </Button>
          <Button
            variant="ghost"
            disabled={busy !== null}
            onClick={() =>
              run("connect", async () => {
                setLink(await connectDemoShop(shop));
                setShops(await listSellerShops());
              })
            }
          >
            Skip install
          </Button>
        </div>
        {link ? (
          <div className="rounded-md border border-border bg-background px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Install disclosure</p>
            <p className="mt-1 text-sm">{link.disclosure}</p>
            <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{link.install_url}</p>
          </div>
        ) : null}
        {shops.length > 0 ? (
          <p className="text-sm">
            Connected:{" "}
            {shops.map((s) => `${s.shop_domain}${s.oauth_bound ? " (OAuth)" : ""}`).join(", ")}
          </p>
        ) : null}
      </Card>

      <Card className="mt-4 space-y-4">
        <CardTitle>Catalog</CardTitle>
        <CardDescription>
          Publish a real product gid. Product/1001 is the Demo Towels seed — not your store.
        </CardDescription>
        <Button
          disabled={busy !== null || !connected}
          onClick={() =>
            run("products", async () => {
              if (!connected) return;
              const list = await listShopProducts(connected.merchant_id);
              setProducts(list);
              if (list[0]) {
                setProductId(list[0].id);
                setCheckoutTemplate(list[0].checkout_template);
              }
            })
          }
        >
          Load shop products
        </Button>
        {products.length > 0 ? (
          <ul className="space-y-2">
            {products.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="w-full rounded-md border border-border bg-background px-4 py-3 text-left"
                  onClick={() => {
                    setProductId(p.id);
                    setCheckoutTemplate(p.checkout_template);
                  }}
                >
                  <p className="text-sm">{p.title}</p>
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                    {p.id} · {p.variant_id}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div>
          <Label htmlFor="gid">Product gid</Label>
          <Input id="gid" className="mt-2 font-mono text-xs" value={productId} onChange={(e) => setProductId(e.target.value)} />
        </div>
      </Card>

      <Card className="mt-4 space-y-4">
        <CardTitle>Set a cap</CardTitle>
        <CardDescription>
          Confirm the text. Anything above the cap is refused.
        </CardDescription>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            disabled={busy !== null || shops.length === 0}
            onClick={() =>
              run("propose", async () => {
                setMandate(await proposeMandate(shop, productId));
              })
            }
          >
            Propose cap
          </Button>
          <Button
            variant="outline"
            disabled={busy !== null || mandate?.status !== "proposed"}
            onClick={() =>
              run("activate", async () => {
                if (!mandate) return;
                setMandate(await activateMandate(mandate.id));
              })
            }
          >
            Confirm card text
          </Button>
        </div>
        {mandate ? (
          <div className="rounded-md border border-border bg-background px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {mandate.status} · {mandate.id}
            </p>
            <p className="mt-2 text-sm leading-normal">{mandate.card_text}</p>
          </div>
        ) : null}
      </Card>

      <Card className="mt-4 space-y-4">
        <CardTitle>Publish the $4 discount</CardTitle>
        <CardDescription>
          The cart link carries the discount so the order can be matched. Until a real store is connected,
          payment stays simulated.
        </CardDescription>
        <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          disabled={busy !== null || mandate?.status !== "active"}
          onClick={() =>
            run("offer", async () => {
              const saved = await createSellerOffer({
                shop_domain: shop,
                title: "Organic Turkish Towel Set",
                list_price: "32.00",
                reward_amount: "4.00",
                finder_fee_amount: "",
                product_id: productId,
                variant_id: products.find((p) => p.id === productId)?.variant_id,
                checkout_template: checkoutTemplate,
              });
              setOffer(saved);
            })
          }
        >
          Publish the $4 discount
        </Button>
        <Button
          variant="outline"
          disabled={busy !== null || mandate?.status !== "active"}
          onClick={() =>
            run("exceed", async () => {
              await tryExceedOffer(shop, productId);
            })
          }
        >
          Try $8 — should be refused
        </Button>
        </div>
        {offer ? (
          <div className="rounded-md border border-border bg-background px-4 py-3">
            <p className="font-mono text-xs text-muted-foreground">{offer.id}</p>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {offer.selector.ids?.join(", ")}
            </p>
            <p className="mt-2 text-sm">{offer.disclosure}</p>
            <Button
              className="mt-3"
              variant="secondary"
              disabled={busy !== null}
              onClick={() =>
                run("perf", async () => {
                  setPerf(await getOfferPerformance(offer.id));
                })
              }
            >
              Load performance
            </Button>
          </div>
        ) : null}
        {perf ? (
          <p className="text-sm">
            {perf.attributed_orders} attributed · pending GMV ${perf.pending_hold.gmv} · cleared $
            {perf.cleared.gmv}
          </p>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </Card>
    </section>
  );
}
