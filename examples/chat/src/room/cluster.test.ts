import { BunCrypto } from "@effect/platform-bun"
import { Actor, ActorError, Actors } from "@durable-actors/core"
import {
  ActorCluster,
  ActorTest,
  type ClusterOptions,
  disposableDatabase,
} from "@durable-actors/core/testing"
import {
  Clock,
  Config,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Predicate,
  Schedule,
  Schema,
  Stream,
} from "effect"
import { afterAll, expect, it } from "vitest"
import { threeRunners } from "./cluster.ts"
import { Appeal, Digest, Presence, Room, RoomId, Thread } from "./contract.ts"
import { RoomJobs, RoomHandlers, RoomLive } from "./layer.ts"
import { ModerationApi, Moderators } from "./moderation.ts"

/** Moderator notifications per appealed message, across every runner. */
const notified = new Map<string, number>()

const CountingModerators = Layer.succeed(Moderators, {
  notify: (messageId) =>
    Effect.sync(() => {
      notified.set(messageId, (notified.get(messageId) ?? 0) + 1)
    }),
})

const actors = RoomLive.pipe(
  Layer.provide([
    Layer.succeed(ModerationApi, { check: (body) => Effect.succeed(body.includes("spam")) }),
    CountingModerators,
  ]),
)

const runtime = ManagedRuntime.make(BunCrypto.layer)

afterAll(() => runtime.dispose())

const freshDatabase = Effect.flatMap(Config.Redacted("TEST_DATABASE_URL"), (url) =>
  disposableDatabase({ url }),
)

type Cluster = Pick<
  ClusterOptions<never, never, Layer.Services<typeof actors>>,
  "actors" | "runnerActors" | "executors"
>

const onCluster = <A, E>(body: Effect.Effect<A, E, ActorCluster>, cluster: Cluster) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const context = yield* Layer.build(
        threeRunners({ ...cluster, database: yield* freshDatabase }),
      )

      return yield* body.pipe(Effect.provideContext(context))
    }).pipe(Effect.scoped, Effect.orDie),
  )

/**
 * Three runners need independent connections, so these cases skip on PGlite.
 */
const pglite = runtime.runSync(Config.String("TEST_BACKEND")) === "pglite"

const clusterCase = <A, E>(
  name: string,
  body: Effect.Effect<A, E, ActorCluster>,
  cluster: Cluster = { actors },
) => it.skipIf(pglite)(name, () => onCluster(body, cluster), 90_000)

const on = <A, E, R>(runner: number, effect: Effect.Effect<A, E, R>) =>
  ActorCluster.use((cluster) => cluster.on(runner)(effect))

/** Kills the runner owning `room` and returns a survivor once the others hold its shards. */
const killOwner = (room: typeof RoomId.Type) =>
  ActorCluster.use((cluster) =>
    Effect.gen(function* () {
      const ref = (yield* cluster.on(0)(Room.get(room))).ref
      const owner = (yield* cluster.owner(ref))!
      yield* cluster.kill(owner)
      yield* cluster.ready

      return (owner + 1) % cluster.runners
    }),
  )

const eventually = <E, R>(check: Effect.Effect<boolean, E, R>, what: string) =>
  check.pipe(
    Effect.repeat({ schedule: Schedule.spaced("25 millis"), until: (held) => held }),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.die(new Error(`Timed out waiting for ${what}`)),
    }),
    Effect.asVoid,
  )

/**
 * Command outputs carry ids as plain strings; handles take the branded id.
 */
const thread = (id: string) => Thread.get(id as Parameters<typeof Thread.get>[0])

clusterCase(
  "resumes an appeal on another runner and resolves it from the owner's event, through a runner kill",

  Effect.gen(function* () {
    const room = RoomId.make("appeals")

    const { messageId, executionId } = yield* on(
      0,
      Effect.gen(function* () {
        const handle = yield* Room.get(room)
        const messageId = yield* handle.Post({ body: "buy spam" })
        const run = yield* handle.Appeal({ messageId })
        yield* eventually(
          run.poll.pipe(
            Effect.map(
              (polled) => Option.isSome(polled) && Predicate.isTagged(polled.value, "Suspended"),
            ),
          ),
          "the appeal to wait for a decision",
        )

        return { messageId, executionId: run.executionId }
      }),
    )

    const survivor = yield* killOwner(room)

    const restored = yield* on(
      survivor,
      Effect.gen(function* () {
        const handle = yield* Room.get(room)
        yield* handle.DecideAppeal({ messageId: "another", restore: false })
        yield* handle.DecideAppeal({ messageId, restore: true })

        return yield* (yield* Room.run(Appeal, executionId)).result
      }),
    )

    expect(restored).toBe(true)
    expect(notified.get(messageId)).toBe(1)
  }),
)

