import { BunCrypto } from "@effect/platform-bun"
import { Actor, ActorError, Actors } from "@durable-actors/core"
import { ActorCluster, ActorTest } from "@durable-actors/core/testing"
import {
  Config,
  Crypto,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Predicate,
  Redacted,
  Schedule,
  Schema,
  Stream,
} from "effect"
import { Pool } from "pg"
import { afterAll, expect, it } from "vitest"
import { threeRunners } from "./cluster.ts"
import { Appeal, Digest, Presence, Room, RoomId, Thread } from "./contract.ts"
import { RoomLive } from "./layer.ts"
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

const freshDatabase = Effect.gen(function* () {
  const base = new URL(yield* Config.String("TEST_DATABASE_URL"))
  const name = `chat_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

  const admin = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: base.href })),
    (pool) => Effect.promise(() => pool.end()),
  )

  yield* Effect.acquireRelease(
    Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
    () => Effect.promise(() => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)),
  )
  base.pathname = `/${name}`

  return Redacted.make(base.href)
})

const onCluster = <A, E>(body: Effect.Effect<A, E, ActorCluster>) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const context = yield* Layer.build(threeRunners({ database: yield* freshDatabase, actors }))

      return yield* body.pipe(Effect.provideContext(context))
    }).pipe(Effect.scoped, Effect.orDie),
  )

// Three runners need independent connections, so these cases skip on PGlite.
const pglite = runtime.runSync(Config.String("CHAT_BACKEND")) === "pglite"

const clusterCase = <A, E>(name: string, body: Effect.Effect<A, E, ActorCluster>) =>
  it.skipIf(pglite)(name, () => onCluster(body), 90_000)

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

// Command outputs carry ids as plain strings; handles take the branded id.
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

        // The killed runner's relay may hold a claim on the creating intent until it lapses.
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

    // A retry with another payload under the same id is a conflict, never a second thread.
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

    // One per day, never two: a short settle would reveal a duplicate tick.
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

it.todo("holds each room to two moderation calls in flight across three runners (caps, #125)")

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

    // Neither member is held by the room's owner, and each by a different runner.
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

    // The name comes from the session stored at open, so the woken room read it back.
    expect(seen).toEqual({ user: "ada", typing: true })
    expect(Number((yield* inspect).generation)).toBeGreaterThan(parked)
    expect(yield* cluster.owner(ref)).toBe(owner)

    yield* typist.close
    yield* watcher.close
  }),
)
