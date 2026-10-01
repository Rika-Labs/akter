import { BunCrypto } from "@effect/platform-bun"
import { Actor } from "@rikalabs/akter"
import { ActorCluster, ActorTest } from "@rikalabs/akter/testing"
import { Effect, Layer, Schedule, Schema } from "effect"
import { now, summarize } from "../measure.ts"
import type { CaseResult, Scenario, ScenarioContext } from "../scenario.ts"

const RUNNERS = 3

const EXPIRATION_SECONDS = 3

const TICK_INTERVAL = "50 millis"

const Tick = Actor.command("Tick", { payload: Schema.String, success: Schema.Int })

const Last = Actor.query("Last", { success: Schema.String })

/** A singleton whose build forks a loop that commits a `Tick` every 50 ms. */
const Beacon = Actor.make("Beacon", {
  key: Actor.singleton,
  state: Actor.state({
    ticks: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    by: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  }),
  api: { Tick, Last },
})

interface Loop {
  readonly id: string
  readonly startedAt: number
}

/**
 * One cluster runs at a time, so its loops are the only ones recorded.
 */
const loops: Array<Loop> = []

const BeaconLive = Layer.mergeAll(
  Beacon.toLayer(
    Effect.gen(function* () {
      const beacon = yield* Beacon.get()
      const loop: Loop = { id: `loop-${loops.length + 1}`, startedAt: performance.now() }
      loops.push(loop)

      yield* Effect.forkScoped(
        beacon.Tick(loop.id).pipe(Effect.ignore, Effect.repeat(Schedule.spaced(TICK_INTERVAL))),
      )

      return {
        Tick: Effect.fnUntraced(function* () {
          const turn = yield* Beacon.Turn
          yield* turn.state.set({ ticks: turn.state.ticks + 1, by: loop.id })

          return turn.state.ticks
        }),
      }
    }),
  ),
  Beacon.toQueryLayer({
    Last: Effect.fnUntraced(function* () {
      return (yield* Beacon.Read).state.by
    }),
  }),
)

const lastOn = (runner: number) =>
  ActorCluster.use((cluster) =>
    cluster.on(runner)(Beacon.get().pipe(Effect.flatMap((beacon) => beacon.Last()))),
  )

const poll = <A, E, R>(effect: Effect.Effect<A, E, R>, until: (value: A) => boolean) =>
  effect.pipe(
    Effect.repeat({ schedule: Schedule.spaced("10 millis"), until }),
    Effect.timeoutOrElse({
      duration: "60 seconds",
      orElse: () => Effect.die(new Error("Singleton failover did not finish")),
    }),
  )

/**
 * One drill on a fresh database and cluster: waits for the singleton's loop to
 * commit, kills its owner, and times each failover phase from the kill.
 *
 * Rebalancing while runners join can move the singleton; wait until the newest
 * loop is the one committing.
 */
const drill = (context: ScenarioContext) =>
  Effect.scoped(
    Effect.gen(function* () {
      loops.length = 0
      const database = yield* context.backend.database({ maxConnections: 2 })

      const services = yield* Layer.build(
        ActorTest.cluster({
          database: database.url!,
          runners: RUNNERS,
          shardLockExpiration: `${EXPIRATION_SECONDS} seconds`,
          actors: BeaconLive,
        }).pipe(Layer.provide(BunCrypto.layer)),
      ).pipe(Effect.orDie)

      return yield* Effect.gen(function* () {
        const cluster = yield* ActorCluster
        yield* cluster.ready
        const ref = (yield* cluster.on(0)(Beacon.get())).ref

        yield* poll(lastOn(0), (by) => by !== "" && by === loops.at(-1)?.id)
        yield* Effect.sleep("1 second")
        const before = loops.length
        const previous = loops.at(-1)!.id
        const owner = (yield* cluster.owner(ref))!
        const survivor = (owner + 1) % RUNNERS

        const killed = yield* now
        yield* cluster.kill(owner)

        const since = (at: number) => Math.round(at - killed)

        const owned = (accept: (current: number | undefined) => boolean) =>
          poll(cluster.owner(ref), accept).pipe(Effect.andThen(now), Effect.map(since))

        const [lockExpiredMs, takeoverMs, resumedMs] = yield* Effect.all(
          [
            owned((current) => current !== owner),
            owned((current) => current !== undefined && current !== owner),
            poll(lastOn(survivor), (by) => by !== previous).pipe(
              Effect.andThen(now),
              Effect.map(since),
            ),
          ],
          { concurrency: "unbounded" },
        )

        return {
          lockExpiredMs,
          takeoverMs,
          loopStartedMs: since(loops[before]!.startedAt),
          resumedMs,
          loopsStarted: loops.length - before,
        }
      }).pipe(Effect.provideContext(services), Effect.orDie)
    }),
  )

const digest = (name: string, samples: ReadonlyArray<number>) => {
  const summary = summarize(samples)

  return {
    [`${name}P50`]: summary.p50,
    [`${name}P95`]: summary.p95,
    [`${name}P99`]: summary.p99,
  }
}

/**
 * The harness refuses PGlite: several runners need independent connections.
 */
export const singletonFailover: Scenario = {
  name: "singleton-failover",
  description:
    "An Actor.singleton with a forked background loop on three in-process runners over one Postgres (ActorTest.cluster): the owner is killed and the first observation of its expired lock, survivor takeover, loop restart, and first committed tick of the new loop are each timed from the kill, over repeated drills on fresh clusters.",
  run: (context) =>
    Effect.gen(function* () {
      if (context.backend.name !== "postgres") return []

      const repeats = context.quick ? 3 : 20
      const drills = yield* Effect.forEach(Array.from({ length: repeats }), () => drill(context))

      const pick = (key: "lockExpiredMs" | "takeoverMs" | "loopStartedMs" | "resumedMs") =>
        drills.map((result) => result[key])

      const elapsedMs = drills.reduce((total, result) => total + result.resumedMs, 0)

      return [
        {
          name: "kill-owner-of-3",
          parameters: {
            runners: RUNNERS,
            shardLockExpirationSeconds: EXPIRATION_SECONDS,
            tickIntervalMs: 50,
            repeats,
          },
          operations: drills.length,
          elapsedMs,
          throughput: 0,
          errors: 0,
          errorKinds: {},
          latencyMs: summarize(pick("resumedMs")),
          statementsPerOperation: null,
          roundTripsPerOperation: null,
          statements: null,
          activity: null,
          cpu: {
            client: 0,
            server: null,
            clientMsPerOperation: null,
            serverMsPerOperation: null,
          },
          extra: {
            ...digest("lockExpiredMs", pick("lockExpiredMs")),
            ...digest("takeoverMs", pick("takeoverMs")),
            ...digest("loopStartedMs", pick("loopStartedMs")),
            ...digest("resumedMs", pick("resumedMs")),
            maxLoopsStartedPerDrill: Math.max(...drills.map((result) => result.loopsStarted)),
          },
        } satisfies CaseResult,
      ]
    }),
}
