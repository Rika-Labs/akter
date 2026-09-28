import { DateTime, Effect, Layer, Option, Schedule, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor, User } from "../../index.ts"
import { InternalActors } from "../../handles/actors.ts"
import type { ActorRef } from "../../identity/caller.ts"
import { ActorTest } from "../actor-test.ts"
import { ActorCluster } from "../cluster.ts"
import type { ConformanceCase, ConformanceEnvironment } from "../conformance.ts"

/** A tick from `loop`, committed by the activation whose loop is `by`. */
class Ticked extends Actor.Event<Ticked>()("Ticked", { loop: Schema.String, by: Schema.String }) {}

const Tick = Actor.command("Tick", { input: Schema.String, output: Schema.Finite })

const Log = Actor.query("Log", {
  output: Schema.Array(
    Schema.Struct({
      cursor: Schema.String,
      loop: Schema.String,
      by: Schema.String,
      at: Schema.Finite,
    }),
  ),
})

const Beacon = Actor.make("Beacon", {
  key: Actor.singleton,
  state: Actor.state({ ticks: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  events: [Ticked],
  api: { Tick, Log },
})

/** What one background loop did, as seen from inside the (single) process. */
interface Loop {
  readonly id: string
  readonly startedAt: number
  stoppedAt: number | undefined
  live: boolean
  closed: boolean
  attempts: number
  refused: number
}

/** Every loop each cluster's singleton started, keyed by the cluster's tenant. */
const loops = new Map<string, Array<Loop>>()

/** The most loops of one tenant live at once, checked whenever a loop starts. */
const peaks = new Map<string, number>()

const peakOf = (tenant: string) => peaks.get(tenant) ?? 0

const liveOf = (tenant: string) => loopsOf(tenant).filter(({ live }) => live)

const loopsOf = (tenant: string): ReadonlyArray<Loop> => loops.get(tenant) ?? []

const TICK_INTERVAL = "50 millis"

/**
 * A singleton whose build forks one background loop. The loop shows it ran
 * only by sending `Tick` commands, so every tick it made is a committed turn.
 */
const BeaconLive = Layer.mergeAll(
  Beacon.toLayer(
    Effect.gen(function* () {
      const beacon = yield* Beacon.get()
      const started = loops.get(beacon.ref.tenant) ?? []
      loops.set(beacon.ref.tenant, started)

      const loop: Loop = {
        id: `loop-${started.length + 1}`,
        startedAt: performance.now(),
        stoppedAt: undefined,
        live: true,
        closed: false,
        attempts: 0,
        refused: 0,
      }

      started.push(loop)
      peaks.set(
        beacon.ref.tenant,
        Math.max(peakOf(beacon.ref.tenant), started.filter(({ live }) => live).length),
      )

      yield* Effect.forkScoped(
        Effect.gen(function* () {
          loop.attempts += 1
          yield* beacon.Tick(loop.id).pipe(
            Effect.catch(() =>
              Effect.sync(() => {
                loop.refused += 1
              }),
            ),
          )
        }).pipe(
          Effect.repeat(Schedule.spaced(TICK_INTERVAL)),
          Effect.ensuring(
            Effect.sync(() => {
              loop.live = false
              loop.stoppedAt = performance.now()
            }),
          ),
        ),
        { startImmediately: true },
      )
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          loop.closed = true
        }),
      )

      return {
        Tick: Effect.fnUntraced(function* (from: string) {
          const turn = yield* Beacon.Turn
          yield* turn.state.set({ ticks: turn.state.ticks + 1 })
          yield* turn.emit(Ticked.make({ loop: from, by: loop.id }))

          return turn.state.ticks
        }),
      }
    }),
  ),
  Beacon.toQueryLayer(
    Effect.succeed({
      Log: Effect.fnUntraced(function* () {
        const entries = yield* (yield* Beacon.Read).events(Ticked)

        return entries.map(({ cursor, event, timestamp }) => ({
          cursor,
          loop: event.loop,
          by: event.by,
          at: DateTime.toEpochMillis(timestamp),
        }))
      }, Effect.orDie),
    }),
  ),
)

const EXPIRATION_SECONDS = 3

/** Builds a fresh database and a cluster of `runners` serving the singleton. */
const withSingletonCluster = <A, E>(
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
          actors: BeaconLive,
          as: User.make({ subject: "alice" }),
        }),
      )

      return yield* body.pipe(Effect.provideContext(context))
    }),
  )

const on =
  (runner: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const cluster = yield* ActorCluster

      return yield* cluster.on(runner)(effect)
    })

const beaconRef = (runner: number) =>
  on(runner)(Beacon.get().pipe(Effect.map((beacon) => beacon.ref)))

const logOf = (runner: number) =>
  on(runner)(Beacon.get().pipe(Effect.flatMap((beacon) => beacon.Log())))

