import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowRight, Check, Layers, LoaderCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SellerConsole } from "@/components/seller-console";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createCheckout,
  getHealth,
  searchOffers,
  simulateClear,
  simulatePurchase,
  type Conversion,
  type Offer,
  type TrackedCheckout,
  SEED_OFFER,
} from "@/lib/offerlayer";

export const Route = createFileRoute("/demo")({ component: Home });

function Home() {
  const [query, setQuery] = useState("towel");
  const [shipTo, setShipTo] = useState("US");
  const [offers, setOffers] = useState<Offer[]>([SEED_OFFER]);
  const [selected, setSelected] = useState<Offer | null>(SEED_OFFER);
  const [checkout, setCheckout] = useState<TrackedCheckout | null>(null);
  const [conversion, setConversion] = useState<Conversion | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [apiOk, setApiOk] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    getHealth()
      .then((h) => {
        if (!cancelled) setApiOk(h.ok);
      })
      .catch(() => {
        if (!cancelled) setApiOk(false);
      });
    searchOffers("towel", "US")
      .then((list) => {
        if (cancelled) return;
        const next = list.length > 0 ? list : [SEED_OFFER];
        setOffers(next);
        setSelected(next[0] ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setOffers([SEED_OFFER]);
        setSelected(SEED_OFFER);
        setApiOk(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const step = useMemo(() => {
    if (conversion?.status === "cleared") return 4;
    if (conversion?.status === "pending_hold") return 3;
    if (checkout) return 2;
    if (selected) return 1;
    return 0;
  }, [selected, checkout, conversion]);

  async function onSearch(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy("search");
    try {
      const list = await searchOffers(query, shipTo);
      const next = list.length > 0 ? list : query.trim().toLowerCase() === "towel" ? [SEED_OFFER] : [];
      setOffers(next);
      setSelected(next[0] ?? null);
      setCheckout(null);
      setConversion(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setBusy(null);
    }
  }

  async function onCheckout() {
    if (!selected) return;
    setError(null);
    setBusy("checkout");
    try {
      const result = await createCheckout(selected.id, `preview-${Date.now()}`);
      setCheckout(result);
      setConversion(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Checkout failed");
    } finally {
      setBusy(null);
    }
  }

  async function onPurchase() {
    if (!checkout) return;
    setError(null);
    setBusy("purchase");
    try {
      const result = await simulatePurchase(checkout.token, `sha256:preview-${Date.now()}`);
      setConversion(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Purchase failed");
    } finally {
      setBusy(null);
    }
  }

  async function onClear() {
    if (!checkout) return;
    setError(null);
    setBusy("clear");
    try {
      const result = await simulateClear(checkout.token);
      setConversion(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Clear failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-8 sm:py-12">
      <section className="max-w-3xl">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Playground
        </p>
        <h1 className="mt-3 font-display text-4xl leading-tight tracking-tight sm:text-5xl">
          Watch a private discount get attached.
        </h1>
        <p className="mt-5 max-w-2xl text-base text-muted-foreground sm:text-lg">
          This is the working demo, not the pitch. Search, attach, and simulate a purchase. The public
          page is the one a store owner skims.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Badge>{apiOk === false ? "API offline" : apiOk ? "API live" : "Checking API"}</Badge>
          <Badge>HMAC tokens</Badge>
          <Badge>Disclosure required</Badge>
        </div>
      </section>

      <ol className="mt-10 grid grid-cols-2 gap-2 text-xs uppercase tracking-wide text-muted-foreground sm:grid-cols-4">
        {["Search", "Disclose + claim", "Simulate pay", "Clear hold"].map((label, i) => (
          <li
            key={label}
            className={`rounded-md border px-3 py-2 ${i <= step ? "border-primary text-foreground" : "border-border"}`}
          >
            0{i + 1} {label}
          </li>
        ))}
      </ol>

      <div className="mt-8 grid gap-6 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          <Card>
            <form onSubmit={onSearch} className="grid gap-4 sm:grid-cols-[1fr_88px_auto]">
              <div>
                <Label htmlFor="q">Query</Label>
                <Input id="q" className="mt-2" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="ship">Ship to</Label>
                <Input
                  id="ship"
                  className="mt-2"
                  maxLength={2}
                  value={shipTo}
                  onChange={(e) => setShipTo(e.target.value.toUpperCase())}
                />
              </div>
              <div className="flex items-end">
                <Button type="submit" disabled={busy === "search"}>
                  {busy === "search" ? <LoaderCircle className="size-4 animate-spin" /> : "Search"}
                </Button>
              </div>
            </form>
          </Card>

          {offers.length === 0 ? (
            <Card>
              <CardTitle>No live offers</CardTitle>
              <CardDescription className="mt-2">
                Try <span className="font-mono text-foreground">towel</span> and US, or publish a new
                offer.
              </CardDescription>
            </Card>
          ) : (
            offers.map((offer) => (
              <button
                key={offer.id}
                type="button"
                onClick={() => {
                  setSelected(offer);
                  setCheckout(null);
                  setConversion(null);
                }}
                className={`w-full text-left ${selected?.id === offer.id ? "ring-1 ring-primary" : ""} rounded-xl`}
              >
                <Card className="transition-colors duration-[var(--motion-quick)] hover:bg-surface-2">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-mono text-xs text-muted-foreground">{offer.id}</p>
                      <CardTitle className="mt-1">{offer.selector.title ?? offer.id}</CardTitle>
                      <CardDescription className="mt-1">
                        {offer.merchant.name} · {offer.selector.list_price} {offer.selector.currency}
                      </CardDescription>
                    </div>
                    <div className="text-right">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Discount</p>
                      <p className="tabular font-display text-2xl">
                        {offer.reward.type === "flat" ? `$${offer.reward.amount}` : `${offer.reward.amount}%`}
                      </p>
                    </div>
                  </div>
                  <div className="mt-4 rounded-md border border-border bg-background px-4 py-3">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Disclosure</p>
                    <p className="mt-1 text-sm leading-normal">{offer.disclosure}</p>
                  </div>
                </Card>
              </button>
            ))
          )}
        </div>

        <aside className="space-y-4 lg:col-span-2">
          <Card>
            <div className="flex items-center gap-2 text-muted-foreground">
              <Layers className="size-4" />
              <span className="text-xs uppercase tracking-wide">Agent actions</span>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              The customer is the principal. The agent is a keyed channel. Rewards pay only on
              qualified, paid, non-clawed-back orders.
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <Button onClick={onCheckout} disabled={!selected || busy !== null}>
                Claim tracked checkout
                <ArrowRight className="size-4" />
              </Button>
              <Button variant="outline" onClick={onPurchase} disabled={!checkout || busy !== null}>
                Simulate $32 purchase
              </Button>
              <Button variant="secondary" onClick={onClear} disabled={conversion?.status !== "pending_hold" || busy !== null}>
                Fast-forward hold
              </Button>
            </div>
            {error ? <p className="mt-4 text-sm text-destructive">{error}</p> : null}
          </Card>

          {checkout ? (
            <Card>
              <CardTitle>Tracked checkout</CardTitle>
              <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{checkout.token}</p>
              <p className="mt-3 text-sm">
                Permalink contains token:{" "}
                {(checkout.checkout?.permalink ?? checkout.checkout_url).includes(checkout.token)
                  ? "yes"
                  : "no"}
              </p>
              {checkout.checkout?.permalink?.includes("payment=shop_pay") ? (
                <p className="mt-1 text-sm text-muted-foreground">Shop Pay attach on permalink</p>
              ) : null}
              {checkout.checkout?.agentic.warning === "NO_VARIANT_GID" ? (
                <p className="mt-1 text-sm text-muted-foreground">
                  Seed product — agentic line items omitted (NO_VARIANT_GID)
                </p>
              ) : null}
              <div className="mt-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Permalink</p>
                <p className="mt-1 break-all font-mono text-xs">
                  {checkout.checkout?.permalink ?? checkout.checkout_url}
                </p>
              </div>
              {checkout.checkout?.agentic ? (
                <div className="mt-4">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Agentic handoff</p>
                  <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-muted-foreground">
                    {JSON.stringify(checkout.checkout.agentic, null, 2)}
                  </pre>
                </div>
              ) : null}
            </Card>
          ) : null}

          {conversion ? (
            <Card>
              <div className="flex items-center justify-between">
                <CardTitle>Conversion</CardTitle>
                <Badge className="text-foreground">{conversion.status.replaceAll("_", " ")}</Badge>
              </div>
              {conversion.hold_until ? (
                <p className="mt-2 text-sm text-muted-foreground">Hold until {conversion.hold_until}</p>
              ) : null}
              <div className="mt-4 space-y-2">
                {(conversion.payouts ?? [])
                  .filter((p) => p.party === "buyer")
                  .map((p) => (
                  <div key={p.party} className="flex items-center justify-between rounded-sm bg-background px-3 py-2">
                    <span className="text-sm">Discount</span>
                    <span className="tabular font-mono text-sm">
                      ${p.amount} · {p.status}
                    </span>
                  </div>
                ))}
                {conversion.status === "cleared" ? (
                  <p className="flex items-center gap-2 text-sm text-ok">
                    <Check className="size-4" /> The 10% is on this checkout.
                  </p>
                ) : null}
              </div>
            </Card>
          ) : null}
        </aside>
      </div>
      <SellerConsole />
    </main>
  );
}
