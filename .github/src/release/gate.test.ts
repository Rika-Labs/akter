import { Schema } from "effect"
import { expect, it } from "vitest"
import { releaseGate, requiredStatuses } from "./gate.ts"

const manifest = await Bun.file(
  `${import.meta.dirname}/../../../tooling/local-verify/manifest.json`,
).json()

const green = [
  { context: "verify", state: "success" },
  { context: "branch", state: "success" },
]

it("requires exactly the contexts the main ruleset and the local verification manifest name", () => {
  expect([...requiredStatuses]).toEqual(["verify", "branch"])
  expect(manifest.statuses.map((status: { context: string }) => status.context)).toEqual([
    ...requiredStatuses,
  ])
})

it("accepts a commit whose verify and branch statuses are both success, whatever else reported", () => {
  expect(() => releaseGate(green)).not.toThrow()
  expect(() =>
    releaseGate([
      { context: "ci/other", state: "failure" },
      { context: "branch", state: "success" },
      { context: "verify", state: "success" },
    ]),
  ).not.toThrow()
})

it("rejects a commit with no status at all, because an unverified commit is unknown, not passing", () => {
  expect(() => releaseGate([])).toThrow("No commit status verify on the tagged commit")
})

it("rejects a commit missing either required status and names the missing one", () => {
  expect(() => releaseGate([{ context: "verify", state: "success" }])).toThrow(
    "No commit status branch",
  )
  expect(() => releaseGate([{ context: "branch", state: "success" }])).toThrow(
    "No commit status verify",
  )
})

it("rejects every state that is not success, including a pending run and a lookalike context", () => {
  for (const state of ["failure", "error", "pending"])
    expect(() => releaseGate([{ context: "verify", state }, green[1]!])).toThrow(
      `Commit status verify is ${state}, not success`,
    )
  expect(() =>
    releaseGate([
      { context: "Verify", state: "success" },
      { context: "verify ", state: "success" },
      { context: "branch", state: "success" },
    ]),
  ).toThrow("No commit status verify")
})

it("lets only the newest status of a context decide, in the order the API lists them", () => {
  expect(() =>
    releaseGate([
      { context: "verify", state: "failure" },
      { context: "verify", state: "success" },
      green[1]!,
    ]),
  ).toThrow("Commit status verify is failure")
  expect(() =>
    releaseGate([
      { context: "verify", state: "success" },
      { context: "verify", state: "failure" },
      green[1]!,
    ]),
  ).not.toThrow()
})

const run = async (lines: string) => {
  const child = Bun.spawn(["bun", `${import.meta.dirname}/gate.ts`], {
    stdin: new Response(lines),
    stdout: "pipe",
    stderr: "pipe",
  })
  return { code: await child.exited, out: await new Response(child.stdout).text() }
}

it("the command exits 0 on newline-delimited statuses from the API and 1 on a red or empty list", async () => {
  const lines = (statuses: ReadonlyArray<{ context: string; state: string }>) =>
    statuses.map((status) => JSON.stringify(status)).join("\n")
  const accepted = await run(lines(green))
  expect(accepted.code).toBe(0)
  expect(accepted.out).toContain("verify=success, branch=success")
  expect((await run(lines([{ context: "verify", state: "failure" }, green[1]!]))).code).toBe(1)
  expect((await run("")).code).toBe(1)
})

const Workflow = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      permissions: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      steps: Schema.optional(
        Schema.Array(
          Schema.Struct({
            name: Schema.optional(Schema.String),
            uses: Schema.optional(Schema.String),
            run: Schema.optional(Schema.String),
          }),
        ),
      ),
    }),
  ),
})

const releaseText = await Bun.file(`${import.meta.dirname}/../../workflows/release.yml`).text()
const release = Schema.decodeUnknownSync(Workflow)(Bun.YAML.parse(releaseText))
const publish = release.jobs["publish"]

it("release.yml reads the verify and branch statuses of the tagged commit and no longer needs a ci.yml run", () => {
  const step = publish?.steps?.find((candidate) => candidate.run?.includes("gate.ts"))
  expect(step?.name).toBe("Require the verify and branch commit statuses for the tagged commit")
  expect(step?.run).toContain('commit="$(git rev-parse HEAD)"')
  expect(step?.run).toContain("/commits/${commit}/statuses")
  expect(step?.run).toContain("set -euo pipefail")
  expect(publish?.permissions?.["statuses"]).toBe("read")
  expect(releaseText).not.toContain("ci.yml")
  expect(releaseText).not.toContain("actions/workflows")
})

it("release.yml pins every action to a full commit SHA and restores no cache in the job that publishes", () => {
  const uses = Object.values(release.jobs).flatMap((job) =>
    (job.steps ?? []).flatMap((step) => (step.uses === undefined ? [] : [step.uses])),
  )
  expect(uses.length).toBeGreaterThan(3)
  for (const action of uses) expect(action).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/)
  expect(uses.filter((action) => action.startsWith("actions/cache"))).toEqual([])
})

it("release.yml publishes only the commit the tag names and only from main", () => {
  const step = publish?.steps?.find((candidate) =>
    candidate.name?.startsWith("Check the tag names"),
  )
  expect(step?.run).toContain('test "$(git rev-parse HEAD)" = "$commit"')
  expect(step?.run).toContain('git merge-base --is-ancestor "$commit" origin/main')
  expect(step?.run).toContain('test "$RELEASE_TAG" = "v$version"')
})
