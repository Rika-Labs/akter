import { defineRule } from "@oxlint/plugins"

import { FORBIDDEN_SEGMENTS, repoSourceSegments } from "../repo-paths.ts"

/** Forbids generic folder names such as `utils` or `shared` under the governed roots. */
export const noGenericDirectorySegmentRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow generic directory segments (core, shared, common, utils, helpers, lib, misc, domain, types, internal) under the governed tree. Folders are kebab-case nouns with one responsibility.",
    },
    messages: {
      genericSegment:
        "Directory '{{segment}}' is a banned generic segment in '{{path}}'. Name the folder for the one responsibility it owns.",
    },
  },
  create(context) {
    return {
      Program(node) {
        const segments = repoSourceSegments(context.filename)

        if (segments === null) return

        for (let index = 0; index < segments.length - 1; index++) {
          const segment = segments[index]

          if (segment === undefined || !FORBIDDEN_SEGMENTS.has(segment)) continue
          context.report({
            node,
            messageId: "genericSegment",
            data: { segment, path: segments.slice(0, -1).join("/") },
          })
        }
      },
    }
  },
})
