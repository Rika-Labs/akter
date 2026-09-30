import { Cause, Effect, Exit, Option, Predicate, Schema, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { ActorError, SessionEnded, Unauthorized } from "../../../errors/actor.ts"
import { MAX_OUTBOUND_BYTES, MAX_OUTBOUND_FRAMES } from "../../../runtime/connections/holder.ts"
import { ClientMessage } from "../../../runtime/connections/protocol.ts"
import type { ConformanceCase } from "../../conformance.ts"
import { Hello, Said, Say, receipted, type ConnectionsFixture } from "./actors.ts"
import {
  connect,
  eventually,
  fakeHolder,
  frameOf,
  heldUntilEnd,
  isFrame,
  next,
  rawFrame,
  resyncFrom,
  untilEnd,
} from "./harness.ts"

/** Holder-side generation, liveness, redelivery, and close handling of connections. */
export const connectionHolderConformance: ReadonlyArray<ConformanceCase<ConnectionsFixture>> = [
  {
    name: "a command and a frame that wake one parked actor together acquire one generation",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, room, connection } = yield* connect("connections-together")
          yield* next(connection)
          yield* test.hibernate(room.ref)
          const parked = BigInt((yield* test.inspect(room.ref)).generation!)

          yield* Effect.all(
            [room.Post("together"), connection.send(Say.make({ text: "whoami" }))],
            { concurrency: "unbounded", discard: true },
          )

          const woken = (yield* next(connection, 2)).map(frameOf)
          const said = woken.find((frame) => Predicate.isTagged(frame, "Said"))
          const hello = woken.find((frame) => Predicate.isTagged(frame, "Hello"))
          expect(said).toEqual(Said.make({ text: "together" }))
          expect(hello).toEqual(Hello.make({ name: "alice", resumed: true, frames: 1 }))
          expect(BigInt((yield* test.inspect(room.ref)).generation!)).toBe(parked + 1n)
        }),
      ),
  },
  {
    name: "a holder whose liveness check fails for a whole reauthorization bound ends its sessions, and later opens are not blamed for it",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const { test, connection } = yield* connect("connections-blind")
          yield* next(connection)

          yield* sql`ALTER TABLE actor_connections RENAME TO actor_connections_hidden`.pipe(
            Effect.orDie,
          )

          const { ended } = yield* Effect.gen(function* () {
            yield* test.advance("11 seconds")
            yield* Effect.sleep("500 millis")
            yield* test.advance("40 seconds")
            yield* Effect.sleep("500 millis")
            yield* test.advance("21 seconds")

            return yield* untilEnd(connection)
          }).pipe(
            Effect.ensuring(
              sql`ALTER TABLE actor_connections_hidden RENAME TO actor_connections`.pipe(
                Effect.orDie,
              ),
            ),
          )

          expect(Schema.is(SessionEnded)(ended)).toBe(true)
          expect(ended).toMatchObject({ cause: "ActorUnavailable", resync: true })

          const after = yield* connect("connections-sighted")
          yield* next(after.connection)
          yield* Effect.sleep("300 millis")
          yield* after.connection.send(Say.make({ text: "whoami" }))
          const [answer] = yield* next(after.connection)
          expect(frameOf(answer)).toEqual(Hello.make({ name: "alice", resumed: false, frames: 1 }))
        }),
      ),
  },
  {
    name: "a holder applies a redelivered owner message once and counts resync-deferred frames against the outbound limits",
    timeoutMs: 30_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { room, connection } = yield* connect("connections-redelivered")
          yield* next(connection)
          let alive = true

          const fake = yield* fakeHolder({
            name: "redelivered",
            template: connection.connectionId,
            alive: () => alive,
            type: { takeoverMs: 60_000 },
          })

          const frames = yield* fake.open(room.ref)
          const bytes = yield* fake.open(room.ref)
          const once = fake.message(room.ref, "1", 1, [rawFrame([frames.connectionId], "once")])
          yield* fake.holder.deliver(once)
          expect(yield* fake.holder.deliver(once)).toEqual({ wrongEpoch: false, unknown: [] })

          yield* fake.holder.deliver(
            fake.message(room.ref, "1", 2, [rawFrame([frames.connectionId], "twice")]),
          )

          const delivered = yield* frames.messages.pipe(
            Stream.take(2),
            Stream.runCollect,
            Effect.timeout("5 seconds"),
            Effect.orDie,
          )

          expect(
            [...delivered].map((message) =>
              ClientMessage.guards.Frame(message) ? message.frame : undefined,
            ),
          ).toEqual(["once", "twice"])

          alive = false

          for (const held of [frames, bytes]) {
            const [resync] = yield* held.messages.pipe(
              Stream.take(1),
              Stream.runCollect,
              Effect.timeout("10 seconds"),
              Effect.orDie,
            )

            expect(resync?._tag).toBe("Resync")
          }

          const half = "x".repeat(MAX_OUTBOUND_BYTES / 2 + 1)

          yield* fake.holder.deliver(
            fake.message(room.ref, "2", 1, [
              ...Array.from({ length: MAX_OUTBOUND_FRAMES + 1 }, (_, index) =>
                rawFrame([frames.connectionId], `deferred ${index}`),
              ),
              rawFrame([bytes.connectionId], half),
              rawFrame([bytes.connectionId], half),
            ]),
          )

          for (const held of [frames, bytes]) {
            const { seen, ended } = yield* heldUntilEnd(held)
            expect(seen).toEqual([])
            expect(ended).toMatchObject({ cause: "SlowConsumer", resync: true })
          }
        }),
      ),
  },
  {
    name: "a holder never delivers a broadcast that arrives past the session's authorization bound",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { room, connection } = yield* connect("connections-late-broadcast")
          yield* next(connection)
          let offset = 0

          const fake = yield* fakeHolder({
            name: "late-broadcast",
            template: connection.connectionId,
            offset: () => offset,
          })

          const held = yield* fake.open(room.ref)
          offset = 60_001
          yield* fake.holder.deliver(
            fake.message(room.ref, "1", 1, [rawFrame([held.connectionId], "late")]),
          )
          const { seen, ended } = yield* heldUntilEnd(held)
          expect(seen).toEqual([])
          expect(ended).toMatchObject(Unauthorized.make({ code: "reauthorization_unavailable" }))
        }),
      ),
  },
  {
    name: "a holder closes a connection again when its owner commits the open after the holder gave up",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { room, connection } = yield* connect("connections-late-open")
          yield* next(connection)
          const closes: Array<SessionEnded> = []

          const fake = yield* fakeHolder({
            name: "late-open",
            template: connection.connectionId,
            type: { deliveryMs: 200 },
            channel: (copyRow) => ({
              open: (request) => copyRow(request).pipe(Effect.delay("600 millis")),
              close: (request) => Effect.sync(() => closes.push(request.cause)),
            }),
          })

          const exit = yield* fake.open(room.ref).pipe(Effect.exit)
          const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()

          const reason = Option.filter(failure, Schema.is(ActorError)).pipe(
            Option.map((error) => error.reason),
            Option.getOrUndefined,
          )

          expect(reason).toMatchObject({ cause: "ActorUnavailable", resync: true })

          yield* eventually(
            Effect.sync(() => closes.length > 0),
            "the late open to be closed",
          )

          expect(closes).toMatchObject([{ cause: "ActorUnavailable", resync: true }])
        }),
      ),
  },
  {
    name: "a resync whose new owner never answers within the takeover bound closes with OwnerLost",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { room, connection } = yield* connect("connections-unanswered")
          yield* next(connection)
          const requests: Array<string | undefined> = []

          const fake = yield* fakeHolder({
            name: "unanswered",
            template: connection.connectionId,
            type: { takeoverMs: 300 },
            channel: (copyRow) => ({
              open: (request) =>
                copyRow(request).pipe(
                  Effect.map((opened) => ({ ...opened, baseline: "4", recovered: true })),
                ),
              resync: (request) =>
                Effect.sync(() => requests.push(request.after)).pipe(Effect.andThen(Effect.never)),
            }),
          })

          const held = yield* fake.open(room.ref)
          const { seen, ended } = yield* heldUntilEnd(held)
          expect(seen).toMatchObject([resyncFrom("4")])
          expect(requests).toEqual(["4"])
          expect(ended).toMatchObject({ cause: "OwnerLost", resync: true })
        }),
      ),
  },
  {
    name: "sends a server frame shaped like an event entry as the frame itself when its event is no server frame",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { connection } = yield* connect("connections-receipted")
          yield* next(connection)
          yield* connection.send(Say.make({ text: "receipted" }))
          const [sent] = yield* next(connection)
          expect(frameOf(sent)).toEqual(receipted)
          expect(isFrame(sent) ? sent.event : "stamped").toBe(undefined)
        }),
      ),
  },
]
