import { BunCrypto, BunHttpServer, BunFileSystem } from "@effect/platform-bun"
import { PGlite } from "@electric-sql/pglite"
import { PgliteClient } from "@effect/sql-pglite"
import { Cause, Effect, Exit, FileSystem, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { pgTable, text } from "drizzle-orm/pg-core"
import { Migrator, SqlClient } from "effect/unstable/sql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Actor, NotCreated } from "../../index.ts"
import { migrate, migrations, migrator } from "./migrations.ts"
import { Database } from "../index.ts"
import { orderCapped } from "../turn/outbox.ts"
import { ActorRef } from "../../identity/caller.ts"
import { ActorTest } from "../../testing/actor-test.ts"
import type { InternalActors } from "../../handles/actors.ts"
import { describeConformance, type ConformanceBackend } from "../../testing/conformance.ts"

const harness = ManagedRuntime.make(BunFileSystem.layer)

afterAll(() => harness.dispose())

const backend: ConformanceBackend = {
  independentConnections: false,
  services: BunCrypto.layer,
  httpServer: Layer.orDie(BunHttpServer.layerServer({ hostname: "127.0.0.1", port: 0 })),
  open: () =>
    harness.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dataDir = yield* fs.makeTempDirectory({ prefix: "durable-actors-pglite-" })
        const copies: Array<string> = []

        return {
          database: { dataDir },
          freshDatabase: Effect.succeed({}),
          copy: (database) =>
            Effect.gen(function* () {
              if (
                Redacted.isRedacted(database) ||
                !("dataDir" in database) ||
                database.dataDir === undefined
              )
                return yield* Effect.die(new Error("Only a file-backed PGlite database is copied"))

              const copied = yield* fs.makeTempDirectory({ prefix: "durable-actors-restored-" })
              copies.push(copied)
              yield* fs.copy(database.dataDir, `${copied}/data`)

              return { dataDir: `${copied}/data` }
            }).pipe(Effect.orDie),
          close: Effect.suspend(() =>
            Effect.forEach([dataDir, ...copies], (path) =>
              fs.remove(path, { recursive: true }).pipe(Effect.ignore),
            ),
          ),
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
  it("refuses to start when a registered migration below the latest applied one was skipped", () => {
    const runtime = ManagedRuntime.make(Database.pglite())

    const throughRelay = migrator(
      Object.fromEntries(Object.entries(migrations).filter(([id]) => id < "0012")),
    )

    return runtime
      .runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* throughRelay
          yield* sql`INSERT INTO actor_migrations (migration_id, name) VALUES (13, 'inspection_views')`
          const before = yield* sql`SELECT migration_id FROM actor_migrations ORDER BY migration_id`
          const exit = yield* Effect.exit(migrate)
          expect(Exit.isFailure(exit)).toBe(true)
          const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
          expect(error).toBeInstanceOf(Migrator.MigrationError)
          expect(error).toMatchObject({
            kind: "BadState",
            message: expect.stringContaining(
              "Migrations 12 were never applied but migration 13 was",
            ),
          })
          expect(
            yield* sql`SELECT migration_id FROM actor_migrations ORDER BY migration_id`,
          ).toEqual(before)
        }),
      )
      .finally(() => runtime.dispose())
  })

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
            { migration_id: 3 },
            { migration_id: 4 },
            { migration_id: 5 },
            { migration_id: 6 },
            { migration_id: 8 },
            { migration_id: 9 },
            { migration_id: 10 },
            { migration_id: 11 },
            { migration_id: 12 },
            { migration_id: 13 },
            { migration_id: 14 },
            { migration_id: 15 },
            { migration_id: 16 },
            { migration_id: 17 },
            { migration_id: 18 },
            { migration_id: 20 },
            { migration_id: 21 },
            { migration_id: 22 },
            { migration_id: 23 },
            { migration_id: 25 },
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

const sender = ActorRef.make({ tenant: "t", actor: "Sender", id: "s" })

interface Row {
  readonly id: string
  readonly command?: string
  readonly due: number
  readonly scheduled: number
  readonly ready: number
  readonly running?: boolean
}

const insert = (rows: ReadonlyArray<Row>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    yield* sql`INSERT INTO actor_outbox ${sql.insert(
      rows.map((row) => ({
        routing_key: 1,
        intent_id: row.id,
        kind: "effect",
        bucket: 0,
        due_at_ms: row.due,
        scheduled_at_ms: row.scheduled,
        ready_at_ms: row.ready,
        running: row.running ?? false,
        tenant_id: "t",
        actor_type: "Sender",
        actor_id: "s",
        target_type: "Sender",
        target_id: "s",
        command: row.command ?? "Capped",
        payload: "{}",
        caller: "{}",
      })),
    )}`
  })

