import { BunCrypto } from "@effect/platform-bun"
import { Actor, ActorError, Actors, User } from "@durable-actors/core"
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
} from "effect"
import { Pool } from "pg"
import { afterAll, expect, it } from "vitest"
import { Appeal, Room, RoomId, Thread } from "./contract.ts"
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
      const context = yield* Layer.build(
        ActorTest.cluster({
          database: yield* freshDatabase,
          runners: 3,
          shardLockExpiration: "3 seconds",
          actors,
          as: User.make({ subject: "ada" }),
        }),
      )

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

it.todo("runs one digest per day across three runners, through a runner kill (cron, #132)")

it.todo("holds each room to two moderation calls in flight across three runners (caps, #125)")

it.todo("wakes a parked room on another runner when a typing frame arrives (connections, M2.10)")
