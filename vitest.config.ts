import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: [
      "apps/*/test/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "examples/*/src/**/*.test.ts",
      "tooling/*/src/**/*.test.ts",
      "infra/test/**/*.test.ts",
      ".github/test/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/templates/**"],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 15000,
  },
})
