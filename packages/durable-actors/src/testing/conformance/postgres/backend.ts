import { Config, Effect, Option } from "effect"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { type ConformanceGroup, conformanceGroups, describeConformance } from "../../conformance.ts"
import { postgresBackend } from "./database.ts"
import { shards } from "./shards.ts"

declare module "vitest" {
  interface ProvidedContext {
    /** A migrated database the run's main databases are copied from; absent outside the integration config. */
    readonly conformanceTemplate?: string
  }
}

const { replicaUrl, ci } = Effect.runSync(
  Effect.gen(function* () {
    return {
      replicaUrl: Option.getOrUndefined(
        Option.filter(
          yield* Config.option(Config.String("TEST_REPLICA_DATABASE_URL")),
          (url) => url !== "",
        ),
      ),
      ci: Option.isSome(yield* Config.option(Config.String("CI"))),
    }
  }),
)

if (ci && replicaUrl === undefined)
  throw new Error("TEST_REPLICA_DATABASE_URL must name a streaming replica in CI")

/**
 * Whether the server runs `wal_level=logical`, read once per worker. CI
 * enables it before the suite starts, so there a lower level is an error,
 * not a skip.
 */
const logicalDecoding = await Effect.runPromise(
  Effect.gen(function* () {
    const url = yield* Config.option(Config.String("TEST_DATABASE_URL"))

    if (Option.isNone(url)) return false

    const pool = new Pool({ connectionString: url.value, max: 1 })

    return yield* Effect.promise(() => pool.query<{ wal_level: string }>("SHOW wal_level")).pipe(
      Effect.map((result) => result.rows[0]?.wal_level === "logical"),
      Effect.ensuring(Effect.promise(() => pool.end())),
    )
  }),
)

if (ci && !logicalDecoding)
  throw new Error("CI's Postgres must run wal_level=logical for the fleet cases")

const backend = postgresBackend({
  url: Config.String("TEST_DATABASE_URL"),
  template: () => inject("conformanceTemplate"),
  replicaUrl,
  logicalDecoding,
})

/**
 * Runs the named conformance groups against real Postgres in this file's
 * worker. The database is this file's own: it is copied from the run's
 * migrated template when the integration config made one, else migrated fresh.
 */
export const describePostgres = (groups: ReadonlyArray<ConformanceGroup>) =>
  describeConformance({
    name: "Postgres durable turns",
    backend,
    registrar: {
      describe,
      it,
      beforeAll,
      afterAll,
      expect,
      skip: (name) => it.skip(name),
    },
    cases: groups.flatMap((group) => conformanceGroups[group]),
  })

const sharded = new Set<ConformanceGroup>(Object.values(shards).flat())

/** Every group no `shards` entry names, in registration order. */
export const unshardedGroups = (Object.keys(conformanceGroups) as Array<ConformanceGroup>).filter(
  (group) => !sharded.has(group),
)
