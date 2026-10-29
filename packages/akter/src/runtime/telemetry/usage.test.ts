import { describe, expect, it } from "@effect/vitest"
import { Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Schedule, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Actor, Job, JobFailure, user } from "../../index.ts"
import { DrainReport, RuntimeControl, Telemetry } from "../../server.ts"
import { Simulation, SimulationService } from "../../testing/index.ts"
import { CommandIds } from "../../execution/command-ids.ts"
import { Transports } from "../../execution/transport.ts"
import { PageMiss } from "../../handlers/page-tree.ts"
import { PagedItems } from "../../handlers/lists.ts"

class Rejected extends Schema.TaggedError<Rejected>()("UsageRejected", {}) {}

const Item = Schema.Struct({ id: Schema.Int, at: Schema.Int, value: Schema.Int })
const Metered = Actor.make("Metered", {
  state: Schema.Struct({
    value: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    items: Actor.list(Item, { key: "id", by: "at" }),
  }),
  commands: {
    add: Actor.command(Schema.Int, { success: Schema.Int }),
    reject: Actor.command({ fails: Rejected }),
    defect: Actor.command(),
    load: Actor.command({ success: Schema.Int }),
    start: Actor.command(),
    startTimed: Actor.command(),
    failed: Actor.command(JobFailure, { internal: true }),
  },
  jobs: {
    work: Actor.job({ onFailure: "failed" }).pipe(
      Job.retry({ times: 1, schedule: Schedule.spaced("100 millis") }),
    ),
    timed: Actor.job({ onFailure: "failed" }).pipe(Job.timeout("1200 millis")),
  },
})

class Work extends Context.Service<
  Work,
  { readonly run: (attempt: number) => Effect.Effect<void, string> }
>()("@rikalabs/akter/runtime/telemetry/usage.test/Work") {}

const Live = Metered.toLayer({
  add: (state, amount) => (state.value += amount),
  reject: (state) => {
    state.value = -99
    return Rejected.make({})
  },
  defect: (state) => {
    state.value = -999
    throw new Error("discard")
  },
  load: (state) => {
    state.value = state.items.range().reduce((sum, item) => sum + item.value, 0)
    return state.value
  },
  start: (_, __, { start }) => {
    start.work(undefined)
  },
  startTimed: (_, __, { start }) => {
    start.timed(undefined)
  },
  failed: () => {},
  work: (_, { attempt }) => Effect.flatMap(Work, (work) => work.run(attempt)),
  timed: (_, { attempt }) => Effect.flatMap(Work, (work) => work.run(attempt)),
})

const until = (check: () => boolean) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 10_000; turn++) {
      if (check()) return
      yield* Effect.yieldNow
    }
    return yield* Effect.die(new Error("usage test did not reach its transition"))
  })

const idleWork = Layer.succeed(Work, { run: () => Effect.void })

