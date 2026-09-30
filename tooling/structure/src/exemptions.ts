/**
 * One sanctioned deviation from a structure rule; the entry fails as stale
 * once its path no longer violates `rule`.
 */
export interface Exemption {
  readonly path: string
  readonly rule:
    | "tests-beside-sources"
    | "index-not-entry"
    | "wildcard-exports"
    | "structure-rules"
    | "ledger-cases"
  readonly reason: string
}

/** Every deviation from the structure rules, each with the reason it exists. */
export const exemptions: ReadonlyArray<Exemption> = [
  {
    path: "tooling/oxlint/anti-slop",
    rule: "tests-beside-sources",
    reason:
      "Vendored rule corpus (see ANTI-SLOP-LICENSE) keeps upstream's layout: each rule's RuleTester file sits beside the rule, outside a src/ directory.",
  },
  {
    path: "research",
    rule: "structure-rules",
    reason:
      "Research archive: PascalCase actor files and typechecked sketches are evidence, not shipped code. Excluded from format and structure checks.",
  },
]
