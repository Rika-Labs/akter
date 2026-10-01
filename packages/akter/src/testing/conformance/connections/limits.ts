import { Cause, Effect, Exit, Fiber, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { ActorUnavailable, SessionEnded, Unauthorized } from "../../../errors/actor.ts"
import { MAX_SESSION_BYTES } from "../../../runtime/connections/owner.ts"
import { decompress } from "../../../runtime/storage/codec.ts"
import { ActorTest } from "../../actor-test.ts"
import type { ConformanceCase } from "../../conformance.ts"
import {
  Hello,
  Live,
  Room,
  Said,
  Say,
  Undeclared,
  holdNext,
  sessionJson,
  storedSession,
  type ConnectionsFixture,
} from "./actors.ts"
import { connect, eventually, frameOf, next, posts, rows, untilEnd } from "./harness.ts"

/** Session and frame limits, broadcast ordering, and rejected opens of connections. */
export const connectionLimitConformance: ReadonlyArray<ConformanceCase<ConnectionsFixture>> = [
  {
    name: "rejects a session above 16 KiB as a defect, closes the connection, and stores nothing of it",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { room, connection } = yield* connect("connections-session-limit")
          yield* next(connection)

          const fits = MAX_SESSION_BYTES - (yield* sessionJson({ name: "", frames: 1 })).length
          yield* connection.send(Say.make({ text: `grow:${fits}` }))
          const [grown] = yield* next(connection)
          expect(frameOf(grown)).toEqual(Hello.make({ name: `${fits}`, resumed: false, frames: 1 }))

          const [stored] = yield* rows(room.ref)
          expect(stored?.frame_seq).toBe("1")

          const session = (yield* storedSession(decompress(stored!.session!))).value
          const json = yield* sessionJson(session)
          expect(new TextEncoder().encode(json).byteLength).toBe(MAX_SESSION_BYTES)

          yield* connection.send(Say.make({ text: `grow:${fits + 1}` }))
          const { seen, ended } = yield* untilEnd(connection)
          expect(seen).toEqual([])
          expect(Schema.is(SessionEnded)(ended)).toBe(true)
          expect(ended).toMatchObject({ cause: "Defect", resync: false })
          expect(yield* rows(room.ref)).toEqual([])
        }),
      ),
  },
  {
    name: "sends a broadcast committed while open runs after the open's own frames",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const room = yield* Room.get("connections-opening")
          const hold = yield* holdNext(fixture)

          const opening = yield* test
            .connect(room.ref, Live, { name: "held" })
            .pipe(Effect.forkChild({ startImmediately: true }))

          yield* hold.reached
          yield* room.Post("during open")
          yield* hold.release
          const connection = yield* Fiber.join(opening)
          const opened = yield* next(connection, 2)

          expect(opened.map(frameOf)).toEqual([
            Hello.make({ name: "held", resumed: false, frames: 0 }),
            Said.make({ text: "during open" }),
          ])
        }),
      ),
  },
  {
    name: "a failed row delete keeps the connection open and still reached by broadcasts",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const { room, connection } = yield* connect("connections-undeletable")
          yield* next(connection)

          yield* sql`CREATE FUNCTION connections_keep_row() RETURNS trigger LANGUAGE plpgsql
            AS $$ BEGIN RAISE EXCEPTION 'row delete refused'; END $$`.pipe(Effect.orDie)

          yield* sql`CREATE TRIGGER connections_keep_row BEFORE DELETE ON actor_connections
            FOR EACH ROW WHEN (OLD.actor_id = 'connections-undeletable')
            EXECUTE FUNCTION connections_keep_row()`.pipe(Effect.orDie)

          yield* Effect.gen(function* () {
            yield* connection.send(Say.make({ text: "leave" }))
            yield* room.Post("still here")
            const [still] = yield* next(connection)
            expect(frameOf(still)).toEqual(Said.make({ text: "still here" }))
            expect((yield* rows(room.ref)).length).toBe(1)
          }).pipe(
            Effect.ensuring(
              Effect.all([
                sql`DROP TRIGGER connections_keep_row ON actor_connections`,
                sql`DROP FUNCTION connections_keep_row()`,
              ]).pipe(Effect.orDie),
            ),
          )
        }),
      ),
  },
  {
    name: "a connection queues at most 1,024 inbound frames and never runs the queue it dropped",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const { room, connection } = yield* connect("connections-inbound")
          yield* next(connection)
          const hold = yield* holdNext(fixture)
          yield* connection.send(Say.make({ text: "hold" }))
          yield* hold.reached

          for (let index = 0; index <= 1_024; index++)
            yield* connection.send(Say.make({ text: "queued" })).pipe(Effect.ignore)

          const { ended } = yield* untilEnd(connection)
          expect(Schema.is(SessionEnded)(ended)).toBe(true)
          expect(ended).toMatchObject({ cause: "SlowConsumer", resync: true })

          yield* hold.release
          yield* Effect.sleep("500 millis")
          expect(yield* posts(room.ref)).toBe(0)
        }),
      ),
  },
  {
    name: "a revoked connection drops its unread outbound frames and its queued inbound frames",
    run: ({ expect, environment, fixture, access }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, room, connection } = yield* connect("connections-revoked-queue")
          yield* next(connection)

          yield* room.Post("unread")
          const hold = yield* holdNext(fixture)
          yield* connection.send(Say.make({ text: "hold" }))
          yield* hold.reached
          yield* connection.send(Say.make({ text: "queued" }))

          access.allowed = false

          const { seen, ended } = yield* test.advance("55 seconds").pipe(
            Effect.andThen(
              eventually(
                Effect.map(rows(room.ref), (found) => found.length === 0),
                "the revoked row to go",
              ),
            ),
            Effect.andThen(untilEnd(connection)),
            Effect.ensuring(Effect.sync(() => (access.allowed = true))),
          )

          expect(ended).toMatchObject(Unauthorized.make({ code: "access_denied" }))
          expect(seen).toEqual([])

          yield* hold.release
          yield* Effect.sleep("500 millis")
          expect(yield* posts(room.ref)).toBe(1)
        }),
      ),
  },
  {
    name: "rejects an open for a member the actor does not declare before authorizing it",
    run: ({ expect, environment, access }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const room = yield* Room.get("connections-undeclared")
          access.allowed = false

          const exit = yield* test
            .connect(room.ref, Undeclared, {})
            .pipe(Effect.exit, Effect.ensuring(Effect.sync(() => (access.allowed = true))))

          const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()
          expect(Schema.is(ActorUnavailable)(Option.getOrUndefined(failure)?.reason)).toBe(true)
          expect(yield* rows(room.ref)).toEqual([])
        }),
      ),
  },
]
