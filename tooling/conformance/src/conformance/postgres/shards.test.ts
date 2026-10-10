import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import { conformanceGroups, type ConformanceGroup } from "../../conformance.ts"
import { groupsOf, shards, UNSHARDED, unshardedGroups } from "./shards.ts"

const workers = [...Object.keys(shards), UNSHARDED]

const Workflow = Schema.Struct({
  jobs: Schema.Struct({
    suites: Schema.Struct({
      strategy: Schema.Struct({
        matrix: Schema.Struct({ include: Schema.Array(Schema.Struct({ shards: Schema.String })) }),
      }),
    }),
  }),
})

describe("Postgres conformance shards", () => {
  it("runs every group in exactly one worker", () => {
    const named = workers.flatMap((worker) => groupsOf(worker))
    expect(new Set(named).size).toBe(named.length)
    expect([...named].sort()).toEqual(Object.keys(conformanceGroups).sort())
    expect(unshardedGroups.length > 0).toBe(true)
  })

  it("keeps every group with a replica case in one worker", () => {
    const replicaWorkers = workers.filter((worker) =>
      groupsOf(worker).some((group: ConformanceGroup) =>
        conformanceGroups[group].cases.some((conformanceCase) => conformanceCase.requiresReplica),
      ),
    )

    expect(replicaWorkers).toEqual(["replica"])
  })

  it("refuses a shard name the registry does not define", () => {
    expect(() => groupsOf("no-such-shard")).toThrow("Unknown conformance shard no-such-shard")
  })

  it("Verify executes every backend project once and retains units and failure drills", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const text = yield* Effect.promise(() =>
          Bun.file(new URL("../../../../../.github/workflows/ci.yml", import.meta.url)).text(),
        )
        const workflow = yield* Schema.decodeUnknownEffect(Workflow)(Bun.YAML.parse(text))
        const commands = workflow.jobs.suites.strategy.matrix.include.flatMap(({ shards }) =>
          shards.trim().split("\n"),
        )

        for (const kind of ["postgres", "node", "pglite"]) {
          const prefix = kind === "pglite" ? "pglite" : "postgres"
          const projects = [
            ...workers.map((worker) => `${prefix}:${worker}`),
            ...(kind === "postgres" ? ["integration"] : []),
          ]
          const selected = commands.flatMap((command) => {
            const [, commandKind, ...flags] = command.trim().split(/\s+/)
            if (commandKind !== kind) return []

            for (const flag of flags) expect(flag).toMatch(/^--project=!?[\w:-]+$/)
            const filters = flags.map((flag) => flag.slice("--project=".length))
            const included = filters.filter((filter) => !filter.startsWith("!"))
            const excluded = filters.flatMap((filter) =>
              filter.startsWith("!") ? [filter.slice(1)] : [],
            )

            for (const filter of [...included, ...excluded]) expect(projects).toContain(filter)

            return projects.filter(
              (project) =>
                !excluded.includes(project) &&
                (included.length === 0 || included.includes(project)),
            )
          })

          expect(selected.sort(), kind).toEqual([...projects].sort())
        }

        for (const kind of ["unit", "drills", "node-units"])
          expect(
            commands.filter((command) => command.trim().split(/\s+/)[1] === kind),
          ).toHaveLength(1)
      }),
    ))
})