describe("runner usage attribution", () => {
  for (const seed of [8101, 8102, 8103]) {
    it(`seed ${seed}: rejects counting replay, dedupe admissions, discarded completions, or simulator double runs`, () =>
      Simulation.run(
        { actors: [Metered], seed, shards: 1, checkpointEvery: 0, runners: [{}, {}] },
        Effect.scoped(
          Effect.gen(function* () {
            const simulation = yield* SimulationService
            const first = simulation.runners[0]!.engine
            const second = simulation.runners[1]!.engine
            const id = yield* CommandIds.mint(yield* Clock.currentTimeMillis)
            const command = Transports.admit(first, user("meter"), id, {
              actor: Metered,
              id: "one",
              member: "add",
              payload: 7,
            })
            yield* command
            const saved = yield* first.usage
            expect(saved).toEqual({
              actions: 1,
              jobSeconds: 0,
              actors: [{ actorType: "Metered", actions: 1, jobSeconds: 0 }],
            })
            yield* command
            const client = yield* Metered.client("one")
            yield* Effect.flip(client.reject())
            expect(Exit.isFailure(yield* Effect.exit(client.defect()))).toBe(true)
            expect((yield* first.usage).actions).toBe(1)
            yield* first.crash(0)
            yield* Simulation.settle
            yield* command
            expect((yield* first.usage).actions).toBe(1)
            yield* Simulation.assign(1)
            yield* Simulation.settle
            expect((yield* second.usage).actions).toBe(0)
            expect(yield* client.add(13)).toBe(20)
            expect((yield* second.usage).actions).toBe(1)
            expect(saved.actions).toBe(1)
            const report = yield* Simulation.drain()
            expect(report).toMatchObject({ actions: 1, jobSeconds: 0 })
            expect((yield* first.usage).actions).toBe(1)
          }),
        ),
        Live.pipe(Layer.provide(idleWork)),
      ))
  }

  it("seed 8110: a cold PageMiss rerun counts once, not per execution", () =>
    Simulation.run(
      { actors: [Metered], seed: 8110, shards: 1, checkpointEvery: 1, runners: [{}, {}] },
      Effect.scoped(
        Effect.gen(function* () {
          yield* Simulation.seed(Metered, "cold", {
            items: [
              { id: 3, at: 17, value: 7 },
              { id: 9, at: 4, value: 13 },
            ],
          })
          yield* Simulation.settle
          yield* Simulation.assign(1)
          yield* Simulation.settle
          const simulation = yield* SimulationService
          const engine = simulation.runners[1]!.engine
          const record = yield* engine.durableRecord(Metered, "cold")
          const items = record.image.lists.get("items")!
          expect(items).toBeInstanceOf(PagedItems)
          if (!(items instanceof PagedItems)) return yield* Effect.die(new Error("not paged"))
          engine.pages.clear()
          expect(() => items.range()).toThrow(PageMiss)
          const client = yield* Metered.client("cold")
          expect(yield* client.load()).toBe(20)
          expect(yield* engine.usage).toMatchObject({ actions: 1, jobSeconds: 0 })
          expect((yield* simulation.runners[0]!.engine.usage).actions).toBe(0)
        }),
      ),
      Live.pipe(Layer.provide(idleWork)),
    ))

  for (const fault of ["crashBefore", "lostResponse"] as const) {
    it(`seed 8120 ${fault}: an append resolved as unwritten counts zero; a lost written response counts once`, () =>
      Simulation.run(
        { actors: [Metered], seed: 8120, shards: 1, checkpointEvery: 0 },
        Effect.scoped(
          Effect.gen(function* () {
            const simulation = yield* SimulationService
            yield* Simulation.settle
            simulation.bucket.script({
              runner: 0,
              fault,
              match: (operation, key) => operation === "create" && key.includes("/log/"),
            })
            const command = Transports.admit(
              simulation.engine,
              user("meter"),
              yield* CommandIds.mint(yield* Clock.currentTimeMillis),
              { actor: Metered, id: "one", member: "add", payload: 11 },
            )
            const exit = yield* Effect.exit(command)
            expect(Exit.isSuccess(exit)).toBe(fault === "lostResponse")
            yield* Simulation.settle
            expect((yield* simulation.engine.usage).actions).toBe(fault === "lostResponse" ? 1 : 0)
            yield* command
            expect((yield* simulation.engine.usage).actions).toBe(1)
          }),
        ),
        Live.pipe(Layer.provide(idleWork)),
      ))
  }

  it("seed 8121: a held append remains zero and a fenced unwritten append never enters the old runner's totals", () =>
    Simulation.run(
      { actors: [Metered], seed: 8121, shards: 1, checkpointEvery: 0, runners: [{}, {}] },
      Effect.scoped(
        Effect.gen(function* () {
          const simulation = yield* SimulationService
          yield* Simulation.settle
          const old = simulation.runners[0]!.engine
          yield* Simulation.pause(0, "5 seconds")
          const command = Transports.admit(
            old,
            user("meter"),
            yield* CommandIds.mint(yield* Clock.currentTimeMillis),
            { actor: Metered, id: "one", member: "add", payload: 11 },
          )
          const call = yield* Effect.forkChild(command)
          yield* until(() => old.busy(0)?.includes("in flight") === true)
          expect((yield* old.usage).actions).toBe(0)
          yield* Simulation.assign(1)
          yield* until(() => simulation.runners[1]!.engine.status(0).status === "open")
          yield* TestClock.adjust("5 seconds")
          expect(Exit.isFailure(yield* Effect.exit(Fiber.join(call)))).toBe(true)
          expect((yield* old.usage).actions).toBe(0)
          expect((yield* simulation.runners[1]!.engine.usage).actions).toBe(0)
        }),
      ),
      Live.pipe(Layer.provide(idleWork)),
    ))

  for (const ending of ["failure", "defect"] as const) {
    it(`seed 8130 ${ending}: 1.2s and 0.3s attempts report three seconds, excluding retry backoff`, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const entered = [yield* Deferred.make<void>(), yield* Deferred.make<void>()]
          const gates = [yield* Deferred.make<void>(), yield* Deferred.make<void>()]
          const work = Layer.succeed(Work, {
            run: (attempt) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered[attempt - 1]!, undefined)
                yield* Deferred.await(gates[attempt - 1]!)
                if (attempt === 1)
                  return yield* ending === "failure"
                    ? Effect.fail("retry")
                    : Effect.die("retry defect")
              }),
          })
          return yield* Effect.promise(() =>
            Simulation.run(
              { actors: [Metered], seed: 8130, shards: 1 },
              Effect.scoped(
                Effect.gen(function* () {
                  const client = yield* Metered.client("one")
                  yield* client.start()
                  yield* Deferred.await(entered[0]!)
                  const simulation = yield* SimulationService
                  expect((yield* simulation.engine.usage).jobSeconds).toBe(0)
                  yield* TestClock.adjust("1200 millis")
                  yield* Deferred.succeed(gates[0]!, undefined)
                  yield* Deferred.await(entered[1]!)
                  expect((yield* simulation.engine.usage).jobSeconds).toBe(2)
                  yield* TestClock.adjust("300 millis")
                  yield* Deferred.succeed(gates[1]!, undefined)
                  yield* Simulation.settle
                  expect(yield* simulation.engine.usage).toEqual({
                    actions: 1,
                    jobSeconds: 3,
                    actors: [{ actorType: "Metered", actions: 1, jobSeconds: 3 }],
                  })
                }),
              ),
              Live.pipe(Layer.provide(work)),
            ),
          )
        }),
      ))
  }

  for (const stop of ["drain", "timedOut", "ownerLoss"] as const) {
    it(`seed 8131 ${stop}: interruption counts the local share; a resumed attempt counts only the new owner's share`, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const entered = [yield* Deferred.make<void>(), yield* Deferred.make<void>()]
          const finish = yield* Deferred.make<void>()
          let runs = 0
          const work = Layer.succeed(Work, {
            run: (attempt) =>
              Effect.gen(function* () {
                expect(attempt).toBe(1)
                yield* Deferred.succeed(entered[runs++]!, undefined)
                yield* Deferred.await(finish)
              }),
          })
          return yield* Effect.promise(() =>
            Simulation.run(
              { actors: [Metered], seed: 8131, shards: 1, runners: [{}, {}] },
              Effect.scoped(
                Effect.gen(function* () {
                  const simulation = yield* SimulationService
                  const first = simulation.runners[0]!.engine
                  const second = simulation.runners[1]!.engine
                  const client = yield* Metered.client("one")
                  yield* client.start()
                  yield* Deferred.await(entered[0]!)
                  yield* TestClock.adjust("1200 millis")
                  if (stop !== "ownerLoss") {
                    if (stop === "timedOut") yield* Simulation.pause(0, "5 seconds")
                    const report = yield* Simulation.drain("100 millis")
                    expect(report).toMatchObject({
                      outcome: stop === "drain" ? "clean" : "timedOut",
                      actions: 1,
                      jobSeconds: 2,
                    })
                  } else yield* first.unassign([0])
                  yield* Simulation.assign(1)
                  yield* Deferred.await(entered[1]!)
                  expect((yield* first.usage).jobSeconds).toBe(2)
                  expect(yield* second.usage).toMatchObject({ actions: 0, jobSeconds: 0 })
                  yield* TestClock.adjust("300 millis")
                  yield* Deferred.succeed(finish, undefined)
                  yield* Simulation.settle
                  expect(yield* second.usage).toMatchObject({ actions: 0, jobSeconds: 1 })
                  expect((yield* first.usage).jobSeconds).toBe(2)
                }),
              ),
              Live.pipe(Layer.provide(work)),
            ),
          )
        }),
      ))
  }

  it("seed 8132: timeout settles wall time, not zero or the time spent delivering failure", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const work = Layer.succeed(Work, {
          run: () => Effect.andThen(Deferred.succeed(entered, undefined), Effect.never),
        })
        return yield* Effect.promise(() =>
          Simulation.run(
            { actors: [Metered], seed: 8132, shards: 1 },
            Effect.scoped(
              Effect.gen(function* () {
                const client = yield* Metered.client("one")
                yield* client.startTimed()
                yield* Deferred.await(entered)
                yield* TestClock.adjust("1200 millis")
                yield* Simulation.settle
                const simulation = yield* SimulationService
                expect(yield* simulation.engine.usage).toMatchObject({ actions: 2, jobSeconds: 2 })
              }),
            ),
            Live.pipe(Layer.provide(work)),
          ),
        )
      }),
    ))

  it("seed 8140: type attribution adds to runner totals without sharing another runner's counters", () => {
    const Other = Actor.make("OtherMetered", {
      state: Schema.Struct({}),
      commands: { touch: Actor.command() },
    })
    const OtherLive = Other.toLayer({ touch: () => {} })
    return Simulation.run(
      { actors: [Metered, Other], seed: 8140, shards: 1 },
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* Metered.client("one")
          const other = yield* Other.client("one")
          yield* client.add(17)
          yield* other.touch()
          yield* other.touch()
          const simulation = yield* SimulationService
          expect(yield* simulation.engine.usage).toEqual({
            actions: 3,
            jobSeconds: 0,
            actors: [
              { actorType: "Metered", actions: 1, jobSeconds: 0 },
              { actorType: "OtherMetered", actions: 2, jobSeconds: 0 },
            ],
          })
        }),
      ),
      Layer.merge(Live.pipe(Layer.provide(idleWork)), OtherLive),
    )
  })

  it.effect(
    "drain wire accepts reports with and without optional totals; the public read uses its runner context",
    () =>
      Effect.gen(function* () {
        const legacy = {
          outcome: "clean" as const,
          shards: [{ shard: 0, offset: 7, nextDue: null }],
        }
        const decode = Schema.decodeUnknownEffect(DrainReport)
        expect(yield* decode(legacy)).toEqual(legacy)
        expect(yield* decode({ ...legacy, actions: 13, jobSeconds: 3 })).toEqual({
          ...legacy,
          actions: 13,
          jobSeconds: 3,
        })
        expect(Exit.isFailure(yield* Effect.exit(decode({ ...legacy, actions: -1 })))).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(decode({ ...legacy, jobSeconds: 1.2 })))).toBe(
          true,
        )
        const snapshot = { actions: 13, jobSeconds: 3, actors: [] }
        expect(
          yield* Telemetry.usage.pipe(
            Effect.provideService(RuntimeControl, {
              readiness: Effect.succeed({ ready: true as const }),
              usage: Effect.succeed(snapshot),
              drain: () => Effect.succeed(legacy),
            }),
          ),
        ).toEqual(snapshot)
      }),
  )
})
