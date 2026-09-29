import { defineConfig, devices } from "@playwright/test"

const inCI = process.env.CI === "true"

/**
 * Browser test configuration. It starts the console preview, then the chat
 * example on in-memory PGlite for `chat.e2e.ts`, `react.e2e.ts` and
 * `cursors.e2e.ts`, and the counter example on in-memory PGlite for
 * `counter.e2e.ts`.
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
    {
      command: "PORT=3004 bun examples/counter/src/web/serve.ts",
      cwd: "../..",
      url: "http://127.0.0.1:3004/health",
      reuseExistingServer: !inCI,
      timeout: 120_000,
    },
  ],
})
