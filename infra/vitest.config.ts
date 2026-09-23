import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["infra/src/**/*.test.ts", ".github/src/**/*.test.ts"],
  },
})
