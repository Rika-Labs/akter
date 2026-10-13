import { defineConfig } from "vitest/config"
import base from "../../vitest.config.ts"

/**
 * Store protocols and independent Cluster processes use the real bucket named by `TEST_S3_URL`.
 * Keeping these suites serial also isolates the local handoff measurements from probe load.
 */
export default defineConfig({
  test: {
    include: ["src/store/s3.test.ts", "src/runtime/cluster-process.test.ts"],
    fileParallelism: false,
    testTimeout: base.test?.testTimeout,
  },
})
