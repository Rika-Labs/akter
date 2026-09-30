import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"
import base from "../../vitest.config.ts"
import { shards, UNSHARDED } from "./src/testing/conformance/postgres/shards.ts"

const testing = "packages/durable-actors/src/testing"

const worker = `${testing}/conformance/postgres/backend.test.ts`

/**
 * Runs the Postgres integration files in parallel workers, one database each.
 * Each conformance shard is a project of its own that runs `backend.test.ts`,
 * so the shard registry, not a file per shard, decides the workers. The
 * Docker drills stay out: they run alone, through the root config, so their
 * timings and the ports and containers they take are theirs.
 */
export default defineConfig({
  test: {
    globalSetup: [
      fileURLToPath(new URL("./src/testing/conformance/postgres/template.ts", import.meta.url)),
    ],
    fileParallelism: true,
    maxWorkers: 2,
    testTimeout: base.test?.testTimeout,
    hookTimeout: 60_000,
    projects: [
      ...[UNSHARDED, ...Object.keys(shards)].map((shard) => ({
        extends: true as const,
        test: {
          name: `postgres:${shard}`,
          include: [worker],
          provide: { conformanceShard: shard },
        },
      })),
      {
        extends: true as const,
        test: {
          name: "integration",
          include: [
            `${testing}/conformance/postgres/*.test.ts`,
            `${testing}/conformance/crash/**/*.test.ts`,
            `${testing}/conformance/neki/backend.test.ts`,
            "packages/durable-actors/src/runtime/database/migrations.test.ts",
            "packages/durable-actors/src/runtime/database/fencing.test.ts",
            "packages/durable-actors/src/runtime/database/neki/session.test.ts",
          ],
          exclude: [
            "**/node_modules/**",
            `${testing}/conformance/crash/drills/**`,
            `${testing}/conformance/postgres/shards.test.ts`,
            worker,
          ],
        },
      },
    ],
  },
})
