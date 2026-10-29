import { describe, it } from "vitest"
import { RuleTester } from "oxlint/plugins-dev"

import { resultCommandNamesRule } from "./result-command-names.ts"

RuleTester.describe = describe

RuleTester.it = it

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } })

const job = (options: string) => `import { Actor } from "@rikalabs/akter"
Actor.job({ ${options} })`

const error = (option: string, name: string) => ({
  messageId: "resultName",
  data: {
    option,
    name,
    expected: option === "onSuccess" ? "succeeded or completed" : "failed",
    example: option === "onSuccess" ? "succeededSync" : "failedSync",
  },
})

tester.run("result-command-names", resultCommandNamesRule, {
  valid: [
    job(`onFailure: "failed"`),
    job(`onFailure: "failedSync"`),
    job(`onSuccess: "succeededSync", onFailure: "failedSync"`),
    job(`onSuccess: "completedSync", onFailure: "failedSync"`),
    job(`"onFailure": "failedSync"`),
    job(`onFailure: name`),
    `import { Actor } from "@rikalabs/akter"
Other.job({ onFailure: "retryLater" })`,
    `const options = { onFailure: "retryLater" }`,
  ],
  invalid: [
    { code: job(`onFailure: "retryLater"`), errors: [error("onFailure", "retryLater")] },
    { code: job(`onFailure: "failedsync"`), errors: [error("onFailure", "failedsync")] },
    { code: job(`onFailure: "syncFailed"`), errors: [error("onFailure", "syncFailed")] },
    {
      code: job(`onSuccess: "saveResult", onFailure: "failedSync"`),
      errors: [error("onSuccess", "saveResult")],
    },
    {
      code: job(`onSuccess: "succeededsync", onFailure: "failed"`),
      errors: [error("onSuccess", "succeededsync")],
    },
  ],
})
