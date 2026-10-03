import { defineConfig } from "drizzle-kit";

// `pnpm db:generate` writes SQL migrations from src/schema.ts into ./migrations.
// Review every generated file before committing it.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
});
