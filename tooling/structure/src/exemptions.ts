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
    path: "apps/api/src/deployment-stack.test.ts",
    rule: "tests-beside-sources",
    reason:
      "The Docker deployment E2E exercises the API, edge and runner image together rather than one source module.",
  },
  {
    path: "apps/api/src/caps-stack.test.ts",
    rule: "tests-beside-sources",
    reason:
      "The Compose usage-cap E2E exercises the API, edge and runner image together rather than one source module.",
  },
  {
    path: "apps/cli/src/hosted-stack.test.ts",
    rule: "tests-beside-sources",
    reason:
      "The Compose E2E exercises login, whoami, deploy and logout against the API, edge and runner image together rather than one source module.",
  },
  {
    path: "packages/akter/src/runtime/database/routing.test.ts",
    rule: "tests-beside-sources",
    reason:
      "Exercises turns, relays, jobs, cron, retention and holder liveness together on shard-targeted sessions, checking each committed write's session against the shard that holds its row, rather than one source module.",
  },
  {
    path: "infra/src/fly-service-image.test.ts",
    rule: "tests-beside-sources",
    reason:
      "It exercises the patched Alchemy Fly.Service image build that the console and the site share, which has no source module in this repository.",
  },
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
