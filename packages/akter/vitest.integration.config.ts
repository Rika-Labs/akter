import { defineConfig } from "vitest/config"
import base from "../../vitest.config.ts"

/**
 * The framework suites that need a running service: the store's S3 suite needs
 * the bucket named by `TEST_S3_URL`, so it stays out of `test`.
 */
export default defineConfig({
  test: {
    include: ["src/store/s3.test.ts"],
    testTimeout: base.test?.testTimeout,
  },
})
