import { Cause, Effect, Exit, Fiber, Layer, Option, Schema, Scope, Stream } from "effect"
import { Actor } from "../../../../packages/akter/src/index.ts"
import {
  ActorError,
  RunnerAtCapacity,
  SessionEnded,
  Unauthorized,
} from "../../../../packages/akter/src/errors/actor.ts"
import { RetentionGap, UnknownCursor } from "../../../../packages/akter/src/errors/events.ts"
import type { ActorRef } from "../../../../packages/akter/src/identity/caller.ts"
import { ActorTest } from "../../../../packages/akter/src/testing/actor-test.ts"
import { clusterLayer, ActorCluster } from "../cluster.ts"
import type { ConformanceCase, ConformanceEnvironment, ConformanceSuite } from "../conformance.ts"

const Noted = Actor.event("Noted", { text: Schema.String })

class Entry extends Schema.TaggedClass<Entry>()("Entry", {
  cursor: Schema.String,
  text: Schema.String,
}) {}

const Note = Actor.command("Note", { payload: Schema.String })

/** Committed notes after `after`, then each new one as it commits. */
const Notes = Actor.stream("Notes", {
  payload: Schema.Struct({ after: Schema.optional(Schema.String) }),
  success: Entry,
  error: Schema.Union([UnknownCursor, RetentionGap]),
})

/** Emits `count` elements, then ends by itself. */
const Count = Actor.stream("Count", { payload: Schema.Finite, success: Schema.Finite })

/** Emits forever, as fast as the subscriber takes it. */
const Flood = Actor.stream("Flood", { success: Schema.Finite })

const Journal = Actor.make("StreamJournal", {
  key: Schema.String,
  events: [Noted],
  api: { Note, Notes, Count, Flood },
  policy: { hibernateAfter: "1 second" },
})

export const streamsLayer = Journal.toLayer(
  Effect.succeed({
    Note: Effect.fnUntraced(function* (text: string) {
      const turn = yield* Journal.Turn
      yield* turn.emit(Noted.make({ text }))
    }),
    Notes: ({ after }: { readonly after?: string | undefined }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const read = yield* Journal.Read

          return read
            .follow(Noted, { after })
            .pipe(
              Stream.map((entry) => Entry.make({ cursor: entry.cursor, text: entry.event.text })),
            )
        }),
      ),
    Count: (count: number) => Stream.range(1, count),
    Flood: () => Stream.iterate(0, (index) => index + 1),
  }),
)

const WAIT = "20 seconds"

const take = <A, E>(stream: Stream.Stream<A, E>, count: number) =>
  stream.pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.map((chunk): ReadonlyArray<A> => [...chunk]),
    Effect.timeoutOrElse({
      duration: WAIT,
      orElse: () => Effect.die(new Error("No stream element arrived")),
    }),
  )

/** The error a subscription ended with, after draining it. */
const endOf = <A, E>(stream: Stream.Stream<A, E>) =>
  stream.pipe(
    Stream.runDrain,
    Effect.exit,
    Effect.timeoutOrElse({
      duration: WAIT,
      orElse: () => Effect.die(new Error("The stream did not end")),
    }),
    Effect.map((exit) =>
      Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined,
    ),
  )

const reasonOf = (error: ActorError | UnknownCursor | RetentionGap | Cause.Done | undefined) =>
  Schema.is(ActorError)(error) ? error.reason : undefined

/** A running subscription whose elements arrive in order on `next`. */
const open = <A, E>(stream: Stream.Stream<A, E>) =>
  Effect.gen(function* () {
    const pull = yield* Stream.toPull(stream)

    return {
      next: pull.pipe(
        Effect.map((chunk) => [...chunk]),
        Effect.timeoutOrElse({
          duration: WAIT,
          orElse: () => Effect.die(new Error("No stream element arrived")),
        }),
      ),
    }
  })

/** Reads `count` elements from a pull, however they are chunked. */
const read = <A, X>(pull: { readonly next: Effect.Effect<ReadonlyArray<A>, X> }, count: number) =>
  Effect.gen(function* () {
    const read: Array<A> = []

    while (read.length < count) read.push(...(yield* pull.next))

    return read
  })

const texts = (entries: ReadonlyArray<Entry>) => entries.map((entry) => entry.text)

const EXPIRATION_SECONDS = 3

const withCluster = <A, E>(
  environment: ConformanceEnvironment,
  runners: number,
  body: Effect.Effect<A, E, ActorCluster | Scope.Scope>,
) =>
  environment.run(
    Effect.gen(function* () {
      const database = yield* environment.freshDatabase

      const context = yield* Layer.build(
        clusterLayer({
          database,
          runners,
          shardLockExpiration: `${EXPIRATION_SECONDS} seconds`,
          actors: streamsLayer,
        }),
      )

      return yield* body.pipe(Effect.scoped, Effect.provideContext(context))
    }),
  )

