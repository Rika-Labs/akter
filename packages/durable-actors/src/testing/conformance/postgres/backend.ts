import { Config, Effect, Option } from "effect"
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

// A physical streaming replica of TEST_DATABASE_URL's server, when one is configured.
const { replicaUrl, ci } = Effect.runSync(
  Effect.gen(function* () {
    return {
      // check:ci passes an empty value when it started no replica.
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

// CI always provides one, so its read-your-writes evidence can't be skipped unnoticed.
if (ci && replicaUrl === undefined)
  throw new Error("TEST_REPLICA_DATABASE_URL must name a streaming replica in CI")

const backend = postgresBackend({
  url: Config.String("TEST_DATABASE_URL"),
  template: () => inject("conformanceTemplate"),
  replicaUrl,
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
