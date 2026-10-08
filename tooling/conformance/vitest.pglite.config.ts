import { defineConfig } from "vitest/config"
import base from "../../vitest.config.ts"
import { shards, UNSHARDED } from "./src/conformance/postgres/shards.ts"

/**
 * Runs the PGlite conformance groups the way the integration config runs the
 * Postgres ones: each shard is a project that runs `pglite/backend.test.ts`
 * with only that shard's groups, so CI can give a project filter to each job
 * and every shard still lands in exactly one of them.
 */
export default defineConfig({
  test: {
    fileParallelism: true,
    maxWorkers: 2,
    testTimeout: base.test?.testTimeout,
    projects: [UNSHARDED, ...Object.keys(shards)].map((shard) => ({
      extends: true as const,
      test: {
        name: `pglite:${shard}`,
        include: ["tooling/conformance/src/conformance/pglite/backend.test.ts"],
        provide: { conformanceShard: shard },
      },
    })),
  },
})
