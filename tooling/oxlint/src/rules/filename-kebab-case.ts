import { defineRule } from "@oxlint/plugins"

import { repoSourceSegments } from "../repo-paths.ts"

const KEBAB_FILE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+)*\.[cm]?[jt]sx?$/

export const filenameKebabCaseRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Require source filenames to be kebab-case under the governed tree (apps/, packages/, examples/, tooling/, infra/).",
    },
    messages: {
      notKebab:
        "Filename '{{name}}' must be kebab-case (e.g. 'command-handler.ts'). Rename the file; do not add an exemption.",
    },
  },
  create(context) {
    return {
      Program(node) {
        const segments = repoSourceSegments(context.filename)

        if (segments === null) return
        const leaf = segments[segments.length - 1]

        if (leaf === undefined || KEBAB_FILE.test(leaf)) return
        context.report({ node, messageId: "notKebab", data: { name: leaf } })
      },
    }
  },
})