clusterCase(
  "mints one thread per reply thread and replays its id after the room's runner is killed",

  Effect.gen(function* () {
    const room = RoomId.make("threads")

    const { commandId, id } = yield* on(
      0,
      Effect.gen(function* () {
        const handle = yield* Room.get(room)
        const messageId = yield* handle.Post({ body: "hello" })
        const commandId = yield* (yield* Actors).mintCommandId
        const id = yield* handle.StartThread({ messageId }).pipe(Actor.commandId(commandId))

        return { commandId, id }
      }),
    )

    const survivor = yield* killOwner(room)

    const replies = yield* on(
      survivor,
      Effect.gen(function* () {
        const test = yield* ActorTest
        const handle = yield* Room.get(room)

        const again = yield* handle
          .StartThread({ messageId: "ignored" })
          .pipe(Actor.commandId(commandId), Effect.flip)

        const child = yield* thread(id)

        yield* test.advance("40 seconds")

        yield* eventually(
          test.receiptsFor(child.ref, "Open").pipe(Effect.map((opened) => opened === 1)),
          "the thread to be created",
        )
        yield* child.Reply("first")

        return {
          again,
          count: yield* child.Reply("second"),
          opened: yield* test.receiptsFor(child.ref, "Open"),
          state: (yield* test.inspect(child.ref)).state,
        }
      }),
    )

    expect(Schema.is(ActorError)(replies.again)).toBe(true)
    expect(replies).toMatchObject({ count: 2, opened: 1, state: { room: "threads" } })
  }),
)

/** Moves the given runners' clocks one day in hourly steps, so each 08:00 tick fires inside its one-hour skip window. */
const aDay = (runners: ReadonlyArray<number>) =>
  Effect.forEach(
    Array.from({ length: 24 }),
    () =>
      Effect.forEach(
        runners,
        (runner) =>
          on(
            runner,
            ActorTest.use((test) => test.advance("1 hour")),
          ),
        { concurrency: "unbounded", discard: true },
      ),
    { discard: true },
  )

clusterCase(
  "runs one digest per day across three runners, through a runner kill",

  Effect.gen(function* () {
    const cluster = yield* ActorCluster
    yield* cluster.ready
    const ref = (yield* on(0, Digest.get())).ref

    const sent = (runner: number) =>
      on(
        runner,
        ActorTest.use((test) => test.receiptsFor(ref, "Send")),
      )

    yield* aDay([0, 1, 2])
    yield* eventually(sent(0).pipe(Effect.map((count) => count === 1)), "the first digest")

    const owner = (yield* cluster.owner(ref))!
    yield* cluster.kill(owner)
    yield* cluster.ready
    const survivors = [0, 1, 2].filter((runner) => runner !== owner)

    yield* aDay(survivors)
    yield* eventually(
      sent(survivors[0]!).pipe(Effect.map((count) => count === 2)),
      "the second digest",
    )

    yield* Effect.sleep("1 second")
    expect(yield* sent(survivors[1]!)).toBe(2)
    expect(
      (yield* on(
        survivors[0]!,
        ActorTest.use((test) => test.inspect(ref)),
      )).state,
    ).toMatchObject({ sent: 2 })
  }),
)

/** One moderation call as the provider saw it; `endedAt` stays unset while it runs. */
interface ModerationCall {
  readonly body: string
  readonly jobId: string
  readonly runner: number
  readonly startedAt: number
  endedAt?: number
}

const moderationCalls: Array<ModerationCall> = []

/** The most calls in `calls` that were running at the same moment. */
const mostInFlight = (calls: ReadonlyArray<ModerationCall>) =>
  Math.max(
    0,
    ...calls.map(
      ({ startedAt }) =>
        calls.filter(
          (call) => call.startedAt <= startedAt && (call.endedAt ?? Infinity) > startedAt,
        ).length,
    ),
  )

/**
 * Each runner gets its own provider, so a call records which runner made it.
 * The first call for "capped 0" never returns: it holds a slot until its
 * runner dies.
 */
