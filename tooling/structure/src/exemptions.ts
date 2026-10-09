/**
 * One sanctioned deviation from a structure rule; the entry fails as stale
 * once its path no longer violates `rule`.
 */
export interface Exemption {
  readonly path: string
  readonly rule: "tests-beside-sources" | "index-not-entry" | "wildcard-exports" | "structure-rules"
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
    path: "tooling/conformance/src/conformance/postgres/cold-garbage.test.ts",
    rule: "tests-beside-sources",
    reason:
      "Real-Postgres collector race scenarios share the cold-tier.ts actor/runtime fixture; separating them from admission scenarios avoids duplicating that fixture.",
  },
  {
    path: "tooling/conformance/src/conformance/postgres/cold-compatibility.test.ts",
    rule: "tests-beside-sources",
    reason:
      "Real-Postgres state-chain and stopped-snapshot restore scenarios share cold-tier.ts; they are lifecycle evidence, not a separate implementation module.",
  },
]
