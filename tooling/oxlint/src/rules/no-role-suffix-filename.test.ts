import { describe, it } from "vitest"
import { RuleTester } from "oxlint/plugins-dev"

import { noRoleSuffixFilenameRule } from "./no-role-suffix-filename.ts"

RuleTester.describe = describe

RuleTester.it = it

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } })

const error = { messageId: "roleSuffix" }

tester.run("akter/no-role-suffix-filename", noRoleSuffixFilenameRule, {
  valid: [
    { code: "export {};", filename: "packages/deployments/src/deployment/layer.ts" },
    { code: "export {};", filename: "packages/deployments/src/deployment/repository.ts" },
    { code: "export {};", filename: "packages/accounts/src/service.ts" },
    { code: "export {};", filename: "apps/edge/src/service-map.ts" },
    { code: "export {};", filename: "research/v4/example/user-service.ts" },
  ],
  invalid: [
    { code: "export {};", filename: "packages/accounts/src/user-service.ts", errors: [error] },
    { code: "export {};", filename: "apps/api/src/billing-service.ts", errors: [error] },
    { code: "export {};", filename: "infra/src/railway-service.ts", errors: [error] },
  ],
})
