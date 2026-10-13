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
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { Caller, System } from "../contract/caller.ts"
import type { FullState } from "../contract/context.ts"
import { ActorError, ShardMoved } from "../contract/errors.ts"
import { Client } from "../contract/handle.ts"
import type { Transport } from "../contract/handle.ts"
import type { AnyActor, DefOf } from "../contract/make.ts"
import type { Implementation } from "../handlers/registry.ts"
import { Lists } from "../handlers/lists.ts"
import { CommandIds } from "../execution/command-ids.ts"
import { Durable } from "../execution/durable.ts"
import type { Bound, Catalog } from "../execution/durable.ts"
import { Engine } from "../execution/engine.ts"
import type { DrainReport } from "../execution/engine.ts"
import type { Entry } from "../execution/entries.ts"
import { Jobs } from "../execution/jobs.ts"
import { Layouts } from "../execution/layout.ts"
import type { Decoded } from "../execution/layout.ts"
import { Transports } from "../execution/transport.ts"
import { frameworkVersion } from "../snapshots/build.ts"
import { Recovery } from "../snapshots/recovery.ts"
import type { ReplayPolicy } from "../snapshots/recovery.ts"
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

/**
 * One runner of a simulated store: the application bundle its segments record (default
 * `"simulation"`) and which builds it replays (default `"matching"`).
 */
export interface RunnerOptions {
  readonly bundle?: string
  readonly replay?: ReplayPolicy
}

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
  /** The runners over the store's one bucket; runner 0 starts with every shard. Default: one runner. */
  readonly runners?: ReadonlyArray<RunnerOptions>
  /** Runner index per shard for a partitioned store; defaults to runner 0 for every shard. */
  readonly assignments?: ReadonlyArray<number>
  /** How late a cron tick may fire after downtime before it is skipped. Default 1 hour. */
  readonly cronSkipIfOlderThan?: Duration.Input
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

/** One simulated runner: its engine on its own store instance over the shared bucket. */
export interface SimulatedRunner {
  readonly index: number
  readonly engine: Engine
  readonly build: Build
}

