import { describe, it } from "vitest"
import { RuleTester } from "oxlint/plugins-dev"

import { noGenericDirectorySegmentRule } from "./no-generic-directory-segment.ts"

RuleTester.describe = describe

RuleTester.it = it

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } })

const error = { messageId: "genericSegment" }

tester.run("akter/no-generic-directory-segment", noGenericDirectorySegmentRule, {
  valid: [
    { code: "export {};", filename: "packages/akter/src/runtime/turn/execute.ts" },
    { code: "export {};", filename: "packages/deployments/src/deployment/contract.ts" },
    { code: "export {};", filename: "apps/api/src/app.ts" },
    { code: "export {};", filename: "packages/deployments/src/deployment/workflows/ship.ts" },
    { code: "export {};", filename: "packages/contracts/src/types.ts" },
    { code: "export {};", filename: "research/v1/source/core/index.ts" },
    { code: "export {};", filename: "node_modules/pkg/lib/index.js" },
  ],
  invalid: [
    { code: "export {};", filename: "packages/accounts/src/utils/hash.ts", errors: [error] },
    { code: "export {};", filename: "apps/api/src/shared/logger.ts", errors: [error] },
    { code: "export {};", filename: "packages/akter/src/types/id.ts", errors: [error] },
    { code: "export {};", filename: "infra/src/common/config.ts", errors: [error] },
    {
      code: "export {};",
      filename: "packages/foo/src/internal/utils/x.ts",
      errors: [error, error],
    },
  ],
})
