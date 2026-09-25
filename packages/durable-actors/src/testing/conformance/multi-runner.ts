import { Effect, Fiber, Layer, Schedule, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor, User } from "../../index.ts"
import { InternalActors } from "../../handles/actors.ts"
import type { ActorRef } from "../../identity/caller.ts"
import { ActorTest } from "../actor-test.ts"
import { ActorCluster } from "../cluster.ts"
import type { ConformanceCase, ConformanceEnvironment } from "../conformance.ts"

class Tallied extends Actor.Event<Tallied>()("Tallied", { amount: Schema.Finite }) {}

const Add = Actor.command("Add", { input: Schema.Finite, output: Schema.Finite })

const Log = Actor.query("Log", {
  output: Schema.Array(Schema.Struct({ cursor: Schema.String, commandId: Schema.String })),
})

const Tally = Actor.make("Tally", {
  key: Schema.String,
  state: Actor.state({ count: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  events: [Tallied],
  api: { Add, Log },
})

const TallyLive = Layer.mergeAll(
  Tally.toLayer(
    Effect.succeed({
      Add: Effect.fnUntraced(function* (amount: number) {
        const turn = yield* Tally.Turn
        yield* turn.state.set({ count: turn.state.count + amount })
        yield* turn.emit(Tallied.make({ amount }))

        return turn.state.count
      }),
    }),
  ),
  Tally.toQueryLayer(
    Effect.succeed({
      Log: Effect.fnUntraced(function* () {
        const entries = yield* (yield* Tally.Read).events(Tallied)

        return entries.map(({ cursor, commandId }) => ({ cursor, commandId }))
      }, Effect.orDie),
    }),
  ),
)

const EXPIRATION_SECONDS = 3

/** Builds a fresh database and a cluster of `runners` on it for one case. */
const withCluster = <A, E>(
  environment: ConformanceEnvironment,
  runners: number,
  body: Effect.Effect<A, E, ActorCluster>,
) =>
  environment.run(
    Effect.gen(function* () {
      const database = yield* environment.freshDatabase
      const context = yield* Layer.build(
        ActorTest.cluster({
          database,
          runners,
          shardLockExpiration: `${EXPIRATION_SECONDS} seconds`,
          actors: TallyLive,
          as: User.make({ subject: "alice" }),
        }),
      )

      return yield* body.pipe(Effect.provideContext(context))
    }),
  )

const add = (runner: number, id: string, amount: number) =>
  Effect.gen(function* () {
    const cluster = yield* ActorCluster

    return yield* cluster.on(runner)(Tally.get(id).pipe(Effect.flatMap((tally) => tally.Add(amount))))
  })

const refOf = (id: string) =>
  Effect.gen(function* () {
    const cluster = yield* ActorCluster

    return (yield* cluster.on(0)(Tally.get(id))).ref
  })

const inspect = (runner: number, ref: ActorRef) =>
  Effect.gen(function* () {
    const cluster = yield* ActorCluster

    return yield* cluster.on(runner)(ActorTest.use((test) => test.inspect(ref)))
  })

/** Polls until `ref`'s shard lock is held by a runner that `accept`s it. */
const awaitOwner = (ref: ActorRef, accept: (owner: number | undefined) => boolean) =>
  Effect.gen(function* () {
    const cluster = yield* ActorCluster

    return yield* cluster.owner(ref).pipe(
      Effect.repeat({ schedule: Schedule.spaced("25 millis"), until: accept }),
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () => Effect.die(new Error("The actor's shard did not move")),
      }),
    )
  })

/** A shard lock row with database-clock times in epoch milliseconds. */
const lockOf = (runner: number, ref: ActorRef) =>
  Effect.gen(function* () {
    const cluster = yield* ActorCluster

    return yield* cluster.on(runner)(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const shard = yield* (yield* InternalActors).shardId(ref)

        const [row] = yield* sql<{ address: string; acquired: number; now: number }>`
          SELECT address,
            (EXTRACT(EPOCH FROM acquired_at) * 1000)::float8 AS acquired,
            (EXTRACT(EPOCH FROM LOCALTIMESTAMP) * 1000)::float8 AS now
          FROM cluster_locks WHERE shard_id = ${shard}`.pipe(Effect.orDie)

        return row!
      }),
    )
  })

