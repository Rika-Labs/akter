import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"
import base from "../../vitest.config.ts"
import { shards } from "./src/testing/conformance/postgres/shards.ts"

const testing = "packages/durable-actors/src/testing"

/**
 * Runs the Postgres integration files in parallel workers, one database each.
 * The Docker drills stay out: they run alone, through the root config, so their
 * timings and the ports and containers they take are theirs.
 */
export default defineConfig({
  test: {
    include: [
      `${testing}/conformance.test.ts`,
      ...Object.keys(shards).map((shard) => `${testing}/conformance/${shard}.test.ts`),
      `${testing}/conformance/postgres/*.test.ts`,
      `${testing}/conformance/crash/**/*.test.ts`,
      `${testing}/conformance/neki/backend.test.ts`,
      "packages/durable-actors/src/runtime/database/migrations.test.ts",
      "packages/durable-actors/src/runtime/storage/generation.test.ts",
      "packages/durable-actors/src/runtime/events/append.test.ts",
      "packages/durable-actors/src/runtime/database/neki/session.test.ts",
    ],
    exclude: ["**/node_modules/**", `${testing}/conformance/crash/drills/**`],
    globalSetup: [
      fileURLToPath(new URL("./src/testing/conformance/postgres/template.ts", import.meta.url)),
    ],
    fileParallelism: true,
    maxWorkers: 2,
    testTimeout: base.test?.testTimeout,
    hookTimeout: 60_000,
  },
})
