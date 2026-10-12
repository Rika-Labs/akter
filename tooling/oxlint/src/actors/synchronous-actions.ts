import { defineRule } from "@oxlint/plugins"
import { Schema } from "effect"
import type { ESTree } from "@oxlint/plugins"

import { contractJobs } from "./contract-jobs.ts"

const isString = Schema.is(Schema.String)

const GLOBAL_MESSAGES = new Map([
  ["Date", "date"],
  ["crypto", "crypto"],
  ["performance", "performance"],
  ["process", "process"],
  ["globalThis", "globalThis"],
  ["Promise", "promise"],
  ["setTimeout", "timer"],
  ["setInterval", "timer"],
  ["Intl", "intl"],
  ["structuredClone", "structuredClone"],
])

const EXACT_MATH = new Set(["floor", "ceil", "round", "trunc", "abs", "min", "max", "sign"])

const MATH_CONSTANTS = new Set(["PI", "E", "LN2", "LN10", "LOG2E", "LOG10E", "SQRT1_2", "SQRT2"])

const LOCALE_MEMBERS = new Set([
  "toLocaleString",
  "toLocaleDateString",
  "toLocaleTimeString",
  "localeCompare",
])

const ERROR_MEMBERS = new Set(["message", "stack"])

const EXPRESSION_WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
])

type FunctionNode = ESTree.ArrowFunctionExpression | ESTree.Function

function keyName(key: ESTree.Node, computed: boolean): string | null {
  if (key.type === "Identifier") return computed ? null : key.name
  if (key.type === "Literal" && isString(key.value)) return key.value

  return null
}

function memberName(member: ESTree.MemberExpression): string | null {
  if (!member.computed) return member.property.type === "Identifier" ? member.property.name : null

  return member.property.type === "Literal" && isString(member.property.value)
    ? member.property.value
    : null
}

function isReference(node: ESTree.Node, parent: ESTree.Node): boolean {
  switch (parent.type) {
    case "MemberExpression":
      return parent.object === node || parent.computed
    case "Property":
      return parent.value === node || parent.computed
    case "PropertyDefinition":
    case "MethodDefinition":
    case "AccessorProperty":
      return parent.computed || parent.key !== node
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
    case "ImportSpecifier":
    case "ImportDefaultSpecifier":
    case "ImportNamespaceSpecifier":
    case "ExportSpecifier":
      return false
    default:
      return !parent.type.startsWith("TS") || EXPRESSION_WRAPPERS.has(parent.type)
  }
}

/**
 * Keeps action, view, `connect` and `disconnect` handlers deterministic so a
 * turn can be replayed from the log: they run as plain synchronous functions
 * and reach the world only through `ctx`. Job handlers, the ones the
 * contract lists under `jobs:`, are exempt because jobs are where I/O lives.
 *
 * Handlers are the function values written inline in the object literal
 * passed to `<Contract>.toLayer({...})`. The contract is the
 * `Actor.make(name, { ... jobs: { ... } })` call that `<Contract>` resolves
 * to in the same module or, through relative imports and re-exports, in
 * another module; a receiver that does not resolve to one (a package import,
 * a computed value, another service's `toLayer`) is left alone. Helpers
 * defined inside a handler are checked; helpers declared elsewhere and
 * referenced by name (`post: handlePost`) are not, and neither is type
 * information: a `.toString(radix)` call is reported for any receiver and a
 * caught error's `.message` or `.stack` only when read from the `catch`
 * binding itself.
 */
