import { BunCrypto, BunFileSystem } from "@effect/platform-bun"
import { PGlite } from "@electric-sql/pglite"
import { PgliteClient } from "@effect/sql-pglite"
import { Cause, Effect, Exit, FileSystem, Layer, ManagedRuntime, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Actor, Lifecycle, NotCreated } from "../index.ts"
import { migrate } from "../runtime/database/migrations.ts"
import { Database } from "../runtime/index.ts"
import { ActorTest } from "./actor-test.ts"
import { describeConformance, type ConformanceBackend } from "./conformance.ts"

const harness = ManagedRuntime.make(BunFileSystem.layer)

afterAll(() => harness.dispose())

// PGlite supplies a single serialized connection; independent-connection cases
// are reported skipped below and run on real Postgres instead.
const backend: ConformanceBackend = {
  independentConnections: false,
  services: BunCrypto.layer,
  open: () =>
    harness.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dataDir = yield* fs.makeTempDirectory({ prefix: "durable-actors-pglite-" })

        return {
          database: { dataDir },
          freshDatabase: Effect.succeed({}),
          close: fs.remove(dataDir, { recursive: true }).pipe(Effect.ignore),
        }
      }),
    ),
}

describeConformance({
  name: "PGlite durable turns",
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

describe("PGlite migrations", () => {
  it("owns a fresh database per layer build and closes both instances", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const layer = Database.pglite()

        const first = yield* Effect.acquireRelease(
          Effect.sync(() => ManagedRuntime.make(layer)),
          (runtime) => Effect.promise(() => runtime.dispose()),
        )

        const second = yield* Effect.acquireRelease(
          Effect.sync(() => ManagedRuntime.make(layer)),
          (runtime) => Effect.promise(() => runtime.dispose()),
        )

        const a = yield* Effect.promise(() => first.runPromise(PgliteClient.PgliteClient))
        const b = yield* Effect.promise(() => second.runPromise(PgliteClient.PgliteClient))
        expect(a.pglite).not.toBe(b.pglite)
        yield* Effect.promise(() => first.runPromise(a`CREATE TABLE isolated (value integer)`))
        expect(
          yield* Effect.promise(() =>
            second.runPromise(b`SELECT to_regclass('isolated')::text AS table_name`),
          ),
        ).toEqual([{ table_name: null }])
        yield* Effect.promise(() => first.dispose())
        yield* Effect.promise(() => second.dispose())
        expect(a.pglite.closed).toBe(true)
        expect(b.pglite.closed).toBe(true)
      }).pipe(Effect.scoped),
    ))
  it("leaves a borrowed client open and does not replace its query method", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const live = yield* Effect.acquireRelease(
          Effect.promise(() => PGlite.create()),
          (client) => Effect.promise(() => client.close()),
        )

        const query = Object.getOwnPropertyDescriptor(live, "query")

        const runtime = yield* Effect.acquireRelease(
          Effect.sync(() => ManagedRuntime.make(Database.pglite({ liveClient: live }))),
          (runtime) => Effect.promise(() => runtime.dispose()),
        )

        yield* Effect.promise(() =>
          runtime.runPromise(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              expect(yield* sql`SELECT 17 AS value`).toEqual([{ value: 17 }])
            }),
          ),
        )
        yield* Effect.promise(() => runtime.dispose())
        expect(Object.getOwnPropertyDescriptor(live, "query")).toEqual(query)
        expect(live.closed).toBe(false)
        expect((yield* Effect.promise(() => live.query("SELECT 19 AS value"))).rows).toEqual([
          { value: 19 },
        ])
      }).pipe(Effect.scoped),
    ))
  it("rolls back partial foundation DDL and safely reruns the migration", () => {
    const runtime = ManagedRuntime.make(Database.pglite())

    return runtime
      .runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`CREATE TABLE actor_state (collision boolean)`
          const failure = yield* migrate.pipe(Effect.exit)
          expect(Exit.isFailure(failure) && Cause.pretty(failure.cause)).toContain("actor_state")
          expect(
            yield* sql`SELECT to_regclass('actor_generations')::text AS generations, to_regclass('actor_deployment')::text AS deployment`,
          ).toEqual([{ generations: null, deployment: null }])
          expect(yield* sql`SELECT migration_id FROM actor_migrations`).toEqual([])
          yield* sql`DROP TABLE actor_state`
          yield* migrate
          expect(yield* sql`SELECT migration_id FROM actor_migrations`).toEqual([
            { migration_id: 1 },
            { migration_id: 2 },
          ])
          expect(yield* sql`SELECT count(*)::int AS receipts FROM actor_receipts`).toEqual([
            { receipts: 0 },
          ])
          expect(yield* migrate).toEqual([])
        }),
      )
      .finally(() => runtime.dispose())
  })
})

describe("creation policy adoption", () => {
  it("does not treat a pre-policy successful command as creation after restart", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const live = yield* Effect.acquireRelease(
          Effect.promise(() => PGlite.create()),
          (client) => Effect.promise(() => client.close()),
        )

        const Create = Actor.command("Create")
        const Read = Actor.command("Read", { output: Schema.Finite })

        const state = {
          count: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
        }

        const Before = Actor.make("AdoptCreation", {
          id: Schema.NonEmptyString,
          commands: [Create, Read],
          state,
        })

        const After = Actor.make("AdoptCreation", {
          id: Schema.NonEmptyString,
          commands: [Create, Read],
          state,
          lifecycle: [Lifecycle.createdBy(Create)],
        })

        const database = { liveClient: live }

        const first = yield* Effect.acquireRelease(
          Effect.sync(() =>
            ManagedRuntime.make(
              Before.toLayer({
                Create: () => Effect.void,
                Read: (ctx) => Effect.succeed(ctx.state.count),
              }).pipe(
                Layer.provideMerge(ActorTest.layer({ database })),
                Layer.provideMerge(BunCrypto.layer),
                Layer.orDie,
              ),
            ),
          ),
          (runtime) => Effect.promise(() => runtime.dispose()),
        )

        const tenant = yield* Effect.promise(() =>
          first.runPromise(
            Effect.gen(function* () {
              const test = yield* ActorTest
              const actor = yield* Before.get("existing")
              const sql = yield* SqlClient.SqlClient
              expect(yield* actor.Read()).toBe(0)
              expect(
                yield* sql`SELECT created FROM actor_generations
                  WHERE tenant_id = ${actor.ref.tenant} AND actor_type = ${actor.ref.actor} AND actor_id = ${actor.ref.id}`,
              ).toEqual([{ created: false }])

              return test.tenant
            }),
          ),
        )

        yield* Effect.promise(() => first.dispose())

        const second = yield* Effect.acquireRelease(
          Effect.sync(() =>
            ManagedRuntime.make(
              After.toLayer({
                Create: (ctx) => ctx.state.set({ count: 23 }),
                Read: (ctx) => Effect.succeed(ctx.state.count),
              }).pipe(
                Layer.provideMerge(ActorTest.layer({ database })),
                Layer.provideMerge(BunCrypto.layer),
                Layer.orDie,
              ),
            ),
          ),
          (runtime) => Effect.promise(() => runtime.dispose()),
        )

        yield* Effect.promise(() =>
          second.runPromise(
            Effect.gen(function* () {
              const actor = yield* After.get("existing", { tenant })
              expect(yield* actor.Read().pipe(Effect.flip)).toMatchObject({
                reason: NotCreated.make({}),
              })
              yield* actor.Create()
              expect(yield* actor.Read()).toBe(23)
            }),
          ),
        )
      }).pipe(Effect.scoped),
    ))
})
