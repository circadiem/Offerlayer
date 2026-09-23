import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowRight, Check, Copy } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/")({ component: Landing });

const AGENT_INSTRUCTIONS = `Set up Offerlayer on my Shopify store. It is a private discount that only applies when a customer buys through an AI agent. Do not make it a public coupon. Read the builder docs on this site and follow them.`;

const steps = [
  {
    title: "You publish it",
    body: "Set the amount. It never becomes a public coupon.",
  },
  {
    title: "The agent attaches it",
    body: "When someone shops with an AI agent, that agent applies your discount.",
  },
  {
    title: "The shopper sees it first",
    body: "The amount is on the card before they pay. No surprise at the register.",
  },
];

function Landing() {
  const [copied, setCopied] = useState(false);

  async function copyInstructions() {
    try {
      await navigator.clipboard.writeText(AGENT_INSTRUCTIONS);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 sm:px-8">
      <section className="max-w-3xl pt-10 sm:pt-16">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          For Shopify stores
        </p>
        <h1 className="mt-4 font-display text-4xl leading-tight tracking-tight sm:text-6xl">
          A private discount for shoppers who buy through an AI agent.
        </h1>
        <p className="mt-6 max-w-2xl text-base text-muted-foreground sm:text-lg">
          Not a public coupon. You set the amount. Your agent publishes it. The shopper sees it before
          they pay.
        </p>
        <div className="mt-8">
          <button type="button" className={buttonVariants({ size: "lg" })} onClick={() => void copyInstructions()}>
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied ? "Copied" : "Copy instructions for your agent"}
          </button>
        </div>
      </section>

      <section id="how" className="mt-20 scroll-mt-24 sm:mt-28">
        <h2 className="font-display text-3xl tracking-tight sm:text-4xl">How it works</h2>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {steps.map((s, i) => (
            <Card key={s.title} className="space-y-3">
              <span className="font-mono text-xs text-muted-foreground">0{i + 1}</span>
              <CardTitle>{s.title}</CardTitle>
              <CardDescription className="leading-relaxed">{s.body}</CardDescription>
            </Card>
          ))}
        </div>
      </section>

      <section className="mt-16 grid gap-4 md:grid-cols-2 sm:mt-20">
        <Card id="merchants" className="scroll-mt-24 space-y-4 p-6 sm:p-8">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            For merchants
          </p>
          <CardTitle className="font-display text-2xl sm:text-3xl">Your discount. Nobody else's coupon.</CardTitle>
          <p className="text-sm leading-relaxed text-muted-foreground">
            It only shows up when a customer buys through an AI agent. You choose the amount. It does not
            leak into a code people can pass around.
          </p>
          <Link to="/sell" className={buttonVariants({ variant: "outline" })}>
            Publish a discount
            <ArrowRight className="size-4" />
          </Link>
        </Card>
        <Card id="builders" className="scroll-mt-24 space-y-4 p-6 sm:p-8">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            For agents
          </p>
          <CardTitle className="font-display text-2xl sm:text-3xl">The instructions live here.</CardTitle>
          <p className="text-sm leading-relaxed text-muted-foreground">
            If a store owner handed you this site, follow the builder docs. Do not invent a public coupon.
          </p>
          <Link to="/connector" className={buttonVariants({ variant: "outline" })}>
            Read the builder docs
            <ArrowRight className="size-4" />
          </Link>
        </Card>
      </section>

      <footer className="mt-20 border-t border-border pt-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            <span className="font-display text-foreground">Offerlayer</span> — a private discount for AI
            shopping.
          </p>
          <nav className="flex flex-wrap gap-1 text-sm">
            <Link to="/demo" className="rounded-sm px-3 py-2 text-muted-foreground hover:text-foreground">
              Playground
            </Link>
            <Link to="/sell" className="rounded-sm px-3 py-2 text-muted-foreground hover:text-foreground">
              Merchants
            </Link>
            <Link to="/connector" className="rounded-sm px-3 py-2 text-muted-foreground hover:text-foreground">
              Builder docs
            </Link>
          </nav>
        </div>
      </footer>
    </main>
  );
}