const tickFrom = (runner: number, from: string) =>
  on(runner)(Beacon.get().pipe(Effect.flatMap((beacon) => beacon.Tick(from))))

const inspectOn = (runner: number, ref: ActorRef) =>
  on(runner)(ActorTest.use((test) => test.inspect(ref)))

/** Polls `runner`'s view of the log until `accept` holds. */
const awaitLog = (
  runner: number,
  accept: (log: ReadonlyArray<{ readonly loop: string; readonly by: string }>) => boolean,
  what: string,
) =>
  logOf(runner).pipe(
    Effect.repeat({ schedule: Schedule.spaced("20 millis"), until: accept }),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.die(new Error(`Timed out waiting for ${what}`)),
    }),
  )

/** Polls until `check` holds. */
const awaitThat = (check: () => boolean, what: string) =>
  Effect.sync(check).pipe(
    Effect.repeat({ schedule: Schedule.spaced("20 millis"), until: (held) => held }),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.die(new Error(`Timed out waiting for ${what}`)),
    }),
  )

/** A shard lock row with database-clock times in epoch milliseconds. */
const lockOf = (runner: number, ref: ActorRef) =>
  on(runner)(
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

/**
 * Waits for the cluster's shards to settle and returns the one live loop once
 * it has committed a tick; rebalancing while runners join may move the
 * singleton, and so restart its loop, before that.
 */
const settled = Effect.gen(function* () {
  const cluster = yield* ActorCluster
  const ref = yield* beaconRef(0)
  yield* cluster.ready
  yield* awaitThat(() => liveOf(ref.tenant).length === 1, "one live loop")
  const loop = liveOf(ref.tenant)[0]!
  yield* awaitLog(0, (log) => log.some(({ by }) => by === loop.id), "a settled tick")

  return { ref, loop, before: loopsOf(ref.tenant).length }
})

/**
 * Waits until one loop is live and its activation committed the log's last
 * five ticks, and returns that loop.
 */
const steady = (runner: number, tenant: string) =>
  Effect.gen(function* () {
    const [live] = liveOf(tenant)
    const tail = (yield* logOf(runner)).slice(-5)

    return live !== undefined &&
      liveOf(tenant).length === 1 &&
      tail.length === 5 &&
      tail.every(({ by }) => by === live.id)
      ? Option.some(live)
      : Option.none<Loop>()
  }).pipe(
    Effect.repeat({ schedule: Schedule.spaced("25 millis"), until: Option.isSome }),
    Effect.map(Option.getOrThrow),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.die(new Error("Timed out waiting for one steady loop")),
    }),
  )

/**
 * The activations that committed a log, in commit order with consecutive
 * duplicates collapsed. Each activation's commits are one unbroken run when
 * none commits after its successor has.
 */
const runs = (log: ReadonlyArray<{ readonly by: string }>) =>
  log.flatMap(({ by }, index) => (index === 0 || log[index - 1]!.by !== by ? [by] : []))

const unbroken = (log: ReadonlyArray<{ readonly by: string }>) =>
  new Set(runs(log)).size === runs(log).length

const contiguous = (log: ReadonlyArray<{ readonly cursor: string }>) =>
  log.every(({ cursor }, index) => cursor === String(index + 1))

