import { serve } from "@hono/node-server";
import { loadEnv, openDatabase, seedDatabase } from "@offerlayer/db";
import { createApp } from "./app.ts";
import { logJson } from "./logger.ts";
import { VERSION } from "./version.ts";

const env = loadEnv();
const handle = openDatabase(env);
seedDatabase(handle);
const app = createApp(handle);

serve({ fetch: app.fetch, port: env.port, hostname: "0.0.0.0" }, (info) => {
  logJson({
    level: "info",
    msg: "offerlayer_api_listen",
    port: info.port,
    version: VERSION,
  });
});

export { app, handle };
