import { Effect, Fiber, Layer, Result, Schedule, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor, Actors, User } from "../../index.ts"
import { InternalActors } from "../../handles/actors.ts"
import type { ActorRef } from "../../identity/caller.ts"
import { ActorTest } from "../actor-test.ts"
import { ActorCluster } from "../cluster.ts"
import type { ConformanceCase, ConformanceEnvironment, ConformanceExpect } from "../conformance.ts"

class Tallied extends Actor.Event<Tallied>()("Tallied", { amount: Schema.Finite }) {}

const Add = Actor.command("Add", { input: Schema.Finite, output: Schema.Finite })

const Whoami = Actor.command("Whoami", { output: Schema.String })

const Log = Actor.query("Log", {
  output: Schema.Array(Schema.Struct({ cursor: Schema.String, commandId: Schema.String })),
})

const TallyState = Actor.state({
  count: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
})

const tickReductions = { count: 0 }

/** A commutative reducer: calls already waiting on the owner merge into one turn. */
export const Tick = Actor.reducer("Tick", {
  state: TallyState,
  input: Schema.Finite,
  reduce: (state, amount) => {
    tickReductions.count += 1

    return Result.succeed({ count: state.count + amount })
  },
  commutative: { combine: (first, second) => first + second },
})

const Tally = Actor.make("Tally", {
  key: Schema.String,
  state: TallyState,
  events: [Tallied],
  api: { Add, Whoami, Log, Tick },
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
      Whoami: Effect.fnUntraced(function* () {
        const turn = yield* Tally.Turn

        return Schema.is(User)(turn.caller) ? turn.caller.subject : turn.caller._tag
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
        }),
      )

      return yield* body.pipe(Effect.provideContext(context))
    }),
  )

const add = (runner: number, id: string, amount: number) =>
  Effect.gen(function* () {
    const cluster = yield* ActorCluster

    return yield* cluster.on(runner)(
      Tally.get(id).pipe(Effect.flatMap((tally) => tally.Add(amount))),
    )
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

/**
 * Kills an actor's owner while a command from another runner is paused at
 * `point` on it, then checks that no survivor took the shard before the dead
 * runner's lock expired and that the caller's in-flight command, under its
 * original id, committed exactly once.
 */
const killDuringTurn = (expect: ConformanceExpect, point: "beforeCommit" | "afterCommit") =>
  Effect.gen(function* () {
    const cluster = yield* ActorCluster
    const id = `killed-${point}`
    const ref = yield* refOf(id)
    const owner = (yield* cluster.owner(ref))!
    const caller = (owner + 1) % 3
    expect(yield* add(caller, id, 1)).toBe(1)

    const commandId = yield* cluster.on(caller)(
      Effect.gen(function* () {
        return yield* (yield* Actors).mintCommandId
      }),
    )

    const pause = yield* cluster.on(owner)(ActorTest.use((test) => test.pauseNext(point)))

    const retried = yield* cluster
      .on(caller)(
        Tally.get(id).pipe(
          Effect.flatMap((tally) => tally.Add(2).pipe(Actor.commandId(commandId))),
        ),
      )
      .pipe(Effect.forkChild)

    yield* pause.reached
    const killed = (yield* lockOf(caller, ref)).now
    yield* cluster.kill(owner)
    const held = yield* lockOf(caller, ref)
    yield* pause.release

    expect(yield* inspect(caller, ref)).toMatchObject(
      point === "beforeCommit"
        ? { state: { count: 1 }, receipts: 1, events: 1 }
        : { state: { count: 3 }, receipts: 2, events: 2 },
    )

    const taken = yield* lockOf(caller, ref).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("10 millis"),
        until: (lock) => lock.address !== held.address,
      }),
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () => Effect.die(new Error("No survivor took the dead runner's shard")),
      }),
    )

    const next = (yield* cluster.owner(ref))!
    expect(next === owner).toBe(false)
    expect(taken.acquired - held.acquired >= EXPIRATION_SECONDS * 1000).toBe(true)

    expect(yield* Fiber.join(retried)).toBe(3)
    const resumed = (yield* lockOf(next, ref)).now
    expect(resumed >= taken.acquired && taken.acquired >= killed).toBe(true)

    expect(yield* inspect(next, ref)).toMatchObject({
      state: { count: 3 },
      receipts: 2,
      events: 2,
    })
    const log = yield* cluster.on(next)(Tally.get(id).pipe(Effect.flatMap((tally) => tally.Log())))
    expect(log.map((entry) => entry.commandId).filter((entry) => entry === commandId).length).toBe(
      1,
    )
  })