interface Simulator {
  readonly seed: number
  readonly catalog: Catalog
  readonly runners: ReadonlyArray<SimulatedRunner>
  /** The runner the runner layer assigns every shard to now; none while the store is drained. */
  readonly owner: number | undefined
  /** The owner's engine, or runner 0's while the store is drained. */
  readonly engine: Engine
  readonly bucket: SimulatedBucket
  readonly build: Build
  readonly publications: Array<Publication>
  readonly violations: Array<string>
  readonly logs: Effect.Effect<ReadonlyArray<ShardLogContent>>
  readonly quiesce: Effect.Effect<string | undefined>
  readonly waiting: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly client: (caller: Caller) => Transport
  readonly assign: (runner: number) => Effect.Effect<void>
  readonly assignShards: (runner: number, shards: ReadonlyArray<number>) => Effect.Effect<void>
  readonly engineFor: (actor: AnyActor, key: Schema.Json) => Engine | undefined
  readonly drain: (deadline: Duration.Input) => Effect.Effect<DrainReport>
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

/** How often the simulated runner layer re-reads assignments, the store's default refresh interval. */
const REFRESH = Duration.seconds(15)

const noOwner = (): ActorError => ActorError.make({ reason: ShardMoved.make({}) })

/**
 * The simulator: engines over one in-process bucket with seeded faults, a seeded fiber scheduler
 * and `TestClock`, every action run twice and compared, `Math.random` replaced for the run, and
 * the invariants checked after every `settle`. Each runner has its own store instance and writer
 * over the shared bucket. A runner layer assigns every shard to one owner: clients reach that
 * owner and retry with the same id while it is not open, and every `REFRESH` the layer assigns a
 * shard the owner lost to a fence back to it and releases the shards any other runner still holds.
 * Provides `Client` (as `System` "process" unless `caller` is given) and the clock. While a client
 * call waits and the engines have nothing staged or in flight, the call can only be waiting on the
 * clock (a retry after a crash), so the simulator moves the clock in growing steps; background
 * work moves it in `settle` and `advance`. The test clock's warning about a clock nobody advances
 * is off: it waits on the host's clock, and its log line would join the seeded queue at a moment
 * the host decides, so a slow host would change the run.
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
    TestClock.layer({ warningDelay: Duration.infinity }),
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
      const every = Array.from({ length: catalog.shards }, (_, shard) => shard)
      const random = xorshift(options.seed ^ 0x9e3779b9)
      const bucket = SimulatedBucket.make(random, options.faults ?? [], options.rates)
      const violations: Array<string> = []
      const publications: Array<Publication> = []
      const original = Math.random
      const replaced = xorshift(options.seed ^ 0x51ed270b)
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          Math.random = replaced
        }),
        () =>
          Effect.sync(() => {
            Math.random = original
          }),
      )
      const runners: Array<SimulatedRunner> = []
      for (const [index, runner] of (options.runners ?? [{}]).entries()) {
        const application = { bundle: runner.bundle ?? "simulation", framework: frameworkVersion }
        const store = yield* Effect.orDie(
          storeOf(bucket.view(index), {
            shards: catalog.shards,
            build: application,
            writer: index === 0 ? "simulation" : `simulation-${index}`,
          }),
        )
        const engine = yield* Engine.make(catalog, {
          shards: catalog.shards,
          policy: runner.replay ?? "matching",
          maxBatch: 64,
          checkpointEvery: options.checkpointEvery ?? 3,
          cronSkipIfOlderThan: Duration.toMillis(
            Duration.fromInputUnsafe(options.cronSkipIfOlderThan ?? "1 hour"),
          ),
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
        runners.push({ index, engine, build: yield* runtimeBuild(application) })
      }
      const first = runners[0]
      if (first === undefined)
        return yield* Effect.die(new RangeError("a simulation needs a runner"))
      const owners: Array<number | undefined> = every.map((id) => options.assignments?.[id] ?? 0)
      const ownerEngine = (shard = 0): Engine | undefined => {
        const owner = owners[shard]
        return owner === undefined ? undefined : runners[owner]?.engine
      }
      const engineFor = (actor: AnyActor, key: Schema.Json) =>
        ownerEngine(Durable.shardOf(Durable.addressOf(actor.name, key), catalog.shards))
      const root = yield* Effect.scope
      for (const runner of runners) {
        yield* runner.engine.assign(every.filter((id) => owners[id] === runner.index))
        runner.engine.route((command) =>
          Effect.suspend(
            () =>
              engineFor(command.actor, command.keyJson)?.execute(command) ?? Effect.fail(noOwner()),
          ),
        )
      }
      bucket.arm((runner, shard) =>
        Effect.asVoid(Effect.forkIn(runners[runner]?.engine.crash(shard) ?? Effect.void, root)),
      )
      const jobs = runners.map((runner) => Jobs.install(runner.engine))
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

      /** Work the runner layer still owes: a shard the owner lost to a fence, or one another runner holds. */
      const unassigned = (): string | undefined => {
        for (const runner of runners)
          for (const shard of every) {
            const { status, assigned } = runner.engine.status(shard)
            if (runner.index === owners[shard] && status === "fenced")
              return `shard ${shard} was fenced on its owner, runner ${runner.index}`
            if (
              runner.index !== owners[shard] &&
              assigned &&
              status !== "fenced" &&
              status !== "refused"
            )
              return `runner ${runner.index} still holds shard ${shard}`
          }
        return undefined
      }

      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            yield* Effect.sleep(REFRESH)
            for (const runner of runners)
              for (const shard of every) {
                const { status, assigned } = runner.engine.status(shard)
                if (runner.index === owners[shard] && status === "fenced")
                  yield* runner.engine.assign([shard])
                else if (runner.index !== owners[shard] && assigned)
                  yield* Effect.forkIn(runner.engine.release(shard), root)
              }
          }),
        ),
      )

      const settlers: Array<Deferred.Deferred<string | undefined>> = []
      const busyAt = (now: number): string | undefined => {
        for (const runner of runners) {
          const busy = runner.engine.busy(now)
          if (busy !== undefined)
            return runners.length === 1 ? busy : `runner ${runner.index}: ${busy}`
        }
        const running = jobs.reduce((sum, installed) => sum + installed.active(), 0)
        return (
          unassigned() ??
          (running > 0 ? `${running} jobs are running` : undefined) ??
          (waiting > 0 ? `${waiting} client calls are waiting` : undefined)
        )
      }
      const nextTimer = (cron: boolean): number | undefined => {
        let earliest: number | undefined
        for (const runner of runners) {
          const due = runner.engine.nextTimer(cron)
          if (due !== undefined && (earliest === undefined || due < earliest)) earliest = due
        }
        return earliest
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
            const due = nextTimer(false)
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

      /**
       * A client that reaches the owner at each attempt, so a call the old owner refuses with
       * `ShardMoved` is retried, with the same id, on the new one.
       */
      const routed = (caller: Caller): Transport => {
        const reads = (request: { readonly actor: AnyActor; readonly id: Schema.Json }) => {
          const engine = engineFor(request.actor, request.id)
          return engine === undefined ? undefined : Transports.reads(engine, caller)
        }
        const missing = Effect.fail(noOwner())
        return {
          call: (request) =>
            counted(
              Effect.gen(function* () {
                const commandId = yield* CommandIds.mint(yield* Clock.currentTimeMillis)
                return yield* Transports.retryWhileUnavailable(
                  Effect.suspend(() => {
                    const engine = engineFor(request.actor, request.id)
                    return engine === undefined
                      ? missing
                      : Transports.admit(engine, caller, commandId, request)
                  }),
                )
              }),
            ),
          state: (request) =>
            Stream.suspend(() => reads(request)?.state(request) ?? Stream.fromEffect(missing)),
          view: (request) =>
            Stream.suspend(() => reads(request)?.view(request) ?? Stream.fromEffect(missing)),
          event: (request) =>
            Stream.suspend(() => reads(request)?.event(request) ?? Stream.fromEffect(missing)),
          range: (request) => Effect.suspend(() => reads(request)?.range(request) ?? missing),
          watch: (request) =>
            Stream.suspend(() => reads(request)?.watch(request) ?? Stream.fromEffect(missing)),
          join: (request) =>
            counted(Effect.suspend(() => reads(request)?.join(request) ?? missing)),
          find: (request) =>
            Transports.reads(
              {
                ...first.engine,
                instances: (actor) =>
                  Effect.map(
                    Effect.forEach(
                      every,
                      (id) => ownerEngine(id)?.instances(actor, [id]) ?? missing,
                    ),
                    (partitions) => partitions.flat(),
                  ),
              },
              caller,
            ).find(request),
        }
      }

      const simulator: Simulator = {
        seed: options.seed,
        catalog,
        runners,
        get owner() {
          return owners.every((owner) => owner === owners[0]) ? owners[0] : undefined
        },
        get engine() {
          return ownerEngine() ?? first.engine
        },
        bucket,
        build: first.build,
        publications,
        violations,
        logs: Effect.forEach(every, (shard) => Invariants.read(bucket.inspect, shard)),
        waiting: counted,
        quiesce: Effect.suspend(() => {
          const settler = Deferred.makeUnsafe<string | undefined>()
          settlers.push(settler)
          return Deferred.await(settler)
        }),
        client: routed,
        engineFor,
        assign: (runner) => Effect.suspend(() => simulator.assignShards(runner, every)),
        assignShards: (runner, ids) =>
          Effect.gen(function* () {
            const target = runners[runner]
            if (target === undefined)
              return yield* Effect.die(new RangeError(`there is no runner ${runner}`))
            if (ids.some((id) => owners[id] !== runner))
              yield* Effect.forEach(
                ids,
                (shard) =>
                  target.engine.status(shard).assigned ? target.engine.release(shard) : Effect.void,
                { discard: true },
              )
            for (const id of ids) owners[id] = runner
            yield* target.engine.assign(ids)
          }),
        drain: (deadline) =>
          Effect.suspend(() => {
            const active = new Set(owners.filter((owner) => owner !== undefined))
            owners.fill(undefined)
            return Effect.map(
              Effect.forEach(active, (id) => runners[id]!.engine.drain(deadline), {
                concurrency: "unbounded",
              }),
              (reports): DrainReport => ({
                outcome: reports.every((report) => report.outcome === "clean")
                  ? "clean"
                  : "timedOut",
                shards: reports.flatMap((report) => report.shards),
              }),
            )
          }),
      }
      return simulator
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

/** The live durable image of a shard: the one held through the newest lease in its log, if any runner holds it. */
const liveImage = (simulator: Simulator, log: ShardLogContent) => {
  let newest: bigint | undefined
  for (const segment of log.segments)
    if (segment.entries.length === 0 && segment.open === segment.offset) newest = segment.open
  for (const runner of simulator.runners) {
    const lease = runner.engine.lease(log.shard)
    const image = runner.engine.durableImage(log.shard)
    if (lease !== undefined && image !== undefined && lease.open === newest) return image
  }
  return undefined
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
      const live = liveImage(simulator, log)
      if (live === undefined) continue
      found.push(
        ...Invariants.replays(simulator.catalog, simulator.build, log, Recovery.fingerprint(live)),
      )
    }
    return found
  })

