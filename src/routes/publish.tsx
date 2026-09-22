import { createFileRoute } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { publishOffer, type Offer } from "@/lib/offerlayer";

export const Route = createFileRoute("/publish")({ component: Publish });

function Publish() {
  const [saved, setSaved] = useState<Offer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const offer = await publishOffer({
        shop_domain: String(form.get("shop_domain") ?? ""),
        title: String(form.get("title") ?? ""),
        list_price: String(form.get("list_price") ?? ""),
        reward_type: String(form.get("reward_type") ?? "flat") as "flat" | "percent",
        reward_amount: String(form.get("reward_amount") ?? ""),
        finder_fee_amount: String(form.get("finder_fee_amount") ?? ""),
        clawback_days: Number(form.get("clawback_days") ?? 14),
        ship_to: String(form.get("ship_to") ?? "US"),
        new_customer_only: form.get("new_customer_only") === "on",
        max_per_principal_per_day: Number(form.get("max_per_principal_per_day") ?? 1),
        disclosure: String(form.get("disclosure") ?? ""),
      });
      setSaved(offer);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Publish failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-8 sm:py-12">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Merchant</p>
      <h1 className="mt-3 font-display text-4xl tracking-tight">Publish an offer</h1>
      <p className="mt-3 text-muted-foreground">
        Same document the Shopify app writes. Live offers appear on{" "}
        <span className="font-mono text-foreground">GET /v1/offers</span>.
      </p>

      <form onSubmit={onSubmit} className="mt-8 space-y-5">
        <Card className="space-y-4">
          <div>
            <Label htmlFor="shop_domain">Shop domain</Label>
            <Input id="shop_domain" name="shop_domain" className="mt-2" defaultValue="demo-towels.myshopify.com" required />
          </div>
          <div>
            <Label htmlFor="title">Product title</Label>
            <Input id="title" name="title" className="mt-2" defaultValue="Organic Turkish Towel Set" required />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="list_price">List price</Label>
              <Input id="list_price" name="list_price" className="mt-2" defaultValue="32.00" required />
            </div>
            <div>
              <Label htmlFor="ship_to">Ship to</Label>
              <Input id="ship_to" name="ship_to" className="mt-2" defaultValue="US" />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="reward_type">Reward type</Label>
              <select
                id="reward_type"
                name="reward_type"
                defaultValue="flat"
                className="mt-2 flex h-11 w-full rounded-sm border border-border bg-surface px-3 text-sm"
              >
                <option value="flat">Flat $</option>
                <option value="percent">Percent</option>
              </select>
            </div>
            <div>
              <Label htmlFor="reward_amount">Reward amount</Label>
              <Input id="reward_amount" name="reward_amount" className="mt-2" defaultValue="4.00" required />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="finder_fee_amount">Finder fee %</Label>
              <Input id="finder_fee_amount" name="finder_fee_amount" className="mt-2" defaultValue="2" />
            </div>
            <div>
              <Label htmlFor="clawback_days">Clawback days</Label>
              <Input id="clawback_days" name="clawback_days" className="mt-2" defaultValue="14" />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="max_per_principal_per_day">Max per principal / day</Label>
              <Input id="max_per_principal_per_day" name="max_per_principal_per_day" className="mt-2" defaultValue="1" />
            </div>
            <label className="flex items-end gap-2 pb-2 text-sm">
              <input type="checkbox" name="new_customer_only" className="size-4" />
              New customers only
            </label>
          </div>
          <div>
            <Label htmlFor="disclosure">Disclosure</Label>
            <textarea
              id="disclosure"
              name="disclosure"
              required
              minLength={16}
              className="mt-2 min-h-28 w-full rounded-sm border border-border bg-surface px-3 py-2 text-sm"
              defaultValue="If you buy this product through a tracked checkout, the merchant funds a disclosed buyer reward after the refund hold. Finder fees, if any, are also disclosed. Nothing is paid on click."
            />
          </div>
        </Card>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" disabled={busy}>
          {busy ? "Publishing…" : "Save live offer"}
        </Button>
      </form>

      {saved ? (
        <Card className="mt-8">
          <CardTitle>Published {saved.id}</CardTitle>
          <CardDescription className="mt-2">
            Status {saved.status}. Search will return this document, including disclosure.
          </CardDescription>
        </Card>
      ) : null}
    </main>
  );
}
