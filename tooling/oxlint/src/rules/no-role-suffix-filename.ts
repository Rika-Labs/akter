import { defineRule } from "@oxlint/plugins"

import { repoSourceSegments } from "../repo-paths.ts"

export const noRoleSuffixFilenameRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow `<name>-service.ts` filenames — name the file for its role (layer.ts, repository.ts) or operation instead.",
    },
    messages: {
      roleSuffix:
        "Filename '{{name}}' uses the banned '-service' suffix. Name the file for its role (e.g. layer.ts, repository.ts) or its operation.",
    },
  },
  create(context) {
    return {
      Program(node) {
        const segments = repoSourceSegments(context.filename)

        if (segments === null) return
        const leaf = segments[segments.length - 1]

        if (leaf === undefined || !/-service\.[cm]?[jt]sx?$/.test(leaf)) return
        context.report({ node, messageId: "roleSuffix", data: { name: leaf } })
      },
    }
  },
})