/**
 * Runs the simulation until nothing is staged, in flight, delivering, due or running, no call
 * waits and the runner layer owes nothing, then checks every invariant and fails naming the seed.
 * Time passes only when no fiber can run: in growing steps while work sleeps (retries, backoffs,
 * jobs, the runner layer's refresh), and straight to the next one-shot timer once nothing else is
 * left. Cron ticks never end, so they do not hold it. A run that is still busy after 100,000
 * stalled turns fails as a liveness violation.
 */
const settle: Effect.Effect<void, InvariantViolation, SimulationService> = Effect.gen(function* () {
  const simulator = yield* SimulationService
  const stuck = yield* simulator.quiesce
  const violations = yield* violationsNow(simulator)
  if (stuck !== undefined) violations.push(`liveness: the run did not settle; ${stuck}`)
  if (violations.length > 0)
    return yield* InvariantViolation.make({ seed: simulator.seed, violations })
})

/**
 * Moves the clock forward, firing whatever comes due at its own time, cron ticks included: the
 * clock stops at each due time until the work it started has settled, as it would on a live owner,
 * then the run settles at the end.
 */
const advance = (
  duration: Duration.Input,
): Effect.Effect<void, InvariantViolation, SimulationService> =>
  Effect.gen(function* () {
    const simulator = yield* SimulationService
    const end =
      (yield* Clock.currentTimeMillis) + Duration.toMillis(Duration.fromInputUnsafe(duration))
    const nextDue = () => {
      let due: number | undefined
      for (const runner of simulator.runners) {
        const next = runner.engine.nextTimer(true)
        if (next !== undefined && (due === undefined || next < due)) due = next
      }
      return due
    }
    while (true) {
      const now = yield* Clock.currentTimeMillis
      const due = nextDue()
      if (due === undefined || due > end) break
      if (due > now) yield* TestClock.adjust(Duration.millis(due - now))
      if ((yield* simulator.quiesce) !== undefined) break
      const later = nextDue()
      if (later !== undefined && later <= due) break
    }
    const now = yield* Clock.currentTimeMillis
    if (end > now) yield* TestClock.adjust(Duration.millis(end - now))
    yield* settle
  })

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
        Effect.suspend(
          () =>
            simulator
              .engineFor(actor, layout.key.encode(id))
              ?.durableRecord(actor, layout.key.encode(id)) ?? Effect.fail(noOwner()),
        ),
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
        Effect.suspend(
          () =>
            simulator
              .engineFor(actor, layout.key.encode(id))
              ?.seed(actor, layout.key.encode(id), set, lists) ?? Effect.fail(noOwner()),
        ),
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
      for (const runner of simulator.runners)
        for (let shard = 0; shard < simulator.catalog.shards; shard++)
          yield* runner.engine.crash(shard)
      return
    }
    yield* (
      simulator
        .engineFor(actor, Layouts.of(actor).key.encode(id))
        ?.crash(
          simulator.engine.shardOf(Durable.addressOf(actor.name, Layouts.of(actor).key.encode(id))),
        ) ?? Effect.void
    )
  })

