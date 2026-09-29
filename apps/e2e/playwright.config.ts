import { defineConfig, devices } from "@playwright/test"

const inCI = process.env.CI === "true"

/**
 * Browser test configuration. It starts the chat example on in-memory PGlite
 * and serves it to the tests in `chat.e2e.ts` and `react.e2e.ts`.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  forbidOnly: inCI,
  retries: inCI ? 2 : 0,
  reporter: inCI ? "github" : "list",
  use: {
    baseURL: "http://localhost:3002",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command:
        "bun run --cwd packages/ui build && bun run --cwd apps/console build && APP_ORIGIN=http://localhost:3002 bun apps/console/src/preview.ts",
      cwd: "../..",
      url: "http://127.0.0.1:3002/health",
      reuseExistingServer: !inCI,
      timeout: 120_000,
    },
    {
      command: "PORT=3003 bun examples/chat/src/web/serve.ts",
      cwd: "../..",
      url: "http://127.0.0.1:3003/health",
      reuseExistingServer: !inCI,
      timeout: 120_000,
    },
  ],
})
