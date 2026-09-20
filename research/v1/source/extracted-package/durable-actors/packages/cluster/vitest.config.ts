import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["**/*.bun.test.ts", "**/node_modules/**", "**/dist/**"],
    environment: "node",
    passWithNoTests: false,
  },
})