export const singletonConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "keeps one singleton activation and one background loop across three runners",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withSingletonCluster(
        environment,
        3,
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          // Nothing called the singleton: the runtime woke it, and its loop ticks.
          const { ref, loop, before } = yield* settled

          // Every runner's commands reach the same activation.
          for (const runner of [0, 1, 2]) yield* tickFrom(runner, `runner-${runner}`)

          yield* awaitLog(
            1,
            (log) => log.filter(({ loop: from }) => from === loop.id).length >= 20,
            "twenty ticks from the settled loop",
          )
          const log = yield* logOf(2)

          // Rebalancing while runners joined may have moved the singleton, but
          // no two loops were ever live together and no activation committed
          // after its successor had.
          expect(peakOf(ref.tenant)).toBe(1)
          expect(loopsOf(ref.tenant).length).toBe(before)
          expect(liveOf(ref.tenant)).toEqual([loop])
          expect(unbroken(log)).toBe(true)
          expect(runs(log).at(-1)).toBe(loop.id)
          expect(contiguous(log)).toBe(true)

          for (const runner of [0, 1, 2])
            expect(log.find(({ loop: from }) => from === `runner-${runner}`)?.by).toBe(loop.id)
          expect(loop.refused).toBe(0)

          const inspection = yield* inspectOn(1, ref)
          expect(inspection.receipts).toBe(inspection.events)
          expect(inspection.receipts >= log.length).toBe(true)
          expect((yield* cluster.owner(ref)) === undefined).toBe(false)
        }),
      ),
  },
  {
    name: "moves the singleton and its loop to exactly one survivor after its runner is killed",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment }) =>
      withSingletonCluster(
        environment,
        3,
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          const { ref, loop, before } = yield* settled

          const owner = (yield* cluster.owner(ref))!
          const survivor = (owner + 1) % 3
          const killed = (yield* lockOf(survivor, ref)).now
          yield* cluster.kill(owner)
          // Read after the kill, the row holds the dead runner's last refresh.
          const held = yield* lockOf(survivor, ref)

          // Every refresh rewrites `acquired_at`, so the takeover is read as
          // soon as the row names another runner; a later read would hold a
          // refresh instead.
          const taken = yield* lockOf(survivor, ref).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("20 millis"),
              until: ({ address }) => address !== held.address,
            }),
            Effect.timeoutOrElse({
              duration: "30 seconds",
              orElse: () => Effect.die(new Error("Timed out waiting for the shard's takeover")),
            }),
          )

          yield* awaitThat(() => loopsOf(ref.tenant).length > before, "a survivor's loop")
          const successor = loopsOf(ref.tenant)[before]!

          const log = yield* awaitLog(
            survivor,
            (entries) => entries.filter(({ by }) => by === successor.id).length >= 10,
            "the survivor's loop to tick",
          )

          const next = (yield* cluster.owner(ref))!

          expect(next === owner).toBe(false)
          // No survivor took the shard while the dead runner's lock was live.
          const expired = held.acquired + EXPIRATION_SECONDS * 1000
          expect(taken.acquired >= expired).toBe(true)
          expect(taken.acquired >= killed).toBe(true)

          // Exactly one survivor started a loop, and the dead runner's
          // activation committed nothing after the survivor's first commit.
          expect(loopsOf(ref.tenant).length).toBe(before + 1)
          expect(unbroken(log)).toBe(true)
          expect(runs(log).slice(-2)).toEqual([loop.id, successor.id])
          expect(contiguous(log)).toBe(true)
          const resumed = log.find(({ by }) => by === successor.id)!
          // The survivor committed only after the dead runner's lock expired,
          // whatever refreshes its own lock has had since.
          expect(resumed.at >= expired).toBe(true)

          // The dead runner's loop winds down; the survivor's keeps going.
          yield* awaitThat(() => !loop.live, "the dead runner's loop to stop")
          expect(liveOf(ref.tenant)).toEqual([successor])
          expect(successor.refused).toBe(0)

          const inspection = yield* inspectOn(next, ref)
          expect(inspection.receipts).toBe(inspection.events)
        }),
      ),
  },
  {
    name: "stops a heartbeat-paused singleton owner's loop before its successor starts and fences its commits",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment }) =>
      withSingletonCluster(
        environment,
        2,
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          const { ref, loop: zombie, before } = yield* settled

          const paused = (yield* cluster.owner(ref))!
          const rival = 1 - paused
          const first = Number((yield* inspectOn(rival, ref)).generation)
          const heartbeat = yield* cluster.pauseHeartbeat(paused)

          yield* awaitThat(() => loopsOf(ref.tenant).length > before, "the rival's loop")
          const successor = loopsOf(ref.tenant)[before]!
          yield* awaitLog(
            rival,
            (entries) => entries.filter(({ by }) => by === successor.id).length >= 10,
            "the rival's activation to commit",
          )
          expect(yield* cluster.owner(ref)).toBe(rival)

          // The zombie still believes it owns the singleton's shard, but its
          // lease in the database lapsed: its loop stopped before the rival's
          // started, and it built no new activation while paused.
          expect(zombie.live).toBe(false)
          expect(zombie.stoppedAt! < successor.startedAt).toBe(true)
          yield* Effect.sleep(`${EXPIRATION_SECONDS} seconds`)
          expect(loopsOf(ref.tenant).length).toBe(before + 1)
          expect(liveOf(ref.tenant)).toEqual([successor])
          expect(peakOf(ref.tenant)).toBe(1)
          const split = yield* logOf(rival)
          expect(unbroken(split)).toBe(true)
          expect(contiguous(split)).toBe(true)
          const moved = split.findIndex(({ by }) => by === successor.id)
          expect(split.slice(moved).some(({ by }) => by === zombie.id)).toBe(false)

          yield* heartbeat.resume
          yield* cluster.ready
          // Rebalancing once the runner rejoins may move the singleton again.
          const live = yield* steady(rival, ref.tenant)
          yield* tickFrom(paused, "after-resume")

          const log = yield* logOf(rival)
          expect(unbroken(log)).toBe(true)
          expect(contiguous(log)).toBe(true)
          expect(log.find(({ loop }) => loop === "after-resume")?.by).toBe(live.id)
          expect(liveOf(ref.tenant)).toEqual([live])

          const inspection = yield* inspectOn(rival, ref)
          expect(inspection.receipts).toBe(inspection.events)
          expect(Number(inspection.generation) > first).toBe(true)
        }),
      ),
  },
]
