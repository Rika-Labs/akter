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
    path: "apps/cli/src/commands/storage/check.s3.test.ts",
    rule: "tests-beside-sources",
    reason:
      "The MinIO-backed half of check.test.ts: it needs TEST_S3_URL, so `test` excludes it and `test:integration` runs it.",
  },
  {
    path: "packages/akter/src/execution/ownership.test.ts",
    rule: "tests-beside-sources",
    reason:
      "The E2 ownership and failure matrix exercises the shared engine implementation without a separate ownership module.",
  },
  {
    path: "packages/akter/src/execution/cron.test.ts",
    rule: "tests-beside-sources",
    reason:
      "The E3 cron durability scenario exercises the engine and simulator; the parser's focused tests stay beside contract/cron.ts.",
  },
  {
    path: "packages/akter/src/testing/cluster.test.ts",
    rule: "tests-beside-sources",
    reason:
      "The E3 split-shard seed matrix exercises the shared simulator rather than a second cluster simulator implementation.",
  },
  {
    path: "packages/akter/src/runtime/cluster-process.test.ts",
    rule: "tests-beside-sources",
    reason:
      "The integration-only E3 process harness exercises sharding over MinIO; its runner fixtures live in unpublished conformance tooling.",
  },
]
