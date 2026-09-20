import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "../.github/test/**/*.test.ts"],
  },
})
