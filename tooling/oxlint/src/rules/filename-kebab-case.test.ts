import { describe, it } from "vitest"
import { RuleTester } from "oxlint/plugins-dev"

import { filenameKebabCaseRule } from "./filename-kebab-case.ts"

RuleTester.describe = describe

RuleTester.it = it

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } })

const error = { messageId: "notKebab" }

tester.run("durable-actors/filename-kebab-case", filenameKebabCaseRule, {
  valid: [
    { code: "export {};", filename: "packages/deployments/src/contract.ts" },
    { code: "export {};", filename: "packages/durable-actors/src/runtime/turn/execute.ts" },
    { code: "export {};", filename: "apps/api/src/app.ts" },
    { code: "export {};", filename: "packages/deployments/src/deployment.test.ts" },
    { code: "export {};", filename: "infra/src/railway.ts" },
    { code: "export {};", filename: "research/v4/framework/Actor.ts" },
    { code: "export {};", filename: "tooling/oxlint/anti-slop/rules/index.ts" },
    { code: "export {};", filename: "ScratchFile.ts" },
    { code: "export {};", filename: "/tmp/CaseFile.ts" },
    { code: "export {};", filename: "C:\\repo\\packages\\deployments\\src\\contract.ts" },
  ],
  invalid: [
    { code: "export {};", filename: "packages/deployments/src/Deployment.ts", errors: [error] },
    { code: "export {};", filename: "apps/console/src/App.test.tsx", errors: [error] },
    { code: "export {};", filename: "examples/counter/src/Counter_Actor.ts", errors: [error] },
    { code: "export {};", filename: "tooling/structure/src/treeCheck.ts", errors: [error] },
    { code: "export {};", filename: "infra/src/Railway.ts", errors: [error] },
  ],
})
