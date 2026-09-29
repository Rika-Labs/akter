import { BunCrypto, BunHttpServer } from "@effect/platform-bun"
import { Config, Crypto, Effect, Layer, ManagedRuntime, Option, Redacted, Schedule } from "effect"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { describeConformance, type ConformanceBackend } from "./conformance.ts"

const harness = ManagedRuntime.make(BunCrypto.layer)

afterAll(() => harness.dispose())

const createDatabase = Effect.fnUntraced(function* (
  crypto: Crypto.Crypto,
  admin: Pool,
  base: URL,
  prefix: string,
) {
  const name = `${prefix}_${(yield* crypto.randomUUIDv4.pipe(Effect.orDie)).replaceAll("-", "")}`
  yield* Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`))
  const database = new URL(base.href)
  database.pathname = `/${name}`

  return { name, url: database.href }
})

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

const backend: ConformanceBackend = {
  independentConnections: true,
  hasReplica: replicaUrl !== undefined,
  services: BunCrypto.layer,
  httpServer: Layer.orDie(BunHttpServer.layerServer({ hostname: "127.0.0.1", port: 0 })),
  open: () =>
    harness.runPromise(
      Effect.gen(function* () {
        const base = new URL(yield* Config.String("TEST_DATABASE_URL"))
        const crypto = yield* Crypto.Crypto
        const admin = new Pool({ connectionString: base.href })
        const created: Array<string> = []

        const provision = Effect.fnUntraced(function* (prefix: string) {
          const database = yield* createDatabase(crypto, admin, base, prefix)
          created.push(database.name)

          return Redacted.make(database.url)
        })

        const main = yield* provision("actors")

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

        // Databases created on the primary replicate, so the replica serves each under the same name.
        const onReplica = (database: Redacted.Redacted<string>) => {
          const url = new URL(replicaUrl!)
          url.pathname = new URL(Redacted.value(database)).pathname

          return Redacted.make(url.href)
        }

        const replica =
          replicaUrl === undefined
            ? undefined
            : {
                database: onReplica(main),
                connect: Effect.acquireRelease(
                  Effect.sync(
                    () => new Pool({ connectionString: Redacted.value(onReplica(main)) }),
                  ),
                  (pool) => Effect.promise(() => pool.end()),
                ).pipe(
                  Effect.map((pool) => ({
                    query: (statement: string, parameters?: ReadonlyArray<unknown>) =>
                      Effect.promise(() =>
                        pool.query(statement, parameters as Array<unknown> | undefined),
                      ).pipe(Effect.map((result) => result.rows as ReadonlyArray<unknown>)),
                  })),
                ),
              }

        // A template copy is a whole-database snapshot of a stopped deployment.
        // A disposed runtime's server sessions can outlive its pool briefly, and
        // Postgres refuses to copy a database with sessions.
        const copy = Effect.fnUntraced(function* (database: Redacted.Redacted<string>) {
          const source = new URL(Redacted.value(database)).pathname.slice(1)
          const name = `restored_${(yield* crypto.randomUUIDv4).replaceAll("-", "")}`

          yield* Effect.tryPromise(() =>
            admin.query(`CREATE DATABASE "${name}" TEMPLATE "${source}"`),
          ).pipe(Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") }))
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
          replica,
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
})
