import { Effect, Fiber, Schedule, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SessionEnded, Unauthorized } from "../../../errors/actor.ts"
import { ActorTest } from "../../actor-test.ts"
import type { ConformanceCase } from "../../conformance.ts"
import { Hello, Room, Said, Say, type ConnectionsFixture } from "./actors.ts"
import { connect, endOf, frameOf, next, posts, reasonOf, rows } from "./harness.ts"
import { Actor, User } from "../../../index.ts"

/** Reauthorization, holder liveness checks, and server-side closes of connections. */
export const connectionReauthorizationConformance: ReadonlyArray<
  ConformanceCase<ConnectionsFixture>
> = [
  {
    name: "a denied reauthorization ends the session with access_denied and never wakes the actor",
    run: ({ expect, environment, access }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, room, connection } = yield* connect("connections-revoked")
          yield* next(connection)
          yield* test.hibernate(room.ref)
          const generation = (yield* test.inspect(room.ref)).generation

          access.allowed = false
          yield* test.advance("55 seconds")

          const ended = yield* endOf(connection).pipe(
            Effect.ensuring(Effect.sync(() => (access.allowed = true))),
          )

          expect(reasonOf(ended)).toMatchObject(Unauthorized.make({ code: "access_denied" }))
          expect((yield* test.inspect(room.ref)).generation).toBe(generation)
          yield* rows(room.ref).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("20 millis"),
              until: (found) => found.length === 0,
            }),
            Effect.timeout("5 seconds"),
            Effect.orDie,
          )
        }),
      ),
  },
  {
    name: "a connection whose row its owner dropped ends with ServerClosed and resync at the holder's liveness check",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, room, connection } = yield* connect("connections-excluded")
          yield* next(connection)
          const sql = yield* SqlClient.SqlClient
          yield* sql`DELETE FROM actor_connections WHERE tenant_id = ${room.ref.tenant}
            AND actor_type = ${room.ref.actor} AND actor_id = ${room.ref.id}`.pipe(Effect.orDie)
          yield* test.advance("11 seconds")
          const closed = reasonOf(yield* endOf(connection))
          expect(Schema.is(SessionEnded)(closed)).toBe(true)
          expect(closed).toMatchObject({ cause: "ServerClosed", resync: true })
        }),
      ),
  },
  {
    name: "an owner deletes the rows of an earlier holder epoch at the same address, and its live connection still receives broadcasts",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, room, connection } = yield* connect("connections-old-epoch")
          yield* next(connection)
          const sql = yield* SqlClient.SqlClient
          yield* sql`
            INSERT INTO actor_connections (
              routing_key, connection_id, bucket, tenant_id, actor_type, actor_id, member,
              holder, holder_epoch, caller, session, opened_at_ms, opened_through
            )
            SELECT routing_key, 'connections-old-epoch-stale', bucket, tenant_id, actor_type,
              actor_id, member, holder, 'restarted-away', caller, NULL, opened_at_ms, 0
            FROM actor_connections WHERE connection_id = ${connection.connectionId}`.pipe(
            Effect.orDie,
          )
          expect((yield* rows(room.ref)).length).toBe(2)
          yield* test.hibernate(room.ref)

          yield* room.Post("after restart")
          const [broadcast] = yield* next(connection)
          expect(frameOf(broadcast)).toEqual(Said.make({ text: "after restart" }))

          const left = yield* sql<{ connection_id: string }>`SELECT connection_id
            FROM actor_connections WHERE tenant_id = ${room.ref.tenant}
              AND actor_type = ${room.ref.actor} AND actor_id = ${room.ref.id}`.pipe(Effect.orDie)

          expect(left).toEqual([{ connection_id: connection.connectionId }])
        }),
      ),
  },
  {
    name: "a connection's commands take ids another caller never holds, and each commits once under its own caller",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, room, connection } = yield* connect("connections-preminted")
          yield* next(connection)
          yield* Room.get("connections-preminted").pipe(
            Effect.flatMap((asBob) => asBob.Post("preminted")),
            Actor.as(User.make({ subject: "bob" })),
          )
          yield* next(connection)

          yield* connection.send(Say.make({ text: "preminted" }))
          const [broadcast] = yield* next(connection)
          expect(frameOf(broadcast)).toEqual(Said.make({ text: "preminted" }))

          const sql = yield* SqlClient.SqlClient

          const receipts = yield* sql<{ command_id: string; caller_key: string }>`
            SELECT command_id, caller_key FROM actor_receipts WHERE tenant_id = ${room.ref.tenant}
              AND actor_type = ${room.ref.actor} AND actor_id = ${room.ref.id}
              AND command = 'Post'`.pipe(Effect.orDie)

          expect(receipts.length).toBe(2)
          expect(new Set(receipts.map((receipt) => receipt.command_id)).size).toBe(2)
          expect(new Set(receipts.map((receipt) => receipt.caller_key)).size).toBe(2)
          expect(yield* posts(room.ref)).toBe(2)
          expect(yield* test.receiptsFor(room.ref, "Post")).toBe(2)
        }),
      ),
  },
  {
    name: "a turn whose connection-row load loses its database connection commits nothing, and the caller's retry under the same id commits once",
    requiresIndependentConnections: true,
    timeoutMs: 30_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const room = yield* Room.get("connections-row-load")

          if (environment.connect === undefined)
            return yield* Effect.die(new Error("backend lacks independent connections"))

          const lock = yield* environment.connect
          yield* lock.query("BEGIN")
          yield* lock.query("LOCK TABLE actor_connections IN ACCESS EXCLUSIVE MODE")

          const posting = yield* room.Post("during outage").pipe(Effect.forkChild)

          const loads = Effect.andThen(
            lock.query("SELECT pg_stat_clear_snapshot()"),
            lock.query(
              `SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid
              WHERE NOT l.granted AND l.relation = 'actor_connections'::regclass
                AND a.query LIKE '%connection_id, member, holder, holder_epoch%'`,
            ),
          )

          const waiting = yield* loads.pipe(
            Effect.repeat({
              schedule: Schedule.spaced("20 millis"),
              until: (pids) => pids.length > 0,
            }),
            Effect.timeout("10 seconds"),
            Effect.orDie,
          )

          expect(waiting.length).toBe(1)
          expect(yield* test.receiptsFor(room.ref, "Post")).toBe(0)

          const terminated = yield* lock.query(
            `SELECT pg_terminate_backend(a.pid) AS terminated FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid
              WHERE NOT l.granted AND l.relation = 'actor_connections'::regclass
                AND a.query LIKE '%connection_id, member, holder, holder_epoch%'`,
          )

          expect(terminated).toEqual([{ terminated: true }])
          yield* lock.query("ROLLBACK")

          yield* Fiber.join(posting)
          expect(yield* posts(room.ref)).toBe(1)
          expect(yield* test.receiptsFor(room.ref, "Post")).toBe(1)
        }),
      ),
  },
  {
    name: "a held connection survives the holder's liveness check whatever its routing bucket",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, connection } = yield* connect("connections-liveness")
          yield* next(connection)
          const dropped = yield* connect("connections-liveness-dropped")
          yield* next(dropped.connection)
          const sql = yield* SqlClient.SqlClient
          yield* sql`DELETE FROM actor_connections WHERE tenant_id = ${dropped.room.ref.tenant}
            AND actor_type = ${dropped.room.ref.actor} AND actor_id = ${dropped.room.ref.id}`.pipe(
            Effect.orDie,
          )
          yield* test.advance("11 seconds")
          expect(reasonOf(yield* endOf(dropped.connection))).toMatchObject({
            cause: "ServerClosed",
          })

          yield* connection.send(Say.make({ text: "whoami" }))
          const [answer] = yield* next(connection)
          expect(frameOf(answer)).toEqual(Hello.make({ name: "alice", resumed: false, frames: 1 }))
        }),
      ),
  },
  {
    name: "an open handler that closes its connection leaves it ended with ServerClosed",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { room, connection } = yield* connect("connections-leaver", "leaver")
          const closed = reasonOf(yield* endOf(connection))
          expect(Schema.is(SessionEnded)(closed)).toBe(true)
          expect(closed).toMatchObject({ cause: "ServerClosed", resync: false })
          expect(yield* rows(room.ref)).toEqual([])
        }),
      ),
  },
  {
    name: "a frame queued after the reauthorization bound never reaches its handler",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, room, connection } = yield* connect("connections-lapsed")
          yield* next(connection)
          yield* test.advance("61 seconds")
          yield* connection.send(Say.make({ text: "late" })).pipe(Effect.ignore)
          expect(reasonOf(yield* endOf(connection))).toMatchObject(
            Unauthorized.make({ code: "reauthorization_unavailable" }),
          )
          expect((yield* test.inspect(room.ref)).state).not.toMatchObject({ posts: 1 })
        }),
      ),
  },
  {
    name: "a session with no successful reauthorization by its bound ends with reauthorization_unavailable",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, connection } = yield* connect("connections-bound")
          yield* next(connection)
          yield* test.advance("61 seconds")
          expect(reasonOf(yield* endOf(connection))).toMatchObject(
            Unauthorized.make({ code: "reauthorization_unavailable" }),
          )
        }),
      ),
  },
]
