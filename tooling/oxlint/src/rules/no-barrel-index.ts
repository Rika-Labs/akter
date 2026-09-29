import { defineRule } from "@oxlint/plugins"

import { repoSourceSegments } from "../repo-paths.ts"

const INDEX_FILE = /^index\.[cm]?[jt]sx?$/

/** Forbids `index.ts` except as a package or subpath entry. */
export const noBarrelIndexRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow index.ts barrel files outside package and subpath entry positions (src/index.ts, src/<entry>/index.ts).",
    },
    messages: {
      barrelIndex:
        "'{{name}}' is a barrel index — index.ts is only allowed as a package or subpath entry (src/index.ts or src/<entry>/index.ts). Give the module a real filename.",
    },
  },
  create(context) {
    return {
      Program(node) {
        const segments = repoSourceSegments(context.filename)

        if (segments === null) return
        const leaf = segments[segments.length - 1]

        if (leaf === undefined || !INDEX_FILE.test(leaf)) return
        const src = segments.indexOf("src")
        const depth = segments.length - src - 2

        if (src === -1 || depth > 1) {
          context.report({ node, messageId: "barrelIndex", data: { name: leaf } })
        }
      },
    }
  },
})
