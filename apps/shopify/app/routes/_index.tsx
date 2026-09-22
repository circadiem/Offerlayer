/**
 * Remix-shaped route map for the Shopify publisher.
 * Runtime is Hono in ../server.ts because this sandbox already hosts
 * TanStack Start at the workspace root. Routes:
 *   /auth/login        OAuth install
 *   /auth/callback     OAuth callback
 *   /app               live offers
 *   /app/offers/new    offer form (ResourcePicker → product title in v0)
 *   /app/settings      clawback + disclosure defaults
 */
export default function Index() {
  return null;
}
