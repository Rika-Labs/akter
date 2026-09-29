import { defineRule } from "@oxlint/plugins"

import { repoSourceSegments } from "../repo-paths.ts"

/** Forbids filenames that repeat their folder's name, such as `order/order-total.ts`. */
export const noParentEchoInFilenameRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow filenames that echo their parent directory name, e.g. `<parent>-<x>.ts` — the directory already names the feature.",
    },
    messages: {
      parentEcho:
        "Filename '{{name}}' repeats its parent directory '{{parent}}'. Rename the file; the folder already scopes it.",
    },
  },
  create(context) {
    return {
      Program(node) {
        const segments = repoSourceSegments(context.filename)

        if (segments === null || segments.length < 3) return
        const leaf = segments[segments.length - 1]
        const parent = segments[segments.length - 2]

        if (leaf === undefined || parent === undefined) return
        const stem = leaf.replace(/\.[cm]?[jt]sx?$/, "")

        if (stem === parent || stem.startsWith(`${parent}-`)) {
          context.report({ node, messageId: "parentEcho", data: { name: leaf, parent } })
        }
      },
    }
  },
})