/**
 * The runner layer assigns every shard to `runner`, which opens them and so fences whichever
 * runner held them. The previous owner is not told: it learns from the log when its next append or
 * lease check fails, or when the runner layer releases its shards at the next refresh. A runner
 * given the store back while it still holds shards from before it was moved away first releases
 * them, as a runner whose shard locks lapsed learns at its next lock refresh, and then opens them
 * again from the log.
 */
const assign = (runner: number): Effect.Effect<void, never, SimulationService> =>
  Effect.flatMap(SimulationService, (simulator: Simulator) => simulator.assign(runner))

/**
 * Drains the owner: it stops admitting, makes what it admitted durable, checkpoints and releases
 * every shard. The store has no owner until the next `assign`.
 */
const drain = (
  deadline: Duration.Input = "30 seconds",
): Effect.Effect<DrainReport, never, SimulationService> =>
  Effect.flatMap(SimulationService, (simulator: Simulator) => simulator.drain(deadline))

/** Cuts `runner` off from the bucket for `duration`: its calls fail as if the network were down. */
const partition = (
  runner: number,
  duration: Duration.Input,
): Effect.Effect<void, never, SimulationService> =>
  Effect.gen(function* () {
    const simulator = yield* SimulationService
    const now = yield* Clock.currentTimeMillis
    simulator.bucket.partition(runner, now + Duration.toMillis(Duration.fromInputUnsafe(duration)))
  })

/**
 * Pauses `runner` for `duration`: every call it makes to the bucket waits until the pause ends and
 * then lands, as the requests of a frozen process do. Its clock keeps counting, the way a clock that
 * counts suspended time does.
 */
const pause = (
  runner: number,
  duration: Duration.Input,
): Effect.Effect<void, never, SimulationService> =>
  Effect.gen(function* () {
    const simulator = yield* SimulationService
    const now = yield* Clock.currentTimeMillis
    simulator.bucket.pause(runner, now + Duration.toMillis(Duration.fromInputUnsafe(duration)))
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
  assign,
  assignShards: (runner: number, shards: ReadonlyArray<number>) =>
    Effect.flatMap(SimulationService, (simulator) => simulator.assignShards(runner, shards)),
  drain,
  partition,
  pause,
  run,
  violations: Effect.flatMap(SimulationService, violationsNow),
}
