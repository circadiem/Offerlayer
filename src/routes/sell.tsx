import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/sell")({ component: Sell });

const AGENT_INSTRUCTIONS = `Set up Offerlayer on my Shopify store. It is a private discount that only applies when a customer buys through an AI agent. Do not make it a public coupon. Read the builder docs on this site and follow them.`;

function Sell() {
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
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-8 sm:py-12">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">For merchants</p>
      <h1 className="mt-3 font-display text-4xl tracking-tight">Publish a private discount.</h1>
      <p className="mt-3 text-muted-foreground">
        Shopify connect is not live on this site yet. Hand this to your agent. They publish the discount.
        It is not a public coupon.
      </p>
      <Card className="mt-8 space-y-4">
        <CardTitle>Instructions for your agent</CardTitle>
        <CardDescription>
          Copy this and paste it into the agent you already use. The setup steps are on the builder docs.
        </CardDescription>
        <Button onClick={() => void copyInstructions()}>
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? "Copied" : "Copy instructions for your agent"}
        </Button>
      </Card>
    </main>
  );
}
