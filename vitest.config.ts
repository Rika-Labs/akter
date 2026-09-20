import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: [
      "apps/*/test/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "tooling/*/test/**/*.test.ts",
      "infra/test/**/*.test.ts",
      ".github/test/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/templates/**"],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 15000,
  },
})