/** Multi-runner cases on three runners: placement on exactly one runner, merging of commutative calls into one turn, and retry on the next owner after a kill. */
export const multiRunnerConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "merges commutative calls from three runners on the owner into one turn with one receipt per command id",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withCluster(
        environment,
        3,
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          const id = "merged-ticks"
          const ref = yield* refOf(id)
          expect(yield* add(0, id, 1)).toBe(1)
          const owner = (yield* cluster.owner(ref))!
          const onOwner = cluster.on(owner)

          const held = yield* onOwner(ActorTest.use((test) => test.pauseNext("beforeCommit")))
          const first = yield* add((owner + 1) % 3, id, 1).pipe(Effect.forkChild)
          yield* held.reached

          const calls: Array<{ readonly runner: number; readonly commandId: string }> = []
          const ticks = []

          for (let runner = 0; runner < 3; runner++)
            for (let call = 0; call < 4; call++) {
              const commandId = yield* cluster.on(runner)(
                Effect.gen(function* () {
                  return yield* (yield* Actors).mintCommandId
                }),
              )

              const queued = yield* onOwner(ActorTest.use((test) => test.pauseNext("queued")))

              ticks.push(
                yield* cluster
                  .on(runner)(
                    Tally.get(id).pipe(
                      Effect.flatMap((tally) => tally.Tick(1).pipe(Actor.commandId(commandId))),
                    ),
                  )
                  .pipe(Effect.forkChild),
              )

              yield* queued.reached
              yield* queued.release
              yield* Effect.yieldNow
              calls.push({ runner, commandId })
            }

          const before = tickReductions.count
          yield* held.release
          expect(yield* Fiber.join(first)).toBe(2)
          expect(yield* Effect.forEach(ticks, Fiber.join)).toEqual(calls.map(() => undefined))

          expect(tickReductions.count - before).toBe(1)

          const receipts = yield* cluster.on(owner)(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient

              return yield* sql<{ command_id: string; tx: string }>`
                SELECT command_id, xmin::text AS tx FROM actor_receipts
                WHERE tenant_id = ${ref.tenant} AND actor_type = 'Tally' AND actor_id = ${ref.id}
                  AND command = 'Tick'`
            }).pipe(Effect.orDie),
          )

          expect(receipts.map((row) => row.command_id).sort()).toEqual(
            calls.map((call) => call.commandId).sort(),
          )
          expect(new Set(receipts.map((row) => row.tx)).size).toBe(1)
          expect(yield* inspect((owner + 2) % 3, ref)).toMatchObject({
            state: { count: 14 },
            receipts: 14,
          })

          const retried = calls[5]!
          expect(
            yield* cluster.on((retried.runner + 1) % 3)(
              Tally.get(id).pipe(
                Effect.flatMap((tally) => tally.Tick(1).pipe(Actor.commandId(retried.commandId))),
              ),
            ),
          ).toBe(undefined)
          expect(tickReductions.count - before).toBe(1)
        }),
      ),
  },
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
            yield* add(0, id, 1)
            const activated = (yield* inspect(0, yield* refOf(id))).generation

            for (let runner = 1; runner < 3; runner++) yield* add(runner, id, 1)
            expect((yield* inspect(0, yield* refOf(id))).generation).toBe(activated)

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
      withCluster(environment, 3, killDuringTurn(expect, "beforeCommit")),
  },
  {
    name: "replays a killed runner's committed turn on the next owner instead of running it again",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withCluster(environment, 3, killDuringTurn(expect, "afterCommit")),
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

          const heartbeat = yield* cluster.pauseHeartbeat(stale)
          yield* awaitOwner(ref, (current) => current === rival)
          expect(yield* add(rival, "stale", 10)).toBe(11)

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

          const log = yield* cluster.on(rival)(
            Tally.get("raced").pipe(Effect.flatMap((tally) => tally.Log())),
          )

          expect(log.map(({ cursor }) => cursor)).toEqual(
            Array.from({ length: 25 }, (_, index) => String(index + 1)),
          )
          expect(new Set(log.map(({ commandId }) => commandId)).size).toBe(25)

          const inspection = yield* inspect(rival, ref)
          expect(inspection).toMatchObject({ state: { count: 25 }, receipts: 25, events: 25 })
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

          yield* cluster.restart(owner)
          yield* cluster.ready
          expect((yield* cluster.owner(ref)) === undefined).toBe(false)
          expect(yield* add(owner, "restart", 1)).toBe(3)
          expect(yield* add(other, "restart", 1)).toBe(4)
          expect(yield* inspect(owner, ref)).toMatchObject({ state: { count: 4 }, receipts: 4 })
        }),
      ),
  },
  {
    name: "serializes a 512-byte subject through a cross-runner command",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withCluster(
        environment,
        2,
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          const subject = "é".repeat(256)
          const ids = Array.from({ length: 16 }, (_, index) => `principal-${index}`)

          for (const id of ids) {
            yield* add(0, id, 1)
            const owner = yield* cluster.owner(yield* refOf(id))
            const caller = owner === 0 ? 1 : 0

            const echoed = yield* cluster.on(caller)(
              Tally.get(id).pipe(
                Effect.flatMap((tally) => tally.Whoami()),
                Actor.as(User.make({ subject })),
              ),
            )

            expect(owner === 0 || owner === 1).toBe(true)
            expect(echoed).toBe(subject)
          }
        }),
      ),
  },
]
