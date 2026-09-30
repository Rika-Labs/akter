import { describe, expect, it } from "vitest"

import { ledgerCaseNames, unknownLedgerCases } from "./ledger.ts"

const source = (text: string) => ({
  path: "packages/durable-actors/src/testing/conformance/events.ts",
  text,
})

describe("ledgerCaseNames", () => {
  it("reads sentence-like code spans and skips identifiers, paths, and commands", () => {
    expect(
      ledgerCaseNames(
        [
          "- `replays a receipt after the owner dies` — gate **Crash points**",
          "Run `bun run --filter durable-actors test` in `conformance/events.ts` with `ActorTest.cluster`.",
          "`too short name` and `durable workflows check exits 1 when blocked`",
        ].join("\n"),
      ),
    ).toEqual([
      "replays a receipt after the owner dies",
      "durable workflows check exits 1 when blocked",
    ])
  })
})

describe("unknownLedgerCases", () => {
  it("matches exact names, suite-prefixed names, and template expansions", () => {
    expect(
      unknownLedgerCases({
        ledger: [
          "`replays a receipt after the owner dies`",
          "`commits each event once across a relay kill`",
          "`recovers beforeCommit crashes with one committed transition`",
          "`shows increments, and a second tab sees them live`",
        ].join("\n"),
        files: [
          source(`const a = { name: "replays a receipt after the owner dies" }`),
          source(`const b = { name: "events: commits each event once across a relay kill" }`),
          source("const c = `recovers ${point} crashes with one committed transition`"),
          {
            path: "apps/e2e/counter.e2e.ts",
            text: "test(`${flavor}: shows increments, and a second tab sees them live`)",
          },
        ],
      }),
    ).toEqual([])
  })

  it("reports a renamed case, and ignores docs, other roots, and templates too loose to prove a name", () => {
    expect(
      unknownLedgerCases({
        ledger: "`replays a receipt after the owner dies`\n`an entirely missing case name`",
        files: [
          source(`const a = { name: "replays a receipt after its owner dies" }`),
          source("const b = `${prefix} ${suffix}`"),
          { path: "docs/verification/01-conformance.md", text: '"an entirely missing case name"' },
          { path: "research/spike.ts", text: '"an entirely missing case name"' },
        ],
      }),
    ).toEqual(["replays a receipt after the owner dies", "an entirely missing case name"])
  })
})
