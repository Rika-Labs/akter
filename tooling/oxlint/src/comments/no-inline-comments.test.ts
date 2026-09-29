import { describe, it } from "vitest"
import { RuleTester } from "oxlint/plugins-dev"

import { noInlineCommentsRule } from "./no-inline-comments.ts"

RuleTester.describe = describe

RuleTester.it = it

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } })

const error = { messageId: "inlineComment" }

tester.run("durable-actors/no-inline-comments", noInlineCommentsRule, {
  valid: [
    "/** Why the retry cap is three. */\nexport const cap = 3",
    "/**\n * Sign the original bytes: re-encoding changes the signature.\n */\nexport function sign() {}",
    "export function run() {\n  /** Local reason. */\n  const value = 1\n  return value\n}",
    "// @ts-expect-error the fixture is intentionally wrong\nexport const value: number = 'x'",
    "// @ts-ignore\nexport const value: number = 'x'",
    "// oxlint-disable-next-line no-console\nexport const log = console.log",
    "/* eslint-disable no-console */\nexport const log = console.log",
    '/// <reference types="bun" />\nexport {}',
    "/* @license MIT */\nexport {}",
    "/*!\n * Copyright (c) Example. All rights reserved.\n */\nexport {}",
    "// SPDX-License-Identifier: Apache-2.0\nexport {}",
    "#!/usr/bin/env bun\nexport {}",
    "export const value = /* @__PURE__ */ create()",
    "export const load = () => import(/* @vite-ignore */ path)",
    'export const text = "// not a comment"',
    "export {}",
  ],
  invalid: [
    { code: "// Increment the counter\nexport {}", errors: [error] },
    { code: "/* block comment */\nexport {}", errors: [error] },
    { code: "export const a = 1 // trailing", errors: [error] },
    { code: "export function run() {\n  // inside a body\n  return 1\n}", errors: [error] },
    { code: "export {}\n// Copyright (c) Example\nexport const a = 1", errors: [error] },
    { code: "// just a header note\n/** Doc. */\nexport const a = 1", errors: [error] },
    { code: "/** Doc. */\nexport const a = 1\n// a\n// b", errors: [error, error] },
    { code: "// eslint is great\nexport {}", errors: [error] },
  ],
})
