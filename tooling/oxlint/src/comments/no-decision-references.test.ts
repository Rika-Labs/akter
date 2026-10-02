import { describe, it } from "vitest"
import { RuleTester } from "oxlint/plugins-dev"

import { noDecisionReferencesRule } from "./no-decision-references.ts"

RuleTester.describe = describe

RuleTester.it = it

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } })

const error = { messageId: "decisionReference" }

tester.run("akter/no-decision-references", noDecisionReferencesRule, {
  valid: [
    "// Commands are direct: the receipt is the only admission record.\nexport {}",
    "/** Which rows share a shard: the tenant (default) or each actor on its own. */\nexport {}",
    'export const title = "ADR 0011 direct commands"',
    "// Postgres bug #18934 reorders this lock; take it first.\nexport {}",
    "// The caller decides the retry policy.\nexport {}",
    "// Padding keeps the address aligned.\nexport {}",
  ],
  invalid: [
    { code: "// Commands are direct (ADR 0011).\nexport {}", errors: [error] },
    { code: "/** Placement rows (ADR-0006). */\nexport {}", errors: [error] },
    { code: "// Reconciled with ADRs 0010-0012.\nexport {}", errors: [error] },
    { code: "// see docs/decisions/0010-one-way-effect-native-api.md\nexport {}", errors: [error] },
    { code: "/*\n * Upcasts run in order (v4 decision 162).\n */\nexport {}", errors: [error] },
    { code: "// per decisions #4 and #5\nexport {}", errors: [error] },
    {
      code: "// ADR 0005 batching\n// ADR 0011 outbox\nexport {}",
      errors: [error, error],
    },
  ],
})
