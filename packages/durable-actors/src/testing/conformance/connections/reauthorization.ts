import { Effect, Schedule, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SessionEnded, Unauthorized } from "../../../errors/actor.ts"
import type { ConformanceCase } from "../../conformance.ts"
import { Hello, Say } from "./actors.ts"
import { connect, endOf, frameOf, next, reasonOf, rows } from "./harness.ts"

/** Reauthorization, holder liveness checks, and server-side closes of connections. */
export const connectionReauthorizationConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "a denied reauthorization ends the session with access_denied and never wakes the actor",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, room, connection } = yield* connect("connections-revoked")
          yield* next(connection)
          yield* test.hibernate(room.ref)
          const generation = (yield* test.inspect(room.ref)).generation

          fixture.allowed = false
          yield* test.advance("55 seconds")

          const ended = yield* endOf(connection).pipe(
            Effect.ensuring(Effect.sync(() => (fixture.allowed = true))),
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
