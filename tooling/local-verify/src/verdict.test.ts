import { expect, it } from "vitest"
import { parseManifest as parseJson, type ManifestInput } from "./manifest.ts"

const parseManifest = (value: ManifestInput) => parseJson(JSON.stringify(value))
import { decide, type CheckResult } from "./verdict.ts"

const manifest = parseManifest({
  repository: "Rika-Labs/akter",
  trustedAuthors: ["maintainer"],
  setup: { name: "setup", run: "true", timeoutMinutes: 5 },
  checks: ["static", "cloud", "e2e", "stacks", "branch"].map((id) => ({
    id,
    description: `${id} check`,
    timeoutMinutes: 5,
    steps: [{ name: id, run: "true" }],
  })),
  statuses: [
    { context: "verify", checks: ["static", "cloud", "e2e", "stacks"] },
    { context: "branch", checks: ["branch"] },
  ],
  suites: [],
})

const pass = (seconds = 3): CheckResult => ({
  result: "pass",
  seconds,
  logs: "/logs",
  where: "host",
})
const everything = {
  static: pass(),
  cloud: pass(),
  e2e: pass(),
  stacks: pass(),
  branch: pass(),
}

it("signs off only when every required check passed", () => {
  const verdict = decide(manifest, everything)
  expect(verdict.signedOff).toBe(true)
  expect(verdict.statuses.map(({ context, state }) => [context, state])).toEqual([
    ["verify", "success"],
    ["branch", "success"],
  ])
})

it("treats a check that never ran as missing and fails its status instead of passing it", () => {
  const { e2e: _skipped, ...partial } = everything
  const verdict = decide(manifest, partial)
  expect(verdict.signedOff).toBe(false)
  expect(verdict.checks.find(({ id }) => id === "e2e")?.outcome).toBe("missing")
  const verify = verdict.statuses.find(({ context }) => context === "verify")
  expect(verify?.state).toBe("failure")
  expect(verify?.description).toContain("e2e missing")
  expect(verdict.statuses.find(({ context }) => context === "branch")?.state).toBe("success")
})

it("fails verify on one failed check among passing ones and names it, without failing the unrelated branch status", () => {
  const verdict = decide(manifest, {
    ...everything,
    cloud: { result: "fail", seconds: 9, failedStep: "Cloud tests", logs: "/logs", where: "host" },
  })
  expect(verdict.signedOff).toBe(false)
  const verify = verdict.statuses.find(({ context }) => context === "verify")
  expect(verify).toMatchObject({ state: "failure" })
  expect(verify?.description).toContain("cloud fail")
  expect(verify?.description).not.toContain("static")
  expect(verdict.statuses.find(({ context }) => context === "branch")?.state).toBe("success")
})

it("fails every status and signs nothing off when no check ran", () => {
  const verdict = decide(manifest, {})
  expect(verdict.signedOff).toBe(false)
  expect(verdict.statuses.every(({ state }) => state === "failure")).toBe(true)
})

it("keeps a status description within GitHub's 140 character limit", () => {
  const long = parseManifest({
    ...manifest,
    checks: [{ ...manifest.checks[0]!, id: "x".repeat(200) }],
    statuses: [{ context: "verify", checks: ["x".repeat(200)] }],
  })
  expect(decide(long, {}).statuses[0]?.description.length).toBeLessThanOrEqual(140)
})
