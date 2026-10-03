import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      // Tests exercise the public demo keys; they must never run against
      // production-mode env validation.
      OFFERLAYER_DEMO: "1",
      // Embedded in-memory Postgres; tests share one instance per file.
      DATABASE_URL: "memory:",
    },
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "src/**", "scripts/**"],
    testTimeout: 15000,
    hookTimeout: 15000,
    fileParallelism: false,
  },
});