export const multiRunnerConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "places each actor on exactly one of three runners, reachable through every runner",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withCluster(
        environment,
        3,
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          const ids = Array.from({ length: 24 }, (_, index) => `spread-${index}`)
          const owners = new Set<number>()

          for (const id of ids) {
            for (let runner = 0; runner < 3; runner++) yield* add(runner, id, 1)

            const owner = yield* cluster.owner(yield* refOf(id))
            expect(owner === undefined).toBe(false)
            owners.add(owner!)
          }

          expect(owners.size > 1).toBe(true)

          for (const id of ids)
            expect(yield* inspect(1, yield* refOf(id))).toMatchObject({
              state: { count: 3 },
              receipts: 3,
              events: 3,
            })
        }),
      ),
  },
  {
    name: "rolls back a killed runner's paused turn and retries it once on the next owner after lock expiry",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withCluster(
        environment,
        3,
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          const ref = yield* refOf("paused")
          const owner = (yield* cluster.owner(ref))!
          const caller = (owner + 1) % 3
          expect(yield* add(caller, "paused", 1)).toBe(1)

          const pause = yield* cluster.on(owner)(ActorTest.use((test) => test.pauseNext("beforeCommit")))
          const retried = yield* add(caller, "paused", 2).pipe(Effect.forkChild)
          yield* pause.reached

          const held = (yield* lockOf(caller, ref))
          const killed = (yield* lockOf(caller, ref)).now
          yield* cluster.kill(owner)
          yield* pause.release

          // Runner loss before COMMIT leaves no receipt, state, or event.
          expect(yield* inspect(caller, ref)).toMatchObject({
            state: { count: 1 },
            receipts: 1,
            events: 1,
          })

          // Polled well inside the refresh interval, the first row under a new
          // address still carries the survivor's acquisition time.
          const taken = yield* lockOf(caller, ref).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("10 millis"),
              until: (lock) => lock.address !== held.address,
            }),
          )
          const next = (yield* cluster.owner(ref))!
          expect(next === owner).toBe(false)
          // No survivor takes the shard while the dead runner's lock is live.
          expect(taken.acquired - held.acquired >= EXPIRATION_SECONDS * 1000).toBe(true)

          expect(yield* Fiber.join(retried)).toBe(3)
          const resumed = (yield* lockOf(next, ref)).now
          expect(resumed >= taken.acquired && taken.acquired >= killed).toBe(true)

          expect(yield* inspect(next, ref)).toMatchObject({
            state: { count: 3 },
            receipts: 2,
            events: 2,
          })
          expect(yield* cluster.on(next)(ActorTest.use((test) => test.receiptsFor(ref, "Add")))).toBe(2)
        }),
      ),
  },
  {
    name: "fails a stale activation's fence once another runner commits for the actor, then reloads",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withCluster(
        environment,
        2,
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          const ref = yield* refOf("stale")
          const stale = (yield* cluster.owner(ref))!
          const rival = 1 - stale
          expect(yield* add(stale, "stale", 1)).toBe(1)
          const first = Number((yield* inspect(rival, ref)).generation)

          // The paused runner keeps its activation and still routes the actor
          // to itself; the rival takes the shard once the locks expire.
          const heartbeat = yield* cluster.pauseHeartbeat(stale)
          yield* awaitOwner(ref, (current) => current === rival)
          expect(yield* add(rival, "stale", 10)).toBe(11)

          // A commit from the stale cache would answer 101 and lose the rival's turn.
          expect(yield* add(stale, "stale", 100)).toBe(111)
          yield* heartbeat.resume

          const inspection = yield* inspect(rival, ref)
          expect(inspection).toMatchObject({ state: { count: 111 }, receipts: 3, events: 3 })
          expect(Number(inspection.generation) >= first + 2).toBe(true)
        }),
      ),
  },
  {
    name: "orders events gap-free when two real runners race for one actor",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment }) =>
      withCluster(
        environment,
        2,
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          const ref = yield* refOf("raced")
          const paused = (yield* cluster.owner(ref))!
          const rival = 1 - paused
          yield* add(paused, "raced", 1)
          const first = Number((yield* inspect(rival, ref)).generation)

          const heartbeat = yield* cluster.pauseHeartbeat(paused)
          yield* awaitOwner(ref, (current) => current === rival)

          yield* Effect.forEach(
            Array.from({ length: 24 }, (_, index) => index),
            (index) => add(index % 2 === 0 ? paused : rival, "raced", 1),
            { concurrency: 8, discard: true },
          )
          yield* heartbeat.resume

          const log = yield* cluster.on(rival)(Tally.get("raced").pipe(Effect.flatMap((tally) => tally.Log())))
          expect(log.map(({ cursor }) => cursor)).toEqual(
            Array.from({ length: 25 }, (_, index) => String(index + 1)),
          )
          expect(new Set(log.map(({ commandId }) => commandId)).size).toBe(25)

          const inspection = yield* inspect(rival, ref)
          expect(inspection).toMatchObject({ state: { count: 25 }, receipts: 25, events: 25 })
          // The runners took authority from each other at least once each way.
          expect(Number(inspection.generation) >= first + 2).toBe(true)
        }),
      ),
  },
  {
    name: "restarts a killed runner, which serves its shards again",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withCluster(
        environment,
        2,
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          const ref = yield* refOf("restart")
          const owner = (yield* cluster.owner(ref))!
          const other = 1 - owner
          expect(yield* add(other, "restart", 1)).toBe(1)

          yield* cluster.kill(owner)
          expect(yield* add(other, "restart", 1)).toBe(2)
          expect(yield* cluster.owner(ref)).toBe(other)

          // The restarted runner is a new process under a new address, so the
          // shards it is assigned now need not be the ones it held before.
          yield* cluster.restart(owner)
          yield* cluster.ready
          expect((yield* cluster.owner(ref)) === undefined).toBe(false)
          expect(yield* add(owner, "restart", 1)).toBe(3)
          expect(yield* add(other, "restart", 1)).toBe(4)
          expect(yield* inspect(owner, ref)).toMatchObject({ state: { count: 4 }, receipts: 4 })
        }),
      ),
  },
]