const cappedProvider = (runner: number) =>
  Layer.succeed(ModerationApi, {
    check: (body, { idempotencyKey }) =>
      Effect.gen(function* () {
        const call: ModerationCall = {
          body,
          jobId: idempotencyKey,
          runner,
          startedAt: yield* Clock.currentTimeMillis,
        }

        const hangs = body === "capped 0" && !moderationCalls.some((seen) => seen.body === body)
        moderationCalls.push(call)

        yield* (hangs ? Effect.never : Effect.sleep("150 millis")).pipe(
          Effect.ensuring(
            Clock.currentTimeMillis.pipe(
              Effect.map((now) => {
                call.endedAt = now
              }),
            ),
          ),
        )

        return false
      }),
  })

/**
 * Long enough that a loaded machine's late renewal cannot lose the lease
 * before the kill.
 */
const CAP_LEASE_MS = 9_000

clusterCase(
  "holds each room to two moderation calls in flight across three runners (caps, #125)",

  Effect.gen(function* () {
    const cluster = yield* ActorCluster
    const room = RoomId.make("caps")

    const bodies = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, index) => `capped ${from + index}`)

    const post = (runner: number, posted: ReadonlyArray<string>) =>
      on(
        runner,
        Effect.gen(function* () {
          const handle = yield* Room.get(room)
          yield* Effect.forEach(posted, (body) => handle.Post({ body }), { discard: true })
        }),
      )

    const moderated = (runner: number, count: number) =>
      on(
        runner,
        ActorTest.use((test) =>
          Effect.gen(function* () {
            const ref = (yield* Room.get(room)).ref

            return (yield* test.receiptsFor(ref, "Moderated")) === count
          }),
        ),
      )

    yield* post(0, bodies(0, 4))
    yield* eventually(moderated(0, 3), "the first posts' moderation")

    const hung = moderationCalls.find((call) => call.body === "capped 0")!
    yield* cluster.kill(hung.runner)
    const killedAt = yield* Clock.currentTimeMillis
    yield* cluster.ready

    const survivor = (hung.runner + 1) % cluster.runners
    yield* post(survivor, bodies(4, 8))

    yield* eventually(moderated(survivor, 8), "every post's moderation to route")

    const retried = moderationCalls.filter((call) => call.jobId === hung.jobId)
    const afterKill = moderationCalls.filter((call) => call.startedAt >= killedAt)

    expect(mostInFlight(moderationCalls)).toBe(2)
    expect(new Set(moderationCalls.map(({ jobId }) => jobId)).size).toBe(8)
    expect(moderationCalls).toHaveLength(9)
    expect(retried.map(({ runner }) => runner === hung.runner)).toEqual([true, false])
    expect(mostInFlight(afterKill)).toBe(1)
    expect(retried[1]!.startedAt - killedAt).toBeGreaterThanOrEqual((CAP_LEASE_MS * 2) / 3)
  }),
  {
    actors: RoomHandlers.pipe(Layer.provide(CountingModerators)),
    runnerActors: (runner) => RoomJobs.pipe(Layer.provide(cappedProvider(runner))),
    executors: { lease: `${CAP_LEASE_MS} millis` },
  },
)

clusterCase(
  "wakes a parked room on another runner when a typing frame arrives",

  Effect.gen(function* () {
    const cluster = yield* ActorCluster
    const ref = (yield* on(0, Room.get(RoomId.make("presence")))).ref
    const owner = (yield* cluster.owner(ref))!

    const inspect = on(
      owner,
      ActorTest.use((test) => test.inspect(ref)),
    )

    const connect = (runner: number) =>
      on(
        runner,
        ActorTest.use((test) => test.connect(ref, Presence, undefined)),
      )

    const typist = yield* connect((owner + 1) % cluster.runners)
    const watcher = yield* connect((owner + 2) % cluster.runners)

    const parked = Number((yield* inspect).generation)
    yield* on(
      owner,
      ActorTest.use((test) => test.hibernate(ref)),
    )
    yield* typist.send({ typing: true })

    const [seen] = yield* watcher.frames.pipe(
      Stream.take(1),
      Stream.runCollect,
      Effect.timeout("30 seconds"),
      Effect.orDie,
    )

    expect(seen).toEqual({ user: "ada", typing: true })
    expect(Number((yield* inspect).generation)).toBeGreaterThan(parked)
    expect(yield* cluster.owner(ref)).toBe(owner)

    yield* typist.close
    yield* watcher.close
  }),
)
