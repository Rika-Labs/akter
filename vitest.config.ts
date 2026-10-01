import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: [
      "apps/*/src/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "tooling/*/src/**/*.test.ts",
      "infra/src/**/*.test.ts",
      ".github/src/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/templates/**"],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 15000,
  },
})
