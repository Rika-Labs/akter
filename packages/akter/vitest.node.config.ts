import { defineConfig } from "vitest/config"
import integration from "./vitest.integration.config.ts"
import { shards, UNSHARDED } from "./src/testing/conformance/postgres/shards.ts"

/** Runs the same Postgres conformance shards on Node; subprocess crash drills retain their own runner. */
export default defineConfig({
  ...integration,
  test: {
    ...integration.test,
    projects: [UNSHARDED, ...Object.keys(shards)].map((shard) => ({
      extends: true as const,
      test: {
        name: `postgres:${shard}`,
        include: ["packages/akter/src/testing/conformance/postgres/backend.test.ts"],
        provide: { conformanceShard: shard },
      },
    })),
  },
})
