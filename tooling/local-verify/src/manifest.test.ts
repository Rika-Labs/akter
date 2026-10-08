import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
import {
  shards,
  UNSHARDED,
} from "../../../packages/akter/src/testing/conformance/postgres/shards.ts"
import { parseManifest as parseJson, type ManifestInput } from "./manifest.ts"

const parseManifest = (value: ManifestInput) => parseJson(JSON.stringify(value))

const check = (id: string) => ({
  id,
  description: id,
  timeoutMinutes: 5,
  steps: [{ name: id, run: "true" }],
})

const valid = {
  repository: "Rika-Labs/akter",
  trustedAuthors: ["maintainer"],
  setup: { name: "setup", run: "true", timeoutMinutes: 5 },
  checks: [check("a"), check("b")],
  statuses: [
    { context: "verify", checks: ["a"] },
    { context: "branch", checks: ["b"] },
  ],
  suites: [],
}

it("accepts a manifest in which exactly one status requires each check", () => {
  expect(parseManifest(valid).checks.map(({ id }) => id)).toEqual(["a", "b"])
})

it("rejects a check that no status requires, because it could never block a merge", () => {
  expect(() => parseManifest({ ...valid, checks: [...valid.checks, check("c")] })).toThrow(
    "check c must be required by exactly one status, found 0",
  )
})

it("rejects a status that requires an unknown check, because it would be green with nothing run", () => {
  expect(() =>
    parseManifest({
      ...valid,
      statuses: [...valid.statuses, { context: "extra", checks: ["ghost"] }],
    }),
  ).toThrow("a status requires unknown check ghost")
})

it("rejects a check required by two statuses, duplicate ids and a check without steps", () => {
  expect(() =>
    parseManifest({
      ...valid,
      statuses: [
        { context: "verify", checks: ["a", "b"] },
        { context: "branch", checks: ["b"] },
      ],
    }),
  ).toThrow("check b must be required by exactly one status, found 2")
  expect(() => parseManifest({ ...valid, checks: [check("a"), check("a")] })).toThrow(
    "check and suite ids must be unique",
  )
  expect(() =>
    parseManifest({ ...valid, checks: [{ ...check("a"), steps: [] }, check("b")] }),
  ).toThrow("a has no steps")
})

it("keeps an optional suite out of the required set: it needs no status and cannot reuse a check id", () => {
  const withSuite = { ...valid, suites: [{ ...check("soak"), cadence: "nightly" }] }
  expect(parseManifest(withSuite).suites.map(({ id }) => id)).toEqual(["soak"])
  expect(() =>
    parseManifest({ ...valid, suites: [{ ...check("a"), cadence: "nightly" }] }),
  ).toThrow("check and suite ids must be unique")
})

it("refuses a check that runs from the tool checkout yet asks for services or the host Docker daemon", () => {
  expect(() =>
    parseManifest({
      ...valid,
      checks: [{ ...check("a"), runIn: "tool", needsDocker: true }, check("b")],
    }),
  ).toThrow("a runs in the tool checkout and cannot use services or Docker")
})

const manifest = parseJson(readFileSync(`${import.meta.dirname}/../manifest.json`, "utf8"))
const commands = (id: string) =>
  manifest.checks.find((candidate) => candidate.id === id)?.steps.map(({ run }) => run) ?? []
const projects = (run: string) =>
  [...run.matchAll(/--project='?(!?[a-z:-]+)'?/g)].map((found) => found[1] ?? "")

it("keeps the checked-in manifest on the two contexts the main ruleset requires", () => {
  expect(manifest.statuses.map(({ context }) => context)).toEqual(["verify", "branch"])
  expect(manifest.statuses.find(({ context }) => context === "branch")?.checks).toEqual(["branch"])
})

it("requires every job and policy check the deleted Verify, Trusted policy and Evidence gate workflows ran", () => {
  const verify = manifest.statuses.find(({ context }) => context === "verify")?.checks
  expect(verify).toEqual([
    "self-host",
    "static",
    "pack",
    "workspaces",
    "framework-unit",
    "framework-pglite",
    "framework-postgres",
    "framework-migrations",
    "framework-drills",
    "node-postgres",
    "sandbox",
  ])
  const all = manifest.checks.flatMap(({ steps }) => steps.map(({ run }) => run))
  for (const required of [
    "apps/self-host/verify.sh",
    "bun run check:static",
    "turbo run lint lint:root typecheck",
    "bun run check:pack",
    "--filter='!@rikalabs/akter'",
    "test:integration",
    "--exclude '**/conformance/pglite/backend.test.ts'",
    "test:integration:drills",
    "test:node:conformance",
    "test:node:units",
    "check-branch.ts",
    "merge-base --is-ancestor",
  ])
    expect(
      all.some((run) => run.includes(required)),
      required,
    ).toBe(true)
})

