import { defineRule } from "@oxlint/plugins"
import { Schema } from "effect"

const RUNTIME_MODULES = new Set([
  "effect/unstable/sql",
  "effect/unstable/cluster",
  "@effect/sql-pg",
  "@effect/sql-pglite",
])

const FRAMEWORK = /(?:^|\/)packages\/durable-actors\//

const ALLOWED_FOLDER = /(?:^|\/)packages\/durable-actors\/src\/(?:runtime|testing)\//

interface WithSource {
  readonly source?: { readonly value?: unknown } | null
}

export const noRuntimeImportOutsideRuntimeRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow imports of effect/unstable/sql, effect/unstable/cluster and @effect/sql-pg inside packages/durable-actors outside src/runtime/ and src/testing/.",
    },
    messages: {
      runtimeImport:
        "'{{source}}' may only be imported under packages/durable-actors/src/{runtime,testing}/ — the root and client entries must stay browser-safe.",
    },
  },
  create(context) {
    if (!FRAMEWORK.test(context.filename) || ALLOWED_FOLDER.test(context.filename)) return {}

    const check = (node: Parameters<typeof context.report>[0]["node"] & WithSource) => {
      const source = node.source?.value

      if (!Schema.is(Schema.String)(source) || !RUNTIME_MODULES.has(source)) return
      context.report({ node, messageId: "runtimeImport", data: { source } })
    }

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: (node) => {
        const source = node.source

        if (source.type !== "Literal" || !Schema.is(Schema.String)(source.value)) return

        if (!RUNTIME_MODULES.has(source.value)) return

        context.report({ node, messageId: "runtimeImport", data: { source: source.value } })
      },
    }
  },
})
