import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Random,
  Scheduler,
  Schema,
} from "effect"
import { TestClock } from "effect/testing"
import { Caller, System } from "../contract/caller.ts"
import type { FullState } from "../contract/context.ts"
import type { ActorError } from "../contract/errors.ts"
import { Client } from "../contract/handle.ts"
import type { Transport } from "../contract/handle.ts"
import type { AnyActor, DefOf } from "../contract/make.ts"
import type { Implementation } from "../handlers/registry.ts"
import { Lists } from "../handlers/lists.ts"
import { Durable } from "../execution/durable.ts"
import type { Bound, Catalog } from "../execution/durable.ts"
import { Engine } from "../execution/engine.ts"
import type { Entry } from "../execution/entries.ts"
import { Jobs } from "../execution/jobs.ts"
import { Layouts } from "../execution/layout.ts"
import type { Decoded } from "../execution/layout.ts"
import { Transports } from "../execution/transport.ts"
import { frameworkVersion } from "../snapshots/build.ts"
import { Recovery } from "../snapshots/recovery.ts"
import { runtimeBuild } from "../store/build.ts"
import type { Build } from "../store/build.ts"
import { Store, storeOf } from "../store/service.ts"
import { Invariants } from "./invariants.ts"
import type { Publication, ShardLogContent } from "./invariants.ts"
import { SimulatedBucket } from "./simulated-bucket.ts"
import type { Fault, FaultRates } from "./simulated-bucket.ts"
import { SeededScheduler } from "./seeded-scheduler.ts"

/** The first seed of the simulator's numbered runs; run `n` uses seed `SIMULATION_SEED_BASE + n`. */
export const SIMULATION_SEED_BASE = 0x5eed_0000

/** How one simulated run is set up. */
export interface SimulationOptions<Actors extends ReadonlyArray<AnyActor>> {
  readonly actors: Actors
  readonly seed: number
  readonly faults?: ReadonlyArray<Fault>
  readonly rates?: FaultRates
  readonly shards?: number
  readonly checkpointEvery?: number
  readonly caller?: Caller
  readonly scheduler?: SeededScheduler
}

