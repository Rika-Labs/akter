import { describe, it } from "vitest"
import { RuleTester } from "oxlint/plugins-dev"

import { noParentEchoInFilenameRule } from "./no-parent-echo-in-filename.ts"

RuleTester.describe = describe

RuleTester.it = it

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } })

const error = { messageId: "parentEcho" }

tester.run("akter/no-parent-echo-in-filename", noParentEchoInFilenameRule, {
  valid: [
    { code: "export {};", filename: "packages/deployments/src/deployment/contract.ts" },
    { code: "export {};", filename: "packages/deployments/src/deployment/layer.ts" },
    { code: "export {};", filename: "packages/akter/src/runtime/turn/execute.ts" },
    { code: "export {};", filename: "packages/deployments/src/runners/runner.ts" },
    { code: "export {};", filename: "packages/api.ts" },
    { code: "export {};", filename: "research/v4/example/coding-agent.ts" },
  ],
  invalid: [
    {
      code: "export {};",
      filename: "packages/deployments/src/deployment/deployment-contract.ts",
      errors: [error],
    },
    {
      code: "export {};",
      filename: "packages/deployments/src/deployment/deployment.ts",
      errors: [error],
    },
    { code: "export {};", filename: "apps/api/src/routes/routes-index.ts", errors: [error] },
    { code: "export {};", filename: "infra/src/railway/railway.ts", errors: [error] },
  ],
})
