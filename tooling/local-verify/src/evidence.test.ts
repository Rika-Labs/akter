import { expect, it } from "vitest"
import { combineEvidence } from "./evidence.ts"
import type { CheckResult } from "./verdict.ts"

const result = (outcome: "pass" | "fail", logs: string): CheckResult => ({
  result: outcome,
  seconds: 1,
  logs,
  where: "host",
})
const sha = "a".repeat(40)
const summary = (results: Record<string, CheckResult>, extra = {}) => ({
  sha,
  toolDigest: "t1",
  cached: false,
  results,
  ...extra,
})

it("completes a run with checks that earlier runs of the same commit, manifest and tooling passed", () => {
  const combined = combineEvidence([summary({ static: result("pass", "/run/1") })], sha, "t1", {
    pack: result("pass", "/run/2"),
  })
  expect(Object.keys(combined).sort()).toEqual(["pack", "static"])
})

it("drops evidence from another commit, even one that shares a twelve character prefix", () => {
  const other = `${"a".repeat(12)}${"b".repeat(28)}`
  const combined = combineEvidence(
    [summary({ static: result("pass", "/run/1") }, { sha: other })],
    sha,
    "t1",
    {},
  )
  expect(combined).toEqual({})
})

it("drops evidence produced by a different manifest or tooling, or recorded without a digest", () => {
  const combined = combineEvidence(
    [
      summary({ static: result("pass", "/run/1") }, { toolDigest: "t0" }),
      summary({ pack: result("pass", "/run/1") }, { toolDigest: undefined }),
    ],
    sha,
    "t1",
    {},
  )
  expect(combined).toEqual({})
})

it("lets the newest result of a check replace an older one, red over green and green over red", () => {
  const redAfterGreen = combineEvidence(
    [summary({ static: result("pass", "/run/1") })],
    sha,
    "t1",
    { static: result("fail", "/run/2") },
  )
  expect(redAfterGreen["static"]?.result).toBe("fail")
  const greenAfterRed = combineEvidence(
    [summary({ static: result("fail", "/run/1") }), summary({ static: result("pass", "/run/2") })],
    sha,
    "t1",
    {},
  )
  expect(greenAfterRed["static"]?.logs).toBe("/run/2")
})

it("never completes a sign-off with a run that allowed Turbo to replay results, or that did not record whether it did", () => {
  const combined = combineEvidence(
    [
      summary({ static: result("pass", "/run/1") }, { cached: true }),
      summary({ pack: result("pass", "/run/1") }, { cached: undefined }),
    ],
    sha,
    "t1",
    {},
  )
  expect(combined).toEqual({})
})