it("runs the same Postgres conformance project groups as the matrix of the deleted Verify workflow", () => {
  const named = (id: string) =>
    commands(id)
      .map(projects)
      .filter((group) => group.length > 0 && group.every((name) => !name.startsWith("!")))
  expect(named("framework-pglite")).toEqual([
    ["pglite:conformance", "pglite:workflows", "pglite:cron"],
    ["pglite:properties", "pglite:capacity", "pglite:transports"],
  ])
  expect(named("framework-postgres")).toEqual([
    ["postgres:effect-control", "postgres:heap"],
    ["postgres:conformance", "postgres:capacity"],
    ["postgres:fleet", "postgres:multi-runner", "postgres:drain", "postgres:cron"],
    ["integration"],
    ["postgres:relay"],
    [
      "postgres:replica",
      "postgres:properties",
      "postgres:subscriptions",
      "postgres:transports",
      "postgres:connections",
    ],
    ["postgres:simulation", "postgres:workflows"],
  ])
  expect(named("framework-migrations")).toEqual([["integration:migrations"]])
  expect(named("node-postgres")).toEqual([
    ["postgres:effect-control", "postgres:heap"],
    ["postgres:conformance", "postgres:capacity"],
    ["postgres:fleet", "postgres:multi-runner", "postgres:drain", "postgres:cron"],
    [
      "postgres:replica",
      "postgres:properties",
      "postgres:subscriptions",
      "postgres:transports",
      "postgres:connections",
    ],
    ["postgres:simulation", "postgres:workflows"],
    ["postgres:relay"],
  ])
})

it("ends each project family with a group that excludes exactly the projects the earlier groups name", () => {
  const rest = (id: string) =>
    commands(id)
      .map(projects)
      .filter((group) => group.length > 0 && group.every((name) => name.startsWith("!")))
  const explicit = (id: string) =>
    commands(id)
      .map(projects)
      .filter((group) => group.length > 0 && group.every((name) => !name.startsWith("!")))
      .flat()
  expect(
    rest("framework-pglite")[0]
      ?.map((name) => name.slice(1))
      .sort(),
  ).toEqual(explicit("framework-pglite").sort())
  const postgresRest = (rest("framework-postgres")[0] ?? []).map((name) => name.slice(1)).sort()
  expect(postgresRest).toEqual([...explicit("framework-postgres"), "integration:migrations"].sort())
  const nodeRest = (rest("node-postgres")[0] ?? []).map((name) => name.slice(1)).sort()
  expect(nodeRest).toEqual([...explicit("node-postgres")].sort())
})

it("serves every check that needs a Postgres server from the pinned 18.6 image, with a replica where the old job started one", () => {
  const servers = manifest.checks.flatMap((candidate) =>
    candidate.postgres === undefined
      ? []
      : [[candidate.id, candidate.postgres.image, candidate.postgres.replica === true] as const],
  )
  expect(servers).toEqual([
    ["workspaces", "postgres:18.6", true],
    ["framework-postgres", "postgres:18.6", true],
    ["framework-migrations", "postgres:18.6", false],
    ["framework-drills", "postgres:18.6", false],
    ["node-postgres", "postgres:18.6", true],
  ])
})

it("keeps scheduled soak, stress and property runs as optional suites with a stated cadence", () => {
  expect(manifest.suites.map(({ id }) => id)).toEqual(["properties", "simulation", "stress"])
  for (const suite of manifest.suites) expect(suite.cadence).toContain("nightly")
})

it("runs the policy check from the trusted tool checkout and the isolation canary on the host", () => {
  for (const id of ["branch", "sandbox"])
    expect(manifest.checks.find((candidate) => candidate.id === id)?.runIn).toBe("tool")
  expect(manifest.checks.filter(({ needsDocker }) => needsDocker).map(({ id }) => id)).toEqual([
    "self-host",
    "framework-drills",
  ])
})

it("names only Postgres and PGlite projects that the framework's shard registry defines", () => {
  const known = new Set([
    ...Object.keys(shards),
    UNSHARDED,
    "integration",
    "integration:migrations",
  ])
  const named = ["framework-pglite", "framework-postgres", "framework-migrations", "node-postgres"]
    .flatMap(commands)
    .flatMap(projects)
    .map((name) => name.replace(/^!/, "").replace(/^(pglite|postgres):/, ""))
  expect(named.length).toBeGreaterThan(40)
  expect(named.filter((name) => !known.has(name))).toEqual([])
})

it("requires a pull request head to contain a freshly fetched main tip, with no case for stacked pull requests", () => {
  const steps = manifest.checks.find((candidate) => candidate.id === "branch")?.steps ?? []
  const contains = steps.find((step) => step.name === "Head contains the current main tip")
  expect(contains?.run).toContain("git fetch -q origin +refs/heads/main:refs/remotes/origin/main")
  expect(contains?.run).toContain('merge-base --is-ancestor refs/remotes/origin/main "$VERIFY_SHA"')
  expect(contains?.run).not.toContain("VERIFY_BASE")
})