/** A broken invariant; its message names the seed that reproduces it. */
export class InvariantViolation extends Schema.TaggedError<InvariantViolation>()(
  "InvariantViolation",
  {
    seed: Schema.Finite,
    violations: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Simulation seed ${this.seed} violated:\n${this.violations.join("\n")}`
  }
}

interface Simulator {
  readonly seed: number
  readonly catalog: Catalog
  readonly engine: Engine
  readonly bucket: SimulatedBucket
  readonly build: Build
  readonly publications: Array<Publication>
  readonly violations: Array<string>
  readonly logs: Effect.Effect<ReadonlyArray<ShardLogContent>>
  readonly quiesce: Effect.Effect<string | undefined>
  readonly waiting: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly client: (caller: Caller) => Transport
}

/** The running simulation. */
export class SimulationService extends Context.Service<SimulationService, Simulator>()(
  "@rikalabs/akter/testing/simulation/SimulationService",
) {}

type ImplementationsOf<Actors extends ReadonlyArray<AnyActor>> = Implementation<
  Actors[number]["name"]
>

const xorshift = (seed: number): (() => number) => {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 4294967296
  }
}

/**
 * The simulator: one engine over an in-process log with seeded faults, a seeded fiber scheduler
 * and `TestClock`, every action run twice and compared, `Math.random` replaced for the run, and
 * the invariants checked after every `settle`. Provides `Client` (as `System` "process" unless
 * `caller` is given) and the clock. While a client call waits and the engine has nothing staged
 * or in flight, the call can only be waiting on the clock (a retry after a crash), so the
 * simulator moves the clock in growing steps; background work moves it in `settle` and `advance`.
 */
const layer = <const Actors extends ReadonlyArray<AnyActor>>(
  options: SimulationOptions<Actors>,
): Layer.Layer<
  SimulationService | Client | TestClock.TestClock,
  never,
  ImplementationsOf<Actors>
> => {
  const scheduler = options.scheduler ?? new SeededScheduler(options.seed)
  const services = Layer.mergeAll(
    TestClock.layer(),
    Layer.succeed(Scheduler.Scheduler, scheduler),
    Layer.effect(
      Random.Random,
      Random.withSeed(
        Effect.withFiber((fiber) => Effect.succeed(fiber.getRef(Random.Random))),
        options.seed,
      ),
    ),
  )
  const simulation = Layer.effect(
    SimulationService,
    Effect.gen(function* () {
      const actors = new Map<string, Bound>()
      for (const actor of options.actors)
        actors.set(actor.name, { actor, registered: yield* actor.implementation })
      const catalog: Catalog = { actors, shards: options.shards ?? 4 }
      const random = xorshift(options.seed ^ 0x9e3779b9)
      const bucket = SimulatedBucket.make(random, options.faults ?? [], options.rates)
      const application = { bundle: "simulation", framework: frameworkVersion }
      const build = yield* runtimeBuild(application)
      const store = yield* Effect.orDie(
        storeOf(bucket.bucket, {
          shards: catalog.shards,
          build: application,
          writer: "simulation",
        }),
      )
      const violations: Array<string> = []
      const publications: Array<Publication> = []
      const original = Math.random
      const replaced = xorshift(options.seed ^ 0x51ed270b)
      const subtle = globalThis.crypto.subtle
      const digest = subtle.digest.bind(subtle)
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          Math.random = replaced
          subtle.digest = (algorithm, data) => scheduler.hold(digest(algorithm, data))
        }),
        () =>
          Effect.sync(() => {
            Math.random = original
            subtle.digest = digest
          }),
      )
      const engine = yield* Engine.make(catalog, {
        shards: catalog.shards,
        validFor: 10_000,
        policy: "matching",
        maxBatch: 64,
        checkpointEvery: options.checkpointEvery ?? 3,
        doubleRun: true,
        observer: {
          published: (shard: number, offset: number, entry: Entry) => {
            publications.push({ shard, offset, entry })
          },
          violation: (invariant: string, detail: string) => {
            violations.push(`${invariant}: ${detail}`)
          },
        },
      }).pipe(Effect.provideService(Store, store))
      const root = yield* Effect.scope
      bucket.arm((shard) => Effect.asVoid(Effect.forkIn(engine.crash(shard), root)))
      const jobs = Jobs.install(engine)
      let waiting = 0
      const counted = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            waiting++
          }),
          () => effect,
          () =>
            Effect.sync(() => {
              waiting--
            }),
        )
      const settlers: Array<Deferred.Deferred<string | undefined>> = []
      const busyAt = (now: number): string | undefined => {
        const running = jobs.active()
        return (
          engine.busy(now) ??
          (running > 0 ? `${running} jobs are running` : undefined) ??
          (waiting > 0 ? `${waiting} client calls are waiting` : undefined)
        )
      }
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          let step = 1
          let quiet = 0
          let stalled = 0
          while (true) {
            yield* Effect.callback<void>((resume) => scheduler.whenIdle(() => resume(Effect.void)))
            if (!scheduler.idle) {
              step = 1
              quiet = 0
              continue
            }
            const now = yield* Clock.currentTimeMillis
            const busy = busyAt(now)
            if (busy !== undefined) {
              quiet = 0
              if (settlers.length > 0 && ++stalled > 100_000) {
                for (const settler of settlers.splice(0))
                  Deferred.doneUnsafe(settler, Exit.succeed(busy))
                stalled = 0
              }
              yield* TestClock.adjust(Duration.millis(step))
              step = Math.min(step * 2, 1_000)
              continue
            }
            step = 1
            stalled = 0
            if (settlers.length === 0) continue
            const due = engine.nextTimer()
            if (due !== undefined) {
              quiet = 0
              yield* TestClock.adjust(Duration.millis(Math.max(Math.ceil(due - now), 1)))
              continue
            }
            if (++quiet < 3) continue
            for (const settler of settlers.splice(0))
              Deferred.doneUnsafe(settler, Exit.succeed(undefined))
          }
        }),
      )
      return {
        seed: options.seed,
        catalog,
        engine,
        bucket,
        build,
        publications,
        violations,
        logs: Effect.forEach(
          Array.from({ length: catalog.shards }, (_, shard) => shard),
          (shard) => Invariants.read(bucket.inspect, shard),
        ),
        waiting: counted,
        quiesce: Effect.suspend(() => {
          const settler = Deferred.makeUnsafe<string | undefined>()
          settlers.push(settler)
          return Deferred.await(settler)
        }),
        client: (caller: Caller): Transport => {
          const transport = Transports.client(engine, caller)
          return {
            ...transport,
            call: (request) => counted(transport.call(request)),
            join: (request) => counted(transport.join(request)),
          }
        },
      }
    }),
  ).pipe(Layer.provide(services))
  const client = Layer.effect(
    Client,
    Effect.map(SimulationService, (simulator: Simulator) =>
      simulator.client(options.caller ?? System.make({ source: "process", subject: "process" })),
    ),
  )
  return Layer.mergeAll(client.pipe(Layer.provideMerge(simulation)), services)
}

/** Every broken invariant so far, with the log-wide and replay checks run now. */
const violationsNow = (simulator: Simulator) =>
  Effect.gen(function* () {
    const found = [...simulator.violations]
    const logs = yield* simulator.logs
    found.push(...Invariants.published(logs, simulator.publications))
    found.push(...Invariants.once(logs))
    for (const log of logs) {
      found.push(...Invariants.fenced(log))
      const live = simulator.engine.durableImage(log.shard)
      if (live === undefined) continue
      found.push(
        ...Invariants.replays(simulator.catalog, simulator.build, log, Recovery.fingerprint(live)),
      )
    }
    return found
  })

/**
 * Runs the simulation until nothing is staged, in flight, delivering, due or running and no call
 * waits, then checks every invariant and fails naming the seed. Time passes only when no fiber can
 * run: in growing steps while work sleeps (retries, backoffs, jobs), and straight to the next
 * one-shot timer once nothing else is left. Cron ticks never end, so they do not hold it. A run
 * that is still busy after 100,000 stalled turns fails as a liveness violation.
 */
const settle: Effect.Effect<void, InvariantViolation, SimulationService> = Effect.gen(function* () {
  const simulator = yield* SimulationService
  const stuck = yield* simulator.quiesce
  const violations = yield* violationsNow(simulator)
  if (stuck !== undefined) violations.push(`liveness: the run did not settle; ${stuck}`)
  if (violations.length > 0)
    return yield* InvariantViolation.make({ seed: simulator.seed, violations })
})

/** Moves the clock forward, firing whatever comes due, then settles. */
const advance = (
  duration: Duration.Input,
): Effect.Effect<void, InvariantViolation, SimulationService> =>
  Effect.andThen(TestClock.adjust(duration), settle)

/** The durable state of an instance as `Simulation.state` shows it: client state plus every list's items. */
const state = <X extends AnyActor>(
  actor: X,
  id: DefOf<X>["key"]["Type"],
): Effect.Effect<FullState<DefOf<X>["state"]["fields"]>, ActorError, SimulationService> =>
  Effect.gen(function* () {
    const simulator = yield* SimulationService
    const layout = Layouts.of(actor)
    const record = yield* simulator.waiting(
      Transports.retryWhileUnavailable(
        simulator.engine.durableRecord(actor, layout.key.encode(id)),
      ),
    )
    const full = { ...record.image.state }
    for (const [name, list] of layout.lists)
      full[name] = Lists.all(record.image.lists.get(name) ?? Lists.empty, list.ordering)
    return full
  })

/**
 * Writes an instance's initial state as an operator would, durably, before its first action; a
 * write lost to an injected crash or outage is staged again on the reopened shard, after the same
 * backoff a client uses.
 */
const seed = <X extends AnyActor>(
  actor: X,
  id: DefOf<X>["key"]["Type"],
  initial: Partial<FullState<DefOf<X>["state"]["fields"]>>,
): Effect.Effect<void, ActorError, SimulationService> =>
  Effect.gen(function* () {
    const simulator = yield* SimulationService
    const layout = Layouts.of(actor)
    const set: Record<string, Schema.Json> = {}
    const lists: Array<{
      readonly field: string
      readonly put: ReadonlyArray<Schema.Json>
      readonly delete: ReadonlyArray<string | number>
    }> = []
    for (const [name, value] of Object.entries<Decoded>(initial)) {
      const field = layout.fields.get(name)
      if (field !== undefined) {
        set[name] = field.encode(value)
        continue
      }
      const list = layout.lists.get(name)
      if (list !== undefined)
        lists.push({ field: name, put: Array.from(value, list.item.encode), delete: [] })
    }
    yield* simulator.waiting(
      Transports.retryWhileUnavailable(
        simulator.engine.seed(actor, layout.key.encode(id), set, lists),
      ),
    )
  })

/** Runs `effect` with a `Client` that calls as `caller`. */
const as =
  (caller: Caller) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, Exclude<R, Client> | SimulationService> =>
    Effect.flatMap(SimulationService, (simulator: Simulator) =>
      Effect.provideService(effect, Client, simulator.client(caller)),
    )

/** Crashes the owner of an instance's shard, or every shard: memory is lost, the log decides. */
const crash = (
  actor?: AnyActor,
  id?: Schema.Top["Type"],
): Effect.Effect<void, never, SimulationService> =>
  Effect.gen(function* () {
    const simulator = yield* SimulationService
    if (actor === undefined) {
      for (let shard = 0; shard < simulator.catalog.shards; shard++)
        yield* simulator.engine.crash(shard)
      return
    }
    yield* simulator.engine.crash(
      simulator.engine.shardOf(Durable.addressOf(actor.name, Layouts.of(actor).key.encode(id))),
    )
  })

/**
 * Runs one simulated run as its own root fiber on the run's seeded scheduler, so the whole run,
 * including the program, interleaves as a function of the seed.
 */
const run = <A, E, const Actors extends ReadonlyArray<AnyActor>>(
  options: SimulationOptions<Actors>,
  program: Effect.Effect<A, E, SimulationService | Client | TestClock.TestClock>,
  implementations: Layer.Layer<ImplementationsOf<Actors>>,
): Promise<A> => {
  const scheduler = options.scheduler ?? new SeededScheduler(options.seed)
  return Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(
        Layer.build(layer({ ...options, scheduler }).pipe(Layer.provide(implementations))),
        (context) => Effect.provideContext(program, context),
      ),
    ),
    { scheduler },
  )
}

/** The deterministic simulator of `@rikalabs/akter/testing`. */
export const Simulation = {
  layer,
  settle,
  advance,
  state,
  seed,
  as,
  crash,
  run,
  violations: Effect.flatMap(SimulationService, violationsNow),
}
