import { BunCrypto } from "@effect/platform-bun"
import {
  Config,
  Crypto,
  Deferred,
  Effect,
  Fiber,
  Layer,
  ManagedRuntime,
  Redacted,
  Schedule,
} from "effect"
import { SqlClient } from "effect/sql"
import { Pool, type PoolClient } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { ActorRef } from "../../identity/caller.ts"
import { Database } from "../layer.ts"
import { migrate } from "../database/migrations.ts"
import { fence, heldGeneration, type OwnedActor } from "./generation.ts"

const actor: OwnedActor = {
  key: 42n,
  ref: ActorRef.make({ tenant: "tenant-a", actor: "Room", id: "lobby" }),
}

const row = [actor.key.toString(), actor.ref.tenant, actor.ref.actor, actor.ref.id]

const identity = "routing_key = $1 AND tenant_id = $2 AND actor_type = $3 AND actor_id = $4"

/**
 * A fresh migrated database holding one actor at generation 1, with the
 * framework's SQL client and a raw client that plays the activation taking
 * over. Returns once both are ready.
 */
const database = Effect.gen(function* () {
  const url = new URL(yield* Config.String("TEST_DATABASE_URL"))
  const name = `fencing_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

  const admin = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: url.href })),
    (pool) => Effect.promise(() => pool.end()),
  )

  yield* Effect.acquireRelease(
    Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
    () => Effect.promise(() => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)),
  )
  url.pathname = `/${name}`

  const client = yield* Layer.build(Database.postgres({ url: Redacted.make(url.href) }))
  yield* Effect.provide(migrate, client)

  const pool = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: url.href })),
    (opened) => Effect.promise(() => opened.end()),
  )

  yield* Effect.promise(() =>
    pool.query(
      `INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id, generation)
        VALUES ($1, $2, $3, $4, 1)`,
      row,
    ),
  )

  const takeover = yield* Effect.acquireRelease(
    Effect.promise(() => pool.connect()),
    (connection) => Effect.sync(() => connection.release()),
  )

  return { name, client, pool, takeover }
})

/** Starts the new owner's transaction the way a cold turn does: lock the row, then advance it. */
const beginTakeover = (takeover: PoolClient) =>
  Effect.forEach(
    [
      "BEGIN",
      `SELECT 1 FROM actor_generations WHERE ${identity} FOR UPDATE`,
      `UPDATE actor_generations SET generation = generation + 1 WHERE ${identity}`,
    ],
    (text) => Effect.promise(() => takeover.query(text, text === "BEGIN" ? [] : row)),
    { discard: true },
  )

/** Waits until some statement in `name` is blocked on a row lock. */
const blockedOnLock = (pool: Pool, name: string) =>
  Effect.promise(() =>
    pool.query("SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'", [
      name,
    ]),
  ).pipe(
    Effect.flatMap((result) => (result.rowCount === 0 ? Effect.fail("not waiting") : Effect.void)),
    Effect.retry({ times: 200, schedule: Schedule.spaced("25 millis") }),
  )

describe("generation fencing with Postgres", () => {
  const runtime = ManagedRuntime.make(BunCrypto.layer)
  afterAll(() => runtime.dispose())

  it("a session write joined to the held generation waits out a takeover and then writes nothing", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { name, client, pool, takeover } = yield* database

          yield* beginTakeover(takeover)

          const write = yield* Effect.forkChild(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient

              return yield* sql<{ connection_id: string }>`
                INSERT INTO actor_connections (routing_key, connection_id, bucket, tenant_id, actor_type,
                  actor_id, member, holder, holder_epoch, caller, opened_at_ms, opened_through)
                SELECT routing_key, 'c1', (routing_key >> 56)::integer, tenant_id, actor_type, actor_id,
                  'Chat', 'holder-a', '1', '{}', 0, 0
                FROM (${heldGeneration({ sql, actor, generation: "1", lock: "SHARE" })}) g
                RETURNING connection_id`
            }).pipe(Effect.provide(client)),
          )

          yield* blockedOnLock(pool, name)

          const seen = yield* Effect.promise(() =>
            takeover.query(
              `SELECT count(*)::int AS n FROM actor_connections WHERE ${identity}`,
              row,
            ),
          )

          yield* Effect.promise(() => takeover.query("COMMIT"))

          expect(seen.rows[0].n).toBe(0)
          expect(yield* Fiber.join(write)).toEqual([])

          const stored = yield* Effect.promise(() =>
            pool.query(`SELECT count(*)::int AS n FROM actor_connections WHERE ${identity}`, row),
          )

          expect(stored.rows[0].n).toBe(0)
        }),
      ),
    ))

  it("fence answers false after a takeover and forgets the cached generation and state", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { client, takeover } = yield* database

          const cache = {
            generation: "1",
            state: new Map([["count", "7"]]) as ReadonlyMap<string, string> | undefined,
          }

          yield* beginTakeover(takeover)
          yield* Effect.promise(() => takeover.query("COMMIT"))

          const held = yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient

            return yield* sql.withTransaction(fence({ actor, cache, lock: "UPDATE" }))
          }).pipe(Effect.provide(client))

          expect(held).toBe(false)
          expect(cache).toEqual({ generation: undefined, state: undefined })
        }),
      ),
    ))

  it("fence holds the current generation until the writer's transaction ends", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { name, client, pool, takeover } = yield* database

          const cache = {
            generation: "1",
            state: new Map() as ReadonlyMap<string, string> | undefined,
          }

          const fenced = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()

          const writer = yield* Effect.forkChild(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient

              return yield* sql.withTransaction(
                Effect.gen(function* () {
                  const held = yield* fence({ actor, cache, lock: "UPDATE" })
                  yield* Deferred.succeed(fenced, undefined)
                  yield* Deferred.await(release)

                  return held
                }),
              )
            }).pipe(Effect.provide(client)),
          )

          yield* Deferred.await(fenced)

          const takeoverDone = yield* Effect.forkChild(beginTakeover(takeover))

          yield* blockedOnLock(pool, name)
          expect(takeoverDone.pollUnsafe()).toBeUndefined()
          yield* Deferred.succeed(release, undefined)

          expect(yield* Fiber.join(writer)).toBe(true)
          yield* Fiber.join(takeoverDone)
          yield* Effect.promise(() => takeover.query("COMMIT"))

          expect(cache.generation).toBe("1")

          const stored = yield* Effect.promise(() =>
            pool.query(
              `SELECT generation::text AS g FROM actor_generations WHERE ${identity}`,
              row,
            ),
          )

          expect(stored.rows[0].g).toBe("2")
        }),
      ),
    ))
})
