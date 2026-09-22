import { BunCrypto } from "@effect/platform-bun"
import { Config, Crypto, Effect, ManagedRuntime, Redacted } from "effect"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { describeConformance, type ConformanceBackend } from "../conformance.ts"

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

const backend: ConformanceBackend = {
  independentConnections: true,
  services: BunCrypto.layer,
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

        return {
          database: main,
          freshDatabase: provision("isolated"),
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
