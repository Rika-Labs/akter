import { defineRule } from "@oxlint/plugins"

const CITATION = /\bADRs?\b|\bdocs\/decisions\b|\bdecisions?\s+#?\d/i

/**
 * Catches the literal citation forms without judgment so CI fails even when
 * the reviewer rule .amp/rules/quality/47-no-decision-references-in-code.md is
 * not running; paraphrased citations ("per the v4 pick") are left to it.
 */
export const noDecisionReferencesRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow comments that cite an ADR, a numbered decision, or docs/decisions instead of stating the reason in place.",
    },
    messages: {
      decisionReference:
        "Comments must not cite decision records. Delete the citation and keep the reason it stood for.",
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (CITATION.test(comment.value)) {
            context.report({ node: comment, messageId: "decisionReference" })
          }
        }
      },
    }
  },
})
