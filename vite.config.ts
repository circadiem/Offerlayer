import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";

// Dev: the site runs on :8080 and proxies API paths to the API server on
// :8787 (`pnpm api`). Build: Nitro emits a Vercel function that serves both,
// with server/middleware/offerlayer-api.ts mounting the API.
const API_PATHS = ["/v1", "/health", "/auth", "/.well-known", "/mcp", "/openapi.yaml"];

export default defineConfig(({ command, isPreview }) => ({
  server: {
    host: "0.0.0.0",
    port: 8080,
    strictPort: true,
    proxy: Object.fromEntries(
      API_PATHS.map((path) => [path, { target: "http://127.0.0.1:8787", changeOrigin: true }]),
    ),
  },
  preview: {
    host: "127.0.0.1",
    port: 8081,
    strictPort: true,
  },
  optimizeDeps: {
    exclude: ["@electric-sql/pglite"],
  },
  ssr: {
    // Loaded at runtime from node_modules: pg (production Postgres) and
    // PGlite (local demo), both imported dynamically by @offerlayer/db.
    external: ["pg", "@electric-sql/pglite"],
  },
  resolve: { tsconfigPaths: true },
  plugins: [
    tailwindcss(),
    tanstackStart(),
    ...(command === "build" || isPreview
      ? [
          nitro({
            preset: "vercel",
            // Registers server/middleware/*, which mounts the API.
            serverDir: "./server",
          }),
        ]
      : []),
    viteReact(),
  ],
}));
