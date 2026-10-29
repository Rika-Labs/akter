import { defineRule } from "@oxlint/plugins"
import type { ESTree } from "@oxlint/plugins"
import { Schema } from "effect"

const isString = Schema.is(Schema.String)

/**
 * Each result option of `Actor.job` and the past-tense prefixes the command it names must start
 * with: a result records what happened to the job, so it reads as a fact, not an instruction.
 */
const RESULTS = new Map([
  [
    "onSuccess",
    { pattern: /^(succeeded|completed)(?=[A-Z]|$)/, expected: "succeeded or completed" },
  ],
  ["onFailure", { pattern: /^failed(?=[A-Z]|$)/, expected: "failed" }],
])

const isActorJob = (node: ESTree.CallExpression): boolean =>
  node.callee.type === "MemberExpression" &&
  !node.callee.computed &&
  node.callee.object.type === "Identifier" &&
  node.callee.object.name === "Actor" &&
  node.callee.property.type === "Identifier" &&
  node.callee.property.name === "job"

const keyName = (property: ESTree.ObjectProperty): string | undefined => {
  if (property.computed) return undefined
  if (property.key.type === "Identifier") return property.key.name
  if (property.key.type === "Literal" && isString(property.key.value)) return property.key.value
  return undefined
}

/**
 * Reports a job whose `onSuccess` or `onFailure` names a command without its past-tense prefix,
 * such as `onFailure: "retryLater"` instead of `onFailure: "failedSync"`.
 */
export const resultCommandNamesRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Require the internal commands named by Actor.job onSuccess and onFailure to be past-tense facts: succeeded<Job> or completed<Job>, and failed<Job>.",
    },
    messages: {
      resultName:
        "{{option}} names '{{name}}'; a job result is a past-tense fact, so name the command {{expected}}<Job>, for example {{example}}.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isActorJob(node)) return
        const options = node.arguments[0]
        if (options === undefined || options.type !== "ObjectExpression") return
        for (const property of options.properties) {
          if (property.type !== "Property") continue
          const option = keyName(property)
          const rule = option === undefined ? undefined : RESULTS.get(option)
          if (option === undefined || rule === undefined) continue
          const value = property.value
          if (value.type !== "Literal" || !isString(value.value)) continue
          if (rule.pattern.test(value.value)) continue
          context.report({
            node: value,
            messageId: "resultName",
            data: {
              option,
              name: value.value,
              expected: rule.expected,
              example: option === "onSuccess" ? "succeededSync" : "failedSync",
            },
          })
        }
      },
    }
  },
})
