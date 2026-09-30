import { Effect, Fiber, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { User } from "../../../index.ts"
import { InternalActors } from "../../../handles/actors.ts"
import type { ActorRef } from "../../../identity/caller.ts"
import { ActorTest } from "../../actor-test.ts"
import { ActorCluster } from "../../cluster.ts"
import type { ConformanceCase } from "../../conformance.ts"
import { FeedRoom, transportsLayer } from "./actors.ts"
import { cursorError, decodeEntry, feed, feedReason, rows, setup, take, textOf } from "./harness.ts"
import { serveSockets } from "./wire.ts"

/** Event feeds over SSE: resume, authorization, expiry, parking, catch-up, and resync. */
export const transportFeedConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "serves an event feed: committed events after the cursor, then live ones, with no gap or repeat through a commit race",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { host, token } = yield* setup(environment)
          const room = yield* FeedRoom.get("sse-race")
          yield* room.Tell("one")
          yield* room.Note("not served")
          yield* room.Tell("two")

          const racing = yield* Effect.forEach(
            Array.from({ length: 20 }, (_, index) => index),
            (index) => room.Tell(`race-${index}`),
            { concurrency: 4 },
          ).pipe(Effect.forkScoped)

          const opened = yield* feed(host, "sse-race", "event=Said&after=0", {
            authorization: token(),
          })

          expect(opened.status).toBe(200)
          yield* Fiber.join(racing)
          yield* room.Tell("live")

          const received = yield* take(opened.messages, 23)
          const cursors = received.map((message) => Number(message.id))

          expect(cursors).toEqual([...cursors].sort((left, right) => left - right))
          expect(new Set(cursors).size).toBe(23)
          expect(cursors.includes(2)).toBe(false)
          expect(received.every((message) => message.event === "Said")).toBe(true)
          expect(yield* textOf(received[0]!)).toBe("one")
          expect(yield* textOf(received.at(-1)!)).toBe("live")
          const entry = yield* decodeEntry(received[0]!.data).pipe(Effect.orDie)
          expect(entry.commandId.startsWith("v1.")).toBe(true)
        }),
      ),
  },
  {
    name: "resumes a feed from Last-Event-ID with no gap or repeat, and answers UnknownCursor and RetentionGap before streaming",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { host, token } = yield* setup(environment)
          const room = yield* FeedRoom.get("sse-resume")

          for (const text of ["a", "b", "c", "d"]) yield* room.Tell(text)

          const after = yield* feed(host, "sse-resume", "event=Said&after=2", {
            authorization: token(),
          })

          expect((yield* take(after.messages, 2)).map((message) => message.id)).toEqual(["3", "4"])

          const resumed = yield* feed(host, "sse-resume", "event=Said&after=0", {
            authorization: token(),
            "last-event-id": "3",
          })

          expect((yield* take(resumed.messages, 1)).map((message) => message.id)).toEqual(["4"])

          const future = yield* feed(host, "sse-resume", "event=Said&after=99", {
            authorization: token(),
          })

          expect(future.status).toBe(404)
          expect(yield* cursorError(future.body)).toEqual({ tag: "UnknownCursor", cursor: "99" })

          const malformed = yield* feed(host, "sse-resume", "event=Said&after=abc", {
            authorization: token(),
          })

          expect(malformed.status).toBe(404)

          const sql = yield* SqlClient.SqlClient
          yield* sql`DELETE FROM actor_events WHERE tenant_id = ${room.ref.tenant}
            AND actor_type = ${room.ref.actor} AND actor_id = ${room.ref.id} AND sequence <= 2`.pipe(
            Effect.orDie,
          )

          const pruned = yield* feed(host, "sse-resume", "event=Said&after=1", {
            authorization: token(),
          })

          expect(pruned.status).toBe(410)
          expect(yield* cursorError(pruned.body)).toEqual({ tag: "RetentionGap", cursor: "1" })

          const kept = yield* feed(host, "sse-resume", "event=Said&after=2", {
            authorization: token(),
          })

          expect((yield* take(kept.messages, 2)).map((message) => message.id)).toEqual(["3", "4"])
        }),
      ),
  },
  {
    name: "answers a feed for a never-created actor with 404 NotCreated and writes no row, and refuses undeclared, missing, and too many event filters",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { host, token } = yield* setup(environment)
          const headers = { authorization: token() }
          const ref = (yield* FeedRoom.get("sse-nobody")).ref

          const missing = yield* feed(host, "sse-nobody", "event=Said", headers)
          expect(missing.status).toBe(404)
          expect(yield* feedReason(missing.body)).toMatchObject({ tag: "NotCreated" })
          expect(yield* rows(ref)).toEqual({ connections: 0, generations: 0 })

          yield* (yield* FeedRoom.get("sse-filters")).Tell("x")

          for (const query of ["event=Noted", "event=Nope", "after=0"]) {
            const refused = yield* feed(host, "sse-filters", query, headers)
            expect(refused.status).toBe(404)
            expect(yield* feedReason(refused.body)).toMatchObject({
              tag: "InvalidInput",
              code: "unknown_event",
            })
          }

          const many = Array.from({ length: 17 }, () => "event=Said").join("&")
          expect((yield* feed(host, "sse-filters", many, headers)).status).toBe(200)

          const distinct = Array.from({ length: 17 }, (_, index) => `event=E${index}`).join("&")
          const tooMany = yield* feed(host, "sse-filters", distinct, headers)
          expect(tooMany.status).toBe(400)
          expect(yield* feedReason(tooMany.body)).toMatchObject({ code: "too_many_filters" })

          const anonymous = yield* feed(host, "sse-filters", "event=Said", {})
          expect(anonymous.status).toBe(401)
        }),
      ),
  },
  {
    name: "authorizes a feed per event tag before reading, and revokes a live feed within reauthorizeEvery",
    timeoutMs: 40_000,
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const { host, token } = yield* setup(environment)
          const room = yield* FeedRoom.get("sse-revoke")
          yield* room.Tell("before")

          yield* Effect.gen(function* () {
            fixture.denied.add("Said")

            const refused = yield* feed(host, "sse-revoke", "event=Said", {
              authorization: token(),
            })

            expect(refused.status).toBe(403)
            expect(yield* feedReason(refused.body)).toMatchObject({
              tag: "Unauthorized",
              code: "access_denied",
            })
            fixture.denied.delete("Said")

            const live = yield* feed(host, "sse-revoke", "event=Said", { authorization: token() })
            expect(yield* textOf((yield* take(live.messages, 1))[0]!)).toBe("before")
            fixture.denied.add("Said")

            const [ended] = yield* take(live.messages, 1, 10_000)
            expect(ended!.event).toBe("end")
            expect(yield* feedReason(ended!.data)).toMatchObject({
              tag: "Unauthorized",
              code: "access_denied",
            })
          }).pipe(Effect.ensuring(Effect.sync(() => fixture.denied.delete("Said"))))
        }),
      ),
  },
  {
    name: "ends a feed at its credential's expiry with Unauthorized expired, and a reconnect from its last cursor loses nothing",
    timeoutMs: 40_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, host, token } = yield* setup(environment)
          const holder = (yield* InternalActors).holder
          const room = yield* FeedRoom.get("sse-expiry")
          yield* room.Tell("first")

          const expiring = `Bearer ${test.tenant}:alice:${(yield* holder.now) + 1_500}`
          const opened = yield* feed(host, "sse-expiry", "event=Said", { authorization: expiring })
          const [first] = yield* take(opened.messages, 1)

          const [ended] = yield* take(opened.messages, 1, 10_000)
          expect(ended!.event).toBe("end")
          expect(yield* feedReason(ended!.data)).toMatchObject({
            tag: "Unauthorized",
            code: "expired",
          })

          yield* room.Tell("while away")

          const again = yield* feed(host, "sse-expiry", "event=Said", {
            authorization: token(),
            "last-event-id": first!.id!,
          })

          expect(yield* textOf((yield* take(again.messages, 1))[0]!)).toBe("while away")
        }),
      ),
  },
  {
    name: "keeps an idle feed parked, and delivers an event committed by a command that woke its actor",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, host, token } = yield* setup(environment)
          const room = yield* FeedRoom.get("sse-parked")
          yield* room.Tell("before")
          const opened = yield* feed(host, "sse-parked", "event=Said", { authorization: token() })
          yield* take(opened.messages, 1)

          yield* test.hibernate(room.ref)
          yield* room.Tell("woken")
          expect(yield* textOf((yield* take(opened.messages, 1))[0]!)).toBe("woken")
        }),
      ),
  },
  {
    name: "catches a lagging feed up from actor_events instead of ending it with SlowConsumer",
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { host, token } = yield* setup(environment)
          const room = yield* FeedRoom.get("sse-lag")
          yield* room.Tell("first")
          const opened = yield* feed(host, "sse-lag", "event=Said", { authorization: token() })
          yield* take(opened.messages, 1)

          yield* room.Burst(1_100)

          const received = yield* take(opened.messages, 1_100)
          expect(received.map((message) => Number(message.id))).toEqual(
            Array.from({ length: 1_100 }, (_, index) => index + 2),
          )
          expect(received.every((message) => message.event === "Said")).toBe(true)
        }),
      ),
  },
  {
    name: "resyncs a feed at its holder after an owner kill with no client-visible gap",
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase

          const context = yield* Layer.build(
            ActorTest.cluster({
              database,
              runners: 2,
              shardLockExpiration: "3 seconds",
              actors: transportsLayer,
              as: User.make({ subject: "alice" }),
            }),
          )

          yield* Effect.gen(function* () {
            const cluster = yield* ActorCluster
            yield* cluster.ready
            let target: ActorRef | undefined

            for (let index = 0; target === undefined && index < 200; index++) {
              const candidate = (yield* cluster.on(0)(FeedRoom.get(`sse-crash-${index}`))).ref

              if ((yield* cluster.owner(candidate)) === 1) target = candidate
            }

            if (target === undefined)
              return yield* Effect.die(new Error("Runner 1 owns no probed actor"))

            const ref = target

            const tell = (text: string) =>
              cluster.on(0)(FeedRoom.get(ref.id).pipe(Effect.flatMap((room) => room.Tell(text))))

            yield* tell("before")
            const host = yield* cluster.on(0)(serveSockets(environment))

            const opened = yield* feed(host, ref.id, "event=Said", {
              authorization: `Bearer ${ref.tenant}:alice`,
            })

            expect(yield* textOf((yield* take(opened.messages, 1))[0]!)).toBe("before")

            yield* cluster.kill(1)
            yield* tell("after")

            const [next] = yield* take(opened.messages, 1, 60_000)
            expect(next!.id).toBe("2")
            expect(yield* textOf(next!)).toBe("after")
          }).pipe(Effect.provideContext(context))
        }),
      ),
  },
]
