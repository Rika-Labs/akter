import { describe, it } from "vitest"
import { RuleTester } from "oxlint/plugins-dev"

import { noBarrelIndexRule } from "./no-barrel-index.ts"

RuleTester.describe = describe

RuleTester.it = it

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } })

const error = { messageId: "barrelIndex" }

tester.run("durable-actors/no-barrel-index", noBarrelIndexRule, {
  valid: [
    { code: "export {};", filename: "packages/durable-actors/src/index.ts" },
    { code: "export {};", filename: "packages/durable-actors/src/runtime/index.ts" },
    { code: "export {};", filename: "packages/durable-actors/src/client/index.ts" },
    { code: "export {};", filename: "packages/accounts/src/index.ts" },
    { code: "export {};", filename: "tooling/databases/src/index.ts" },
    { code: "export {};", filename: "packages/durable-actors/src/runtime/turn/execute.ts" },
    { code: "export {};", filename: ".amp/plugins/proof/index.ts" },
    { code: "export {};", filename: "apps/console/src/scenes/index.ts" },
  ],
  invalid: [
    {
      code: "export {};",
      filename: "packages/durable-actors/src/runtime/turn/index.ts",
      errors: [error],
    },
    {
      code: "export {};",
      filename: "packages/deployments/src/deployment/workflows/index.ts",
      errors: [error],
    },
    { code: "export {};", filename: "packages/accounts/bin/index.ts", errors: [error] },
    { code: "export {};", filename: "tooling/oxlint/anti-slop/index.ts", errors: [error] },
  ],
})
