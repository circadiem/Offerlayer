import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