const ready = (ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const rows = yield* sql<{ id: string; ready: number }>`SELECT intent_id AS id,
        ready_at_ms::int AS ready FROM actor_outbox WHERE intent_id IN ${sql.in(ids)}`

    return Object.fromEntries(rows.map(({ id, ready }) => [id, ready]))
  })

describe("capped effect order", () => {
  it("places a turn's capped effects after its type's earlier rows due no later, in perform order", () => {
    const runtime = ManagedRuntime.make(Database.pglite())

    return runtime
      .runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* migrate
          yield* sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id)
          VALUES (1, 't', 'Sender', 's')`

          yield* insert([
            { id: "earlier", due: 1000, scheduled: 1000, ready: 1000 },
            { id: "running", due: 61_000, scheduled: 1000, ready: 999, running: true },
            { id: "reminder", due: 9000, scheduled: 9000, ready: 9000 },
            { id: "other-type", command: "Other", due: 1000, scheduled: 1000, ready: 1500 },
          ])

          yield* insert([
            { id: "a", due: 1000, scheduled: 1000, ready: 1000 },
            { id: "later", due: 5000, scheduled: 5000, ready: 5000 },
            { id: "b", due: 1000, scheduled: 1000, ready: 1000 },
            { id: "c", due: 1000, scheduled: 1000, ready: 1000 },
          ])
          yield* orderCapped({
            sql,
            routingKey: 1n,
            sender,
            capped: [
              { id: "a", effect: "Capped", dueAt: 1000 },
              { id: "later", effect: "Capped", dueAt: 5000 },
              { id: "b", effect: "Capped", dueAt: 1000 },
              { id: "c", effect: "Capped", dueAt: 1000 },
            ],
          })

          expect(yield* ready(["a", "b", "c", "later"])).toEqual({
            a: 1001,
            b: 1002,
            c: 1003,
            later: 5000,
          })

          yield* insert([{ id: "d", due: 1000, scheduled: 1000, ready: 1000 }])
          yield* orderCapped({
            sql,
            routingKey: 1n,
            sender,
            capped: [{ id: "d", effect: "Capped", dueAt: 1000 }],
          })
          expect(yield* ready(["d"])).toEqual({ d: 1004 })
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

        const state = Actor.state({
          count: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
        })

        const Before = Actor.make("AdoptCreation", {
          key: Schema.NonEmptyString,
          state,
          api: { Create, Read },
        })

        const After = Actor.make("AdoptCreation", {
          key: Schema.NonEmptyString,
          state,
          api: { Create, Read },
          policy: { createdBy: Create },
        })

        const database = { liveClient: live }

        const first = yield* Effect.acquireRelease(
          Effect.sync(() =>
            ManagedRuntime.make(
              Before.toLayer(
                Effect.succeed({
                  Create: () => Effect.void,
                  Read: Effect.fnUntraced(function* () {
                    return (yield* Before.Turn).state.count
                  }),
                }),
              ).pipe(
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
              After.toLayer(
                Effect.succeed({
                  Create: Effect.fnUntraced(function* () {
                    yield* (yield* After.Turn).state.set({ count: 23 })
                  }),
                  Read: Effect.fnUntraced(function* () {
                    return (yield* After.Turn).state.count
                  }),
                }),
              ).pipe(
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
              const actor = yield* After.get("existing").pipe(Actor.tenant(tenant))
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

describe("placement adoption", () => {
  it("refuses to start an actor type under a different placement than its stored rows", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const live = yield* Effect.acquireRelease(
          Effect.promise(() => PGlite.create()),
          (client) => Effect.promise(() => client.close()),
        )

        const Bump = Actor.command("Bump", { output: Schema.Finite })

        const deploy = (placement: "tenant" | "actor") => {
          const Placed = Actor.make("Placed", {
            key: Schema.NonEmptyString,
            placement,
            state: Actor.state({
              count: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
            }),
            api: { Bump },
          })

          const runtime = ManagedRuntime.make(
            Placed.toLayer(
              Effect.succeed({
                Bump: Effect.fnUntraced(function* () {
                  const turn = yield* Placed.Turn
                  yield* turn.state.set({ count: turn.state.count + 1 })

                  return turn.state.count
                }),
              }),
            ).pipe(
              Layer.provideMerge(ActorTest.layer({ database: { liveClient: live } })),
              Layer.provideMerge(BunCrypto.layer),
            ),
          )

          return { Placed, runtime }
        }

        const first = deploy("tenant")

        expect(
          yield* Effect.promise(() =>
            first.runtime.runPromise(
              Effect.gen(function* () {
                return yield* (yield* first.Placed.get("one")).Bump()
              }),
            ),
          ),
        ).toBe(1)

        yield* Effect.promise(() => first.runtime.dispose())
        const moved = deploy("actor")
        const exit = yield* Effect.promise(() => moved.runtime.runPromiseExit(Effect.void))
        yield* Effect.promise(() => moved.runtime.dispose())
        expect(Exit.isFailure(exit)).toBe(true)

        if (Exit.isFailure(exit))
          expect(Cause.pretty(exit.cause)).toContain(
            "Actor Placed placement differs from the deployment",
          )

        const again = deploy("tenant")
        const started = yield* Effect.promise(() => again.runtime.runPromiseExit(Effect.void))
        yield* Effect.promise(() => again.runtime.dispose())
        expect(Exit.isSuccess(started)).toBe(true)
      }).pipe(Effect.scoped),
    ))
})

const GuardPing = Actor.command("Ping")

const guarded = Actor.table(pgTable("owned_guarded", { id: text("id").primaryKey() }))

const Guarded = Actor.make("Guarded", {
  key: Schema.String,
  tables: [guarded],
  api: { Ping: GuardPing },
})

const GuardedLive = Guarded.toLayer(Effect.succeed({ Ping: () => Effect.void }))

const start = (ddl: string | undefined, claim?: string) =>
  Effect.gen(function* () {
    const setup = ManagedRuntime.make(
      Layer.empty.pipe(Layer.provideMerge(ActorTest.layer({})), Layer.provide(BunCrypto.layer)),
    )

    return yield* Effect.promise(() =>
      setup.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient

          if (ddl !== undefined) yield* sql.unsafe(ddl)

          if (claim !== undefined)
            yield* sql`INSERT INTO actor_tables VALUES (current_schema(), 'owned_guarded', ${claim})`

          return yield* Layer.build(GuardedLive).pipe(Effect.scoped, Effect.exit)
        }),
      ),
    ).pipe(Effect.ensuring(Effect.promise(() => setup.dispose())))
  })

describe("owned table startup", () => {
  it("refuses to start without a correctly keyed table or under a second owner", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const keyed = `CREATE TABLE owned_guarded (routing_key bigint, tenant_id text, actor_id text, id text,
          PRIMARY KEY (routing_key, tenant_id, actor_id, id))`

        for (const [ddl, claim, message] of [
          [undefined, undefined, "needs primary key (routing_key, tenant_id, actor_id, id)"],
          ["CREATE TABLE owned_guarded (id text PRIMARY KEY)", undefined, "needs primary key"],
          [keyed, "Other", "owned by actor Other, not Guarded"],
        ] as const) {
          const exit = yield* start(ddl, claim)
          expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(message)
        }

        expect(Exit.isSuccess(yield* start(keyed))).toBe(true)
      }),
    ))
})

describe("singleton activation", () => {
  it("builds a singleton when it activates, so a failing build fails its commands, not startup", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const live = yield* Effect.acquireRelease(
          Effect.promise(() => PGlite.create()),
          (client) => Effect.promise(() => client.close()),
        )

        const Ping = Actor.command("Ping", { output: Schema.String })
        const Healthy = Actor.make("HealthySingleton", { key: Actor.singleton, api: { Ping } })
        const Broken = Actor.make("BrokenSingleton", { key: Actor.singleton, api: { Ping } })
        const builds = { healthy: 0, broken: 0 }

        const runtime = yield* Effect.acquireRelease(
          Effect.sync(() =>
            ManagedRuntime.make(
              Layer.mergeAll(
                Healthy.toLayer(
                  Effect.sync(() => {
                    builds.healthy += 1

                    return { Ping: () => Effect.succeed("pong") }
                  }),
                ),
                Broken.toLayer(
                  Effect.suspend(() => {
                    builds.broken += 1

                    return Effect.die(new Error("Broken singleton build"))
                  }),
                ),
              ).pipe(
                Layer.provideMerge(ActorTest.layer({ database: { liveClient: live } })),
                Layer.provideMerge(BunCrypto.layer),
                Layer.orDie,
              ),
            ),
          ),
          (runtime) => Effect.promise(() => runtime.dispose()),
        )

        yield* Effect.promise(() =>
          runtime.runPromise(
            Effect.gen(function* () {
              expect(builds).toEqual({ healthy: 0, broken: 0 })
              const broken = yield* (yield* Broken.get()).Ping().pipe(Effect.exit)
              expect(Exit.isFailure(broken) && Cause.pretty(broken.cause)).toContain(
                "Broken singleton build",
              )
              expect(builds.broken).toBe(1)
              const again = yield* (yield* Broken.get()).Ping().pipe(Effect.exit)
              expect(Exit.isFailure(again) && Cause.pretty(again.cause)).toContain(
                "Broken singleton build",
              )
              expect(builds.broken).toBe(1)
              expect(yield* (yield* Healthy.get()).Ping()).toBe("pong")
              expect(yield* (yield* Healthy.get()).Ping()).toBe("pong")
              expect(builds.healthy).toBe(1)
            }),
          ),
        )
      }).pipe(Effect.scoped),
    ))

  it("keeps a singleton whose hibernateAfter is shorter than a second resident", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const live = yield* Effect.acquireRelease(
          Effect.promise(() => PGlite.create()),
          (client) => Effect.promise(() => client.close()),
        )

        const Ping = Actor.command("Ping", { output: Schema.String })

        const Drowsy = Actor.make("DrowsySingleton", {
          key: Actor.singleton,
          api: { Ping },
          policy: { hibernateAfter: "200 millis" },
        })

        let builds = 0

        const runtime = yield* Effect.acquireRelease(
          Effect.sync(() =>
            ManagedRuntime.make(
              Drowsy.toLayer(
                Effect.sync(() => {
                  builds += 1

                  return { Ping: () => Effect.succeed("pong") }
                }),
              ).pipe(
                Layer.provideMerge(ActorTest.layer({ database: { liveClient: live } })),
                Layer.provideMerge(BunCrypto.layer),
                Layer.orDie,
              ),
            ),
          ),
          (runtime) => Effect.promise(() => runtime.dispose()),
        )

        yield* Effect.promise(() =>
          runtime.runPromise(
            Effect.gen(function* () {
              expect(yield* (yield* Drowsy.get()).Ping()).toBe("pong")
              yield* Effect.sleep("6 seconds")
              expect(yield* (yield* Drowsy.get()).Ping()).toBe("pong")
              expect(builds).toBe(1)
            }),
          ),
        )
      }).pipe(Effect.scoped),
    ))
})

describe("minted actor policy changes", () => {
  it("keeps a child minted under policy.createdBy reachable after a deployment removes the policy", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const live = yield* Effect.acquireRelease(
          Effect.promise(() => PGlite.create()),
          (client) => Effect.promise(() => client.close()),
        )

        const Open = Actor.command("Open", { input: Schema.String })
        const Title = Actor.command("Title", { output: Schema.String })
        const Spawn = Actor.command("Spawn", { output: Schema.String })

        const state = Actor.state({
          title: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
        })

        const Before = Actor.make("PolicyChild", {
          state,
          api: { Open, Title },
          policy: { createdBy: Open },
        })

        const After = Actor.make("PolicyChild", { state, api: { Open, Title } })
        const Parent = Actor.make("PolicyParent", { key: Schema.String, api: { Spawn } })

        const handlers = <A extends typeof Before | typeof After>(child: A) =>
          Effect.succeed({
            Open: Effect.fnUntraced(function* (title: string) {
              yield* (yield* child.Turn).state.set({ title })
            }),
            Title: Effect.fnUntraced(function* () {
              return (yield* child.Turn).state.title
            }),
          })

        const deployment = (actors: Layer.Layer<never, never, InternalActors>) =>
          Effect.acquireRelease(
            Effect.sync(() =>
              ManagedRuntime.make(
                actors.pipe(
                  Layer.provideMerge(ActorTest.layer({ database: { liveClient: live } })),
                  Layer.provideMerge(BunCrypto.layer),
                  Layer.orDie,
                ),
              ),
            ),
            (runtime) => Effect.promise(() => runtime.dispose()),
          )

        const first = yield* deployment(
          Layer.mergeAll(
            Before.toLayer(handlers(Before)),
            Parent.toLayer(
              Effect.succeed({
                Spawn: Effect.fnUntraced(function* () {
                  const id = yield* (yield* Parent.Turn).mint(Before)
                  yield* (yield* Before.intents(id)).Open("kept")

                  return id
                }),
              }),
            ),
          ),
        )

        const { id, tenant } = yield* Effect.promise(() =>
          first.runPromise(
            Effect.gen(function* () {
              const id = yield* (yield* Parent.get("p")).Spawn()
              yield* (yield* ActorTest).advance(0)
              expect(
                yield* (yield* Before.get(id as Parameters<typeof Before.get>[0])).Title(),
              ).toBe("kept")

              return { id, tenant: (yield* ActorTest).tenant }
            }),
          ),
        )

        yield* Effect.promise(() => first.dispose())

        const second = yield* deployment(After.toLayer(handlers(After)))

        yield* Effect.promise(() =>
          second.runPromise(
            Effect.gen(function* () {
              const child = yield* After.get(id as Parameters<typeof After.get>[0]).pipe(
                Actor.tenant(tenant),
              )

              expect(yield* child.Title()).toBe("kept")
              yield* child.Open("changed")
              expect(yield* child.Title()).toBe("changed")
            }),
          ),
        )
      }).pipe(Effect.scoped),
    ))
})