export const synchronousActionsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require action, view, connect and disconnect handlers passed to Actor.toLayer to be synchronous, deterministic plain functions.",
    },
    messages: {
      date: "`Date` reads the host clock. Use `ctx.now()` for the current time.",
      random: "`Math.random` is not replayable. Use `ctx.random()`.",
      mathInexact:
        "`Math.{{name}}` is not bit-exact across engines. Use only floor, ceil, round, trunc, abs, min, max or sign, or compute the value in a job and pass it in through an action.",
      mathDynamic:
        "`Math` used without a direct member cannot be checked. Call floor, ceil, round, trunc, abs, min, max or sign directly.",
      exponent:
        "`**` and `**=` are not bit-exact across engines. Multiply explicitly, for example `x * x`.",
      crypto:
        "`crypto` is not replayable. Use `ctx.id()` for identifiers and `ctx.random()` for random numbers.",
      performance: "`performance` reads a host clock. Use `ctx.now()`.",
      process:
        "`process` reads the host. Move the work to a job, or pass the value in through the action payload.",
      globalThis:
        "`globalThis` reaches host globals. Move the work to a job, or use `ctx.now()`, `ctx.random()` and `ctx.id()`.",
      promise: "Actions are synchronous. Move asynchronous work to a job.",
      await: "Actions are synchronous. Move `await` and the I/O it waits on to a job.",
      asyncFunction: "Actions are synchronous. Remove `async` and move the I/O to a job.",
      timer: "Timers do not exist in actions. Use `ctx.schedule(delay).<action>(payload)`.",
      intl: "`Intl` depends on host locale and ICU data. Format on the client or in a job.",
      locale:
        "`{{name}}` depends on the host locale. Compare with `<` and `>` and format on the client.",
      radix:
        "`toString` with an argument is implementation-defined for numbers. Use `String(value)` for decimal text, or format in a job.",
      errorDetail:
        "`.{{name}}` of a caught error differs across engines. Return the declared `fails` error and branch on its type.",
      structuredClone:
        "`structuredClone` is host-specific. Copy with spread; the draft is already copy-on-write.",
      effect: "Actions are plain functions, not Effects. Move effectful work to a job.",
      yield: "Actions are plain functions, not generators. Move effectful work to a job.",
    },
  },
  create(context) {
    const handlers = new Set<FunctionNode>()
    const reported = new Set<string>()
    const caught: Array<string | null> = []
    let depth = 0

    const report = (node: ESTree.Node, messageId: string, data?: Record<string, string>) => {
      const key = `${node.start}:${messageId}`

      if (reported.has(key)) return
      reported.add(key)
      context.report({ node, messageId, data })
    }

    const enterFunction = (node: FunctionNode) => {
      if (handlers.has(node)) depth += 1
      if (depth > 0 && node.async) report(node, "asyncFunction")
    }

    const exitFunction = (node: FunctionNode) => {
      if (handlers.has(node)) depth -= 1
    }

    const isDeclared = (identifier: ESTree.Node, name: string, withModuleScope: boolean) => {
      let scope = context.sourceCode.getScope(identifier)

      while (scope.upper !== null) {
        if (scope.set.has(name) && (withModuleScope || scope.type !== "module")) return true
        scope = scope.upper
      }

      return false
    }

    return {
      CallExpression(node) {
        const callee = node.callee

        if (
          callee.type === "MemberExpression" &&
          memberName(callee) === "toLayer" &&
          node.arguments[0]?.type === "ObjectExpression"
        ) {
          const jobs = contractJobs(
            context.filename,
            context.sourceCode.text,
            context.sourceCode.getText(callee.object),
          )

          if (jobs !== null) {
            for (const member of node.arguments[0].properties) {
              if (member.type !== "Property") continue

              const name = keyName(member.key, member.computed)

              if (name === null || jobs.has(name)) continue
              if (
                member.value.type === "ArrowFunctionExpression" ||
                member.value.type === "FunctionExpression"
              )
                handlers.add(member.value)
            }
          }
        }

        if (
          depth > 0 &&
          callee.type === "MemberExpression" &&
          memberName(callee) === "toString" &&
          node.arguments.length > 0
        )
          report(node, "radix")
      },
      FunctionDeclaration: enterFunction,
      "FunctionDeclaration:exit": exitFunction,
      FunctionExpression: enterFunction,
      "FunctionExpression:exit": exitFunction,
      ArrowFunctionExpression: enterFunction,
      "ArrowFunctionExpression:exit": exitFunction,
      CatchClause(node) {
        const param = node.param

        caught.push(param !== null && param.type === "Identifier" ? param.name : null)

        if (depth === 0 || param === null || param.type !== "ObjectPattern") return

        for (const property of param.properties) {
          if (property.type !== "Property") continue

          const name = keyName(property.key, property.computed)

          if (name !== null && ERROR_MEMBERS.has(name)) report(property, "errorDetail", { name })
        }
      },
      "CatchClause:exit"() {
        caught.pop()
      },
      MemberExpression(node) {
        if (depth === 0) return

        const name = memberName(node)

        if (name === null) return
        if (LOCALE_MEMBERS.has(name)) report(node, "locale", { name })
        if (
          ERROR_MEMBERS.has(name) &&
          node.object.type === "Identifier" &&
          caught.includes(node.object.name)
        )
          report(node, "errorDetail", { name })
      },
      BinaryExpression(node) {
        if (depth > 0 && node.operator === "**") report(node, "exponent")
      },
      AssignmentExpression(node) {
        if (depth > 0 && node.operator === "**=") report(node, "exponent")
      },
      AwaitExpression(node) {
        if (depth > 0) report(node, "await")
      },
      ForOfStatement(node) {
        if (depth > 0 && node.await) report(node, "await")
      },
      YieldExpression(node) {
        if (depth > 0) report(node, "yield")
      },
      Identifier(node) {
        if (depth === 0 || !isReference(node, node.parent)) return

        if (node.name === "Effect") {
          if (!isDeclared(node, node.name, false)) report(node, "effect")

          return
        }

        const messageId = GLOBAL_MESSAGES.get(node.name)

        if (messageId === undefined && node.name !== "Math") return
        if (isDeclared(node, node.name, true)) return
        if (messageId !== undefined) {
          report(node, messageId)

          return
        }

        const parent = node.parent
        const member = parent.type === "MemberExpression" && parent.object === node ? parent : null
        const name = member === null ? null : memberName(member)

        if (member === null || name === null) {
          report(node, "mathDynamic")

          return
        }
        if (name === "random") report(member, "random")
        else if (!EXACT_MATH.has(name) && !MATH_CONSTANTS.has(name))
          report(member, "mathInexact", { name })
      },
    }
  },
})
