import { defineRule } from "@oxlint/plugins"

const DIRECTIVE =
  /^\s*(?:(?:oxlint|eslint|biome|prettier)-[\w-]+|@ts-[\w-]+|(?:istanbul|c8|v8|node:coverage)\s+(?:ignore|disable|enable)|[@#]__[A-Z_]+__|@vite-ignore|@jsx(?:ImportSource|Runtime|Frag)?\b)/

const LICENSE = /@license|@preserve|copyright|spdx-license-identifier|permission is hereby granted/i

/**
 * Inline comments are banned so a reason lives in the JSDoc of the enclosing
 * declaration, where tooling and readers find it. Only JSDoc blocks, functional
 * directives (lint, TypeScript, coverage, bundler hints, triple-slash
 * references) and a license header before the first statement are allowed.
 */
export const noInlineCommentsRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow inline // and /* */ comments; put the reason in the JSDoc of the enclosing declaration.",
    },
    messages: {
      inlineComment:
        "Inline comments are not allowed. Move the reason into the JSDoc of the enclosing declaration, or delete the comment.",
    },
  },
  create(context) {
    return {
      Program(program) {
        const firstStatement = program.body[0]?.range[0] ?? Infinity

        for (const comment of context.sourceCode.getAllComments()) {
          const exempt =
            comment.type === "Shebang" ||
            (comment.type === "Block" && comment.value.startsWith("*")) ||
            DIRECTIVE.test(comment.value) ||
            comment.value.startsWith("/") ||
            (comment.range[0] < firstStatement && LICENSE.test(comment.value))

          if (exempt) continue

          context.report({ node: comment, messageId: "inlineComment" })
        }
      },
    }
  },
})
