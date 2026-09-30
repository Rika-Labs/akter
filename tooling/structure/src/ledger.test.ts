import { describe, expect, it } from "vitest"

import { ledgerCaseNames, unknownLedgerCases } from "./ledger.ts"

const source = (
  text: string,
  path = "packages/durable-actors/src/testing/conformance/crash/turns/main.test.ts",
) => ({
  path,
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
  it("matches registered cases exactly or without their suite prefix", () => {
    expect(
      unknownLedgerCases({
        ledger: [
          "`replays a receipt after the owner dies`",
          "`restores tenant and onBehalfOf on resume elsewhere`",
          "`stores the current payload version with each emitted event`",
        ].join("\n"),
        files: [],
        registered: [
          "replays a receipt after the owner dies",
          "workflows: restores tenant and onBehalfOf on resume elsewhere",
          "payload migrations: stores the current payload version with each emitted event",
        ],
      }),
    ).toEqual([])
  })

  it("matches test-file literals, suite-prefixed literals, and loop-built test names", () => {
    expect(
      unknownLedgerCases({
        ledger: [
          "`recovers beforeCommit crashes with one committed transition`",
          "`commits each event once across a relay kill`",
          "`shows increments, and a second tab sees them live`",
        ].join("\n"),
        files: [
          source("it(`recovers ${point} crashes with one committed transition`, () => run(point))"),
          source(`it("events: commits each event once across a relay kill", body)`),
          {
            path: "apps/e2e/counter.e2e.ts",
            text: "test(`${flavor}: shows increments, and a second tab sees them live`)",
          },
        ],
        registered: [],
      }),
    ).toEqual([])
  })

  it("reports a renamed case, and a name only a non-test source, the docs, or a loose template holds", () => {
    expect(
      unknownLedgerCases({
        ledger: [
          "`replays a receipt after the owner dies`",
          "`placement differs from the deployment`",
          "`an entirely missing case name`",
          "`ends with a declared suffix only`",
        ].join("\n"),
        files: [
          source(`it("replays a receipt after its owner dies", body)`),
          source(
            `throw new Error("placement differs from the deployment")`,
            "packages/durable-actors/src/runtime/placement.ts",
          ),
          { path: "docs/verification/01-conformance.md", text: '"an entirely missing case name"' },
          source("it(`${prefix} ${suffix}`, body)"),
          source(`it("something that ends with a declared suffix only", body)`),
        ],
        registered: ["replays a receipt after the owner died"],
      }),
    ).toEqual([
      "replays a receipt after the owner dies",
      "placement differs from the deployment",
      "an entirely missing case name",
      "ends with a declared suffix only",
    ])
  })

  it("reads the evidence index when no registry is given, so the shipped ledgers cite real cases", () => {
    expect(
      unknownLedgerCases({
        ledger:
          "`commits state and receipt, replays an identical command effect, and keeps its generation`",
        files: [],
      }),
    ).toEqual([])
  })
})
