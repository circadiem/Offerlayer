import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";
import { AuthProvider } from "@/lib/auth/provider";
import { PreviewHostBridge } from "@/components/preview-host-bridge";
import appCss from "../styles.css?url";

const APP_NAME = "Offerlayer";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: APP_NAME },
      {
        name: "description",
        content: "Merchants publish machine-readable purchase offers. Agents attach a signed token at checkout.",
      },
      { name: "theme-color", content: "#0a0a0b" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/__grok/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/__grok/icon-180.png" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=IBM+Plex+Mono:wght@400;500&family=Source+Sans+3:wght@400;500;600&display=swap",
      },
    ],
  }),
  component: Root,
});

function Root() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <PreviewHostBridge />
        <AuthProvider>
          <div className="flex min-h-dvh flex-col">
            <header className="border-b border-border px-4 py-4 sm:px-8">
              <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <Link to="/" className="font-display text-xl tracking-tight">
                  Offerlayer
                </Link>
                <nav className="flex flex-wrap items-center gap-1 text-sm">
                  <Link
                    to="/"
                    className="rounded-sm px-3 py-2 text-muted-foreground hover:text-foreground"
                    activeProps={{ className: "rounded-sm px-3 py-2 text-foreground" }}
                  >
                    Playground
                  </Link>
                  <Link
                    to="/sell"
                    className="rounded-sm px-3 py-2 text-muted-foreground hover:text-foreground"
                    activeProps={{ className: "rounded-sm px-3 py-2 text-foreground" }}
                  >
                    Sell
                  </Link>
                  <Link
                    to="/publish"
                    className="rounded-sm px-3 py-2 text-muted-foreground hover:text-foreground"
                    activeProps={{ className: "rounded-sm px-3 py-2 text-foreground" }}
                  >
                    Publish
                  </Link>
                  <Link
                    to="/connector"
                    className="rounded-sm px-3 py-2 text-muted-foreground hover:text-foreground"
                    activeProps={{ className: "rounded-sm px-3 py-2 text-foreground" }}
                  >
                    Connector
                  </Link>
                </nav>
              </div>
            </header>
            <Outlet />
          </div>
        </AuthProvider>
        <Scripts />
      </body>
    </html>
  );
}
