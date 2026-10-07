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
    path: "packages/akter/src/runtime/database/routing.test.ts",
    rule: "tests-beside-sources",
    reason:
      "Exercises turns, relays, jobs, cron, retention and holder liveness together on shard-targeted sessions, checking each committed write's session against the shard that holds its row, rather than one source module.",
  },
  {
    path: "tooling/oxlint/anti-slop",
    rule: "tests-beside-sources",
    reason:
      "Vendored rule corpus (see ANTI-SLOP-LICENSE) keeps upstream's layout: each rule's RuleTester file sits beside the rule, outside a src/ directory.",
  },
]