/** An actor id that `runner` owns, probed through runner 0. */
const ownedBy = (runner: number, prefix: string) =>
  Effect.gen(function* () {
    const cluster = yield* ActorCluster

    for (let index = 0; index < 200; index++) {
      const candidate: ActorRef = (yield* cluster.on(0)(Journal.get(`${prefix}-${index}`))).ref

      if ((yield* cluster.owner(candidate)) === runner) return candidate
    }

    return yield* Effect.die(new Error(`Runner ${runner} owns no probed actor`))
  })

/** Stream cases: follows from a cursor have no gap or repeat, refuse unknown cursors, and complete when the handler's stream ends. */
export const streamsConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "follows events from a cursor with no gap or repeat between replay and live",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const journal = yield* Journal.get("streams-follow")
          yield* journal.Note("one")
          yield* journal.Note("two")
          yield* journal.Note("three")

          const [first] = yield* take(journal.Notes({}), 1)
          expect(first?.text).toBe("one")

          const pull = yield* open(journal.Notes({ after: first!.cursor }))
          const replayed = yield* read(pull, 2)

          const writer = yield* Effect.forEach(["four", "five", "six"], journal.Note, {
            discard: true,
          }).pipe(Effect.forkChild)

          const live = yield* read(pull, 3)
          yield* Fiber.join(writer)

          const entries = [...replayed, ...live]
          expect(texts(entries)).toEqual(["two", "three", "four", "five", "six"])
          const cursors = entries.map((entry) => BigInt(entry.cursor))
          expect(
            cursors.every((cursor, index) => index === 0 || cursor > cursors[index - 1]!),
          ).toBe(true)
        }),
      ),
  },
  {
    name: "fails a follow from a cursor the actor never issued with its declared UnknownCursor",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const journal = yield* Journal.get("streams-unknown")
          yield* journal.Note("one")
          expect(yield* endOf(journal.Notes({ after: "99" }))).toMatchObject(
            UnknownCursor.make({ cursor: "99" }),
          )
        }),
      ),
  },
  {
    name: "completes a subscription whose handler's stream ends by itself",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const journal = yield* Journal.get("streams-count")
          const counted = yield* journal.Count(3).pipe(Stream.runCollect, Effect.timeout(WAIT))
          expect([...counted]).toEqual([1, 2, 3])
        }),
      ),
  },
  {
    name: "ends a stream with ActivationEnded when its activation stops, and keeps the activation resident while subscribed",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const journal = yield* Journal.get("streams-resident")
          yield* journal.Note("one")
          const seen: Array<Entry> = []

          const ending = yield* journal.Notes({}).pipe(
            Stream.tap((entry) => Effect.sync(() => seen.push(entry))),
            endOf,
            Effect.forkChild,
          )

          yield* Effect.sleep("100 millis").pipe(
            Effect.repeat({ until: () => seen.length === 1 }),
            Effect.timeout(WAIT),
          )
          const generation = (yield* test.inspect(journal.ref)).generation

          yield* Effect.sleep("3500 millis")
          yield* journal.Note("two")
          yield* Effect.sleep("100 millis").pipe(
            Effect.repeat({ until: () => seen.length === 2 }),
            Effect.timeout(WAIT),
          )
          expect((yield* test.inspect(journal.ref)).generation).toBe(generation)

          yield* test.hibernate(journal.ref)
          const reason = reasonOf(yield* Fiber.join(ending))
          expect(Schema.is(SessionEnded)(reason)).toBe(true)
          expect(reason).toMatchObject({ cause: "ActivationEnded", resync: false })
          expect(Schema.is(SessionEnded)(reason) && reason.isRetryable).toBe(true)

          yield* journal.Note("three")
          const [resumed] = yield* take(journal.Notes({ after: seen.at(-1)!.cursor }), 1)
          expect(resumed?.text).toBe("three")
        }),
      ),
  },
  {
    name: "rejects a subscription its caller may not open, and ends one whose reauthorization is denied",
    run: ({ expect, environment, access }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const journal = yield* Journal.get("streams-revoked")

          access.allowed = false

          const refused = yield* endOf(journal.Count(1)).pipe(
            Effect.ensuring(Effect.sync(() => (access.allowed = true))),
          )

          expect(reasonOf(refused)).toMatchObject(Unauthorized.make({ code: "access_denied" }))

          const pull = yield* open(journal.Flood())
          yield* read(pull, 1)
          access.allowed = false
          yield* test.advance("55 seconds")

          const revoked = yield* Effect.gen(function* () {
            for (;;) yield* pull.next
          }).pipe(
            Effect.flip,
            Effect.timeout(WAIT),
            Effect.ensuring(Effect.sync(() => (access.allowed = true))),
          )

          expect(revoked).toMatchObject({ reason: Unauthorized.make({ code: "access_denied" }) })
        }),
      ),
  },
  {
    name: "ends a subscription with reauthorization_unavailable at its bound",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const journal = yield* Journal.get("streams-bound")
          const pull = yield* open(journal.Notes({}))
          yield* journal.Note("one")
          yield* read(pull, 1)
          yield* test.advance("61 seconds")

          const lapsed = yield* Effect.gen(function* () {
            for (;;) yield* pull.next
          }).pipe(Effect.flip, Effect.timeout(WAIT))

          expect(lapsed).toMatchObject({
            reason: Unauthorized.make({ code: "reauthorization_unavailable" }),
          })
        }),
      ),
  },
  {
    name: "ends a stream with SlowConsumer after its window stays full for 30 seconds",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const journal = yield* Journal.get("streams-slow")
          const pull = yield* open(journal.Flood())
          yield* read(pull, 1)
          yield* Effect.sleep("1 second")
          yield* test.advance("31 seconds")
          yield* Effect.sleep("500 millis")

          const slow = yield* Effect.gen(function* () {
            for (;;) yield* pull.next
          }).pipe(Effect.flip, Effect.timeout(WAIT))

          expect(reasonOf(slow)).toMatchObject({ cause: "SlowConsumer", resync: true })
        }),
      ),
  },
  {
    name: "refuses a subscription past 256 open on one actor with RunnerAtCapacity",
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const journal = yield* Journal.get("streams-limit")

          const opened = yield* Effect.forEach(
            Array.from({ length: 260 }),
            () => Effect.flatMap(open(journal.Flood()), (pull) => read(pull, 1)).pipe(Effect.exit),
            { concurrency: "unbounded" },
          )

          const refused = opened.filter(Exit.isFailure)

          expect(opened.filter(Exit.isSuccess).length).toBe(256)
          expect(refused.length).toBe(4)
          expect(
            refused.map((exit) =>
              reasonOf(Option.getOrUndefined(Cause.findErrorOption(exit.cause))),
            ),
          ).toEqual(Array.from({ length: 4 }, () => RunnerAtCapacity.make({})))
          expect(reasonOf(yield* endOf(journal.Count(1)))).toMatchObject(RunnerAtCapacity.make({}))
        }),
      ),
  },
  {
    name: "delivers a stream from an owner on another runner and ends it with ActivationEnded when that runner is killed",
    requiresFreshDatabase: true,
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment }) =>
      withCluster(
        environment,
        2,
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          yield* cluster.ready
          const ref = yield* ownedBy(1, "streams-kill")
          const journal = yield* cluster.on(0)(Journal.get(ref.id))

          const pull = yield* journal.Notes({}).pipe(open, cluster.on(0))
          yield* cluster.on(0)(journal.Note("before"))
          const [before] = yield* read(pull, 1)
          expect(before?.text).toBe("before")

          yield* cluster.kill(1)

          const lost = yield* Effect.gen(function* () {
            for (;;) yield* pull.next
          }).pipe(Effect.flip, Effect.timeout(WAIT))

          expect(reasonOf(lost)).toMatchObject({ cause: "ActivationEnded" })

          yield* cluster.on(0)(journal.Note("after"))
          const [after] = yield* cluster.on(0)(take(journal.Notes({ after: before!.cursor }), 1))
          expect(after?.text).toBe("after")
          expect(yield* cluster.owner(ref)).toBe(0)
        }),
      ),
  },
  {
    name: "keeps cursor order in a followed stream written through turns on different runners over time",
    requiresFreshDatabase: true,
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment }) =>
      withCluster(
        environment,
        3,
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          yield* cluster.ready
          const ref = yield* ownedBy(1, "streams-order")
          const written: Array<string> = []

          const note = (via: number) => (text: string) =>
            Effect.andThen(
              cluster.on(via)(Journal.get(ref.id).pipe(Effect.flatMap((j) => j.Note(text)))),
              Effect.sync(() => written.push(text)),
            )

          yield* Effect.forEach(["a1", "a2", "a3"], note(0), { discard: true })
          yield* cluster.kill(1)
          yield* Effect.forEach(["b1", "b2", "b3"], note(0), { discard: true })
          const second = (yield* cluster.owner(ref))!
          const survivor = second === 0 ? 2 : 0
          yield* cluster.kill(second)
          yield* Effect.forEach(["c1", "c2", "c3"], note(survivor), { discard: true })
          expect(yield* cluster.owner(ref)).toBe(survivor)

          const followed = yield* cluster.on(survivor)(
            Journal.get(ref.id).pipe(Effect.flatMap((j) => take(j.Notes({}), written.length))),
          )

          expect(texts(followed)).toEqual(written)

          const cursors = followed.map((entry) => BigInt(entry.cursor))
          expect(cursors).toEqual(cursors.map((_, index) => BigInt(index + 1)))
        }),
      ),
  },
]

/** The stream actor. */
export const streamsSuite: ConformanceSuite = {
  layer: () => streamsLayer,
}
