import { defineConfig, devices } from "@playwright/test"

const inCI = process.env.CI === "true"
const livePort = process.env.E2E_LIVE_PORT ?? "3539"
const streamPort = process.env.E2E_STREAM_PORT ?? "3540"
const fixturePort = process.env.E2E_FIXTURE_PORT ?? "3002"

/** Browser test configuration. It builds the console and serves it with Vite's preview server. */
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  forbidOnly: inCI,
  retries: inCI ? 2 : 0,
  reporter: inCI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${fixturePort}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: [
    {
      command: `E2E_STREAM_PORT=${streamPort} bun stream.ts`,
      url: `http://127.0.0.1:${streamPort}/stats`,
      reuseExistingServer: !inCI,
      timeout: 120_000,
    },
    {
      command: `VITE_CONSOLE_FIXTURES=1 bun run build && CONSOLE_PORT=${fixturePort} bun run preview`,
      cwd: "../console",
      url: `http://127.0.0.1:${fixturePort}/`,
      reuseExistingServer: !inCI,
      timeout: 120_000,
    },
    {
      command: `VITE_CONSOLE_FIXTURES=0 bun run build --outDir .cache/e2e-live && CONSOLE_PORT=${livePort} bun run preview --outDir .cache/e2e-live`,
      cwd: "../console",
      url: `http://127.0.0.1:${livePort}/`,
      reuseExistingServer: !inCI,
      timeout: 120_000,
    },
  ],
})
