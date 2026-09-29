import { BunCrypto, BunHttpServer } from "@effect/platform-bun"
import { Config, Crypto, Effect, Layer, ManagedRuntime, Redacted, Schedule } from "effect"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import {
  type ConformanceBackend,
  type ConformanceGroup,
  conformanceGroups,
  describeConformance,
} from "../../conformance.ts"
import { shards } from "./shards.ts"

declare module "vitest" {
  interface ProvidedContext {
    /** A migrated database the run's main databases are copied from; absent outside the integration config. */
    readonly conformanceTemplate?: string
  }
}

const harness = ManagedRuntime.make(BunCrypto.layer)

afterAll(() => harness.dispose())

// A copy is refused while a session is still open on its source, and the
// server ends a closed pool's sessions a moment after the client has.
const copyDatabase = (admin: Pool, name: string, template: string) =>
  Effect.tryPromise(() => admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`)).pipe(
    Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") }),
  )

const createDatabase = Effect.fnUntraced(function* (
  crypto: Crypto.Crypto,
  admin: Pool,
  base: URL,
  prefix: string,
  template?: string,
) {
  const name = `${prefix}_${(yield* crypto.randomUUIDv4.pipe(Effect.orDie)).replaceAll("-", "")}`

  if (template === undefined) yield* Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`))
  else yield* copyDatabase(admin, name, template).pipe(Effect.orDie)
  const database = new URL(base.href)
  database.pathname = `/${name}`

  return { name, url: database.href }
})

const backend: ConformanceBackend = {
  independentConnections: true,
  services: BunCrypto.layer,
  httpServer: Layer.orDie(BunHttpServer.layerServer({ hostname: "127.0.0.1", port: 0 })),
  open: () =>
    harness.runPromise(
      Effect.gen(function* () {
        const base = new URL(yield* Config.String("TEST_DATABASE_URL"))
        const crypto = yield* Crypto.Crypto
        const admin = new Pool({ connectionString: base.href })
        const created: Array<string> = []

        const provision = Effect.fnUntraced(function* (prefix: string, template?: string) {
          const database = yield* createDatabase(crypto, admin, base, prefix, template)
          created.push(database.name)

          return Redacted.make(database.url)
        })

        const main = yield* provision("actors", inject("conformanceTemplate"))

        const connect = Effect.acquireRelease(
          Effect.sync(() => new Pool({ connectionString: Redacted.value(main) })),
          (pool) => Effect.promise(() => pool.end()),
        ).pipe(
          Effect.andThen((pool) =>
            Effect.acquireRelease(
              Effect.promise(() => pool.connect()),
              (client) =>
                Effect.promise(() => client.query("ROLLBACK")).pipe(
                  Effect.andThen(Effect.sync(() => client.release())),
                ),
            ),
          ),
          Effect.map((client) => ({
            query: (statement: string, parameters?: ReadonlyArray<unknown>) =>
              Effect.promise(() =>
                client.query(statement, parameters as Array<unknown> | undefined),
              ).pipe(Effect.map((result) => result.rows as ReadonlyArray<unknown>)),
          })),
        )

        // A template copy is a whole-database snapshot of a stopped deployment.
        // A disposed runtime's server sessions can outlive its pool briefly, and
        // Postgres refuses to copy a database with sessions.
        const copy = Effect.fnUntraced(function* (database: Redacted.Redacted<string>) {
          const source = new URL(Redacted.value(database)).pathname.slice(1)
          const name = `restored_${(yield* crypto.randomUUIDv4).replaceAll("-", "")}`

          yield* copyDatabase(admin, name, source)
          created.push(name)
          const url = new URL(base.href)
          url.pathname = `/${name}`

          return Redacted.make(url.href)
        }, Effect.orDie)

        return {
          database: main,
          freshDatabase: provision("isolated"),
          copy: (database) =>
            Redacted.isRedacted(database)
              ? copy(database)
              : Effect.die(new Error("The Postgres backend copies only Postgres databases")),
          connect,
          close: Effect.gen(function* () {
            for (const name of created)
              yield* Effect.promise(() =>
                admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
              )
            yield* Effect.promise(() => admin.end())
          }),
        }
      }),
    ),
}

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
