import { defineConfig } from "vitest/config"
import base from "../../vitest.config.ts"

/**
 * The CLI suites that need a running service: `akter storage check` against
 * the bucket named by `TEST_S3_URL`, so they stay out of `test`.
 */
export default defineConfig({
  test: {
    include: ["src/commands/storage/check.s3.test.ts"],
    testTimeout: base.test?.testTimeout,
  },
})
