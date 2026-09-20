import { Rule } from "@rikalabs/proof"

export default [
  Rule.noul({
    id: "responsibility-naming",
    statement:
      "Standalone exported functions must identify their specific operation, not merely say that work happens. A generic action name for a specific conversion, calculation, parser, or formatter is a violation: the caller should not need to inspect its body or parameter names to discover its purpose. A descriptive filename does not repair an uninformative standalone function name. Domain-scoped methods, framework-required entrypoints, local callbacks, and established mathematical names may keep their conventional names. Evaluate existing code, not only added lines.",
    severity: "request-changes",
    threshold: 0.85,
    examples: {
      violate: ["export function handle(text: string) { return text.replace(/<[^>]*>/g, '') }"],
      clean: [
        "export function stripHtmlTags(text: string) { return text.replace(/<[^>]*>/g, '') }",
        "export const tool = { name: 'strip_html', execute(input: { text: string }) { return stripHtmlTags(input.text) } }",
      ],
    },
  }),
  Rule.noul({
    id: "module-cohesion",
    statement:
      "A source module must not implement unrelated domain responsibilities in the same file. Independent operations from different domains belong in different modules, even when each function has a good name. Related operations serving one capability belong together. Wiring several capabilities in an application entrypoint, re-exporting a package API, and testing several cases are not unrelated implementations. Judge only the supplied code; do not assume unseen code is missing. This applies to existing file contents, not only added lines.",
    severity: "request-changes",
    threshold: 0.85,
    examples: {
      violate: [
        "export function shippingCost(weight: number) { return weight * 2 }\nexport function markdownHeading(text: string) { return '# ' + text }",
      ],
      clean: [
        "export function shippingCost(weight: number) { return weight * 2 }\nexport function shippingCostWithInsurance(weight: number, value: number) { return shippingCost(weight) + value * 0.01 }",
        "export { Shipping } from './shipping'\nexport { Markdown } from './markdown'",
      ],
    },
  }),
  Rule.noul({
    id: "valuable-comments",
    statement:
      "Code must not contain comments that merely repeat what the adjacent code explicitly says. Narrating an assignment, function call, loop, return, or deletion without explaining why is a violation. Decorative section labels, self-praise, and abandoned commented-out implementations are also violations. Keep comments explaining non-obvious reasons, constraints, units, security requirements, or workarounds. License notices, functional tool directives, prose documents, and comment text inside string literals are not violations. Evaluate comments anywhere in the supplied file contents; no added-line marker is required.",
    severity: "request-changes",
    threshold: 0.85,
    examples: {
      violate: [
        "// Increment the counter\ncount++",
        "// This elegant helper provides a robust, seamless implementation.\nreturn user.id",
        "// Old implementation:\n// return fetchAllUsers()",
      ],
      clean: [
        "// Sign the original bytes: parsing and re-encoding changes the provider's signature.\nverifySignature(rawBody)",
        "// Keep the old key until all sessions signed before rotation expire.\nkeys.retain(previousKey)",
        "/** Returns the byte offset, not a Unicode character index. */\nexport function offset() {}",
      ],
    },
  }),
]
