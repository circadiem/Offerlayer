// Demo scripts always run in demo mode (public demo keys). Production entrypoints
// (apps/api, apps/mcp, apps/shopify) must NOT set this — they fail closed.
process.env.OFFERLAYER_DEMO ??= "1";
import { serve } from "@hono/node-server";
import { loadEnv, openDatabase, seedDatabase } from "@offerlayer/db";
import { createApp } from "../apps/api/src/app.ts";

const useExternal = Boolean(process.env.OFFERLAYER_URL);

async function main(): Promise<void> {
  let stop: (() => void) | undefined;
  if (!useExternal) {
    const env = loadEnv({ DATABASE_URL: "memory:" });
    const handle = await openDatabase(env);
    await seedDatabase(handle);
    const app = createApp(handle);
    const port = await new Promise<number>((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        resolve(info.port);
      });
      stop = () => {
        server.close();
        void handle.close();
      };
    });
    process.env.OFFERLAYER_URL = `http://127.0.0.1:${port}`;
    process.env.DEMO_AGENT_KEY = env.demoAgentKey;
    process.env.DEMO_KEY = env.demoKey;
  }

  const { runDemo } = await import("../apps/demo-agent/src/cli.ts");
  try {
    await runDemo();
  } finally {
    stop?.();
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : err}\n`);
  process.exit(1);
});
