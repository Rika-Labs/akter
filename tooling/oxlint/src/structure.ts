import { eslintCompatPlugin } from "@oxlint/plugins"

import { filenameKebabCaseRule } from "./rules/filename-kebab-case.ts"
import { noDecisionReferencesRule } from "./comments/no-decision-references.ts"
import { noInlineCommentsRule } from "./comments/no-inline-comments.ts"
import { noGenericDirectorySegmentRule } from "./rules/no-generic-directory-segment.ts"
import { noParentEchoInFilenameRule } from "./rules/no-parent-echo-in-filename.ts"
import { noRoleSuffixFilenameRule } from "./rules/no-role-suffix-filename.ts"
import { noRuntimeImportOutsideRuntimeRule } from "./rules/no-runtime-import-outside-runtime.ts"

const repoStructurePlugin = eslintCompatPlugin({
  meta: { name: "akter" },
  rules: {
    "filename-kebab-case": filenameKebabCaseRule,
    "no-parent-echo-in-filename": noParentEchoInFilenameRule,
    "no-role-suffix-filename": noRoleSuffixFilenameRule,
    "no-generic-directory-segment": noGenericDirectorySegmentRule,
    "no-runtime-import-outside-runtime": noRuntimeImportOutsideRuntimeRule,
    "no-decision-references": noDecisionReferencesRule,
    "no-inline-comments": noInlineCommentsRule,
  },
})

export default repoStructurePlugin
