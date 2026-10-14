import { describe, expect, it } from "@effect/vitest"
import { Context, Deferred, Effect, Fiber, Layer, Result, Schema } from "effect"
import { Actor } from "../index.ts"
import type { AnyActor } from "../contract/make.ts"
import type { Catalog } from "../execution/durable.ts"
import { Durable } from "../execution/durable.ts"
import type { Implementation } from "../handlers/registry.ts"
import { Simulation, SimulationService } from "../testing/index.ts"
import { Checkpoints } from "./checkpoint.ts"
import { PagedCheckpoints } from "./pages.ts"
import { Recovery } from "./recovery.ts"
import { PageDocuments } from "../handlers/page-tree.ts"

const Tally = Actor.make("Tally", {
  state: Schema.Struct({
    total: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    notes: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
  actions: {
    add: Actor.action(Schema.Finite, { success: Schema.Finite }),
    remind: Actor.action(Schema.String),
    note: Actor.action(Schema.String, { internal: true }),
    forward: Actor.action(Schema.Struct({ to: Schema.String, amount: Schema.Finite })),
    tick: Actor.action({ cron: "0 0 * * *" }),
  },
})

const handlers = (step: number) =>
  Tally.toLayer({
    add: (tally, amount) => {
      tally.total += amount * step
      return tally.total
    },
    remind: (_, text, { schedule }) => {
      schedule("1 hour").note(text)
    },
    note: (tally, text) => {
      tally.notes.push(text)
    },
    forward: (tally, { to, amount }, { send }) => {
      tally.total -= amount
      send(Tally, to).add(amount)
    },
    tick: (tally) => {
      tally.notes.push("tick")
    },
  })

const catalogOf = <Name extends string>(
  actor: AnyActor,
  layer: Layer.Layer<Implementation<Name>>,
  shards: number,
) =>
  Effect.map(Layer.build(layer), (context): Catalog => ({
    actors: new Map([
      [actor.name, { actor, registered: Context.get(context, actor.implementation) }],
    ]),
    shards,
  }))

const logs = Effect.flatMap(SimulationService, (simulator) => simulator.logs)

const fingerprints = Effect.map(SimulationService, (simulator) =>
  Array.from({ length: simulator.catalog.shards }, (_, shard) => {
    const image = simulator.engine.durableImage(shard)
    return image === undefined ? "closed" : Recovery.fingerprint(image)
  }),
)

const workload = Effect.gen(function* () {
  const a = yield* Tally.client("a")
  const b = yield* Tally.client("b")
  yield* a.add(5)
  yield* b.add(7)
  yield* a.forward({ to: "b", amount: 2 })
  yield* a.remind("later")
  yield* b.add(1)
  yield* a.add(3)
})

describe("Recovery", () => {
  it("uploads independent actor pages concurrently but preserves captured order and waits for every page before publishing the root", () =>
    Simulation.run(
      { actors: [Tally], seed: 65, shards: 1, checkpointEvery: 0 },
      Effect.gen(function* () {
        for (const [key, amount] of [
          ["a", 5],
          ["b", 11],
          ["c", 19],
        ] as const)
          yield* (yield* Tally.client(key)).add(amount)
        yield* Simulation.settle
        const { engine } = yield* SimulationService
        const first = yield* Deferred.make<void>()
        const others = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let uploaded = 0
        let root = false
        const store = {
          ...engine.store,
          putPage: (bytes: Uint8Array) =>
            Effect.gen(function* () {
              const page = PageDocuments.decode(bytes)
              if (page.kind === "actor") {
                const value = page.value as { readonly key: string }
                if (value.key === "a") {
                  yield* Deferred.succeed(first, undefined)
                  yield* Deferred.await(release)
                } else {
                  uploaded++
                  if (uploaded === 2) yield* Deferred.succeed(others, undefined)
                }
              } else root = true
              return yield* engine.store.putPage(bytes)
            }),
        }
        const upload = yield* Effect.forkChild(
          PagedCheckpoints.write(engine.durableImage(0)!, store, engine.pages),
        )
        yield* Deferred.await(first)
        yield* Deferred.await(others)
        expect(root).toBe(false)
        expect(upload.pollUnsafe()).toBeUndefined()
        yield* (yield* Tally.client("a")).add(7)
        yield* Deferred.succeed(release, undefined)
        const prepared = yield* Fiber.join(upload)
        const captured = Result.getOrThrow(
          Checkpoints.decode(yield* PagedCheckpoints.materialize(prepared.hash, engine.store)),
        )
        expect(captured.actors.map(({ key, state }) => [key, state.total])).toEqual([
          ["a", 5],
          ["b", 11],
          ["c", 19],
        ])
        expect(root).toBe(true)
        prepared.committed()
        expect((yield* Simulation.state(Tally, "a")).total).toBe(12)
      }).pipe(Effect.scoped),
      handlers(1),
    ))

  it("captures the actor state, index and offset before a delayed upload, rejecting a checkpoint that drifts to later commits", () =>
    Simulation.run(
      { actors: [Tally], seed: 64, shards: 1, checkpointEvery: 0 },
      Effect.gen(function* () {
        const a = yield* Tally.client("a")
        const b = yield* Tally.client("b")
        yield* a.add(5)
        yield* b.add(11)
        yield* Simulation.settle
        const simulator = yield* SimulationService
        const engine = simulator.engine
        const image = engine.durableImage(0)!
        const offset = image.offset
        const upload = PagedCheckpoints.write(image, engine.store, engine.pages)
        yield* a.add(7)
        yield* b.add(13)
        yield* (yield* Tally.client("c")).add(19)
        yield* Simulation.settle
        const prepared = yield* engine.store.gc.protect(upload, (prepared) =>
          Effect.gen(function* () {
            yield* engine.store.checkpoint(engine.lease(0)!, {
              offset: BigInt(prepared.offset),
              statePages: [prepared.hash],
              indexPages: [prepared.hash],
              nextDue: prepared.nextDue,
            })
            prepared.committed()
            return prepared
          }),
        )
        const checkpoint = Result.getOrThrow(
          Checkpoints.decode(yield* PagedCheckpoints.materialize(prepared.hash, engine.store)),
        )
        expect(checkpoint.offset).toBe(offset)
        expect(checkpoint.actors.map(({ key, state }) => [key, state.total])).toEqual([
          ["a", 5],
          ["b", 11],
        ])
        expect(checkpoint.index?.map(({ id, fields }) => [id, fields.total])).toEqual([
          ["a", 5],
          ["b", 11],
        ])
        yield* Simulation.crash()
        const states = yield* Effect.forEach(["a", "b", "c"], (id) => Simulation.state(Tally, id))
        expect(states.map((state) => state.total)).toEqual([12, 24, 19])
        yield* Simulation.settle
      }).pipe(Effect.scoped),
      handlers(1),
    ))

  it("detaches a captured job workflow from later durable journal entries", () => {
    const image = Durable.empty(0)
    const workflow = [{ saved: "first" }]
    image.jobs.set("job", {
      jobId: "job",
      address: 'Tally/"a"',
      job: "work",
      payload: null,
      key: undefined,
      onBehalfOf: undefined,
      attempt: 0,
      at: 0,
      failure: undefined,
      done: undefined,
      suspended: undefined,
      workflow,
      steps: new Map(),
    })
    const checkpoint = Checkpoints.capture(image)
    workflow.push({ saved: "second" })
    expect(checkpoint.jobs[0]?.workflow).toEqual([{ saved: "first" }])
    expect(image.jobs.get("job")?.workflow).toEqual([{ saved: "first" }, { saved: "second" }])
  })

  it("reopens every shard after a crash and rebuilds it from its newest checkpoint and tail, to the same states, outcomes and timers", () =>
    Simulation.run(
      { actors: [Tally], seed: 61, shards: 2, checkpointEvery: 2 },
      Effect.gen(function* () {
        yield* workload
        yield* Simulation.settle
        const before = yield* fingerprints
        const stored = yield* logs
        expect(
          stored.some(
            (log) =>
              (log.checkpoints.at(-1)?.offset ?? Infinity) <
              Number(log.segments.at(-1)?.offset ?? -1n),
          ),
        ).toBe(true)
        const simulator = yield* SimulationService
        const images = [simulator.engine.durableImage(0), simulator.engine.durableImage(1)]
        yield* Simulation.crash()
        yield* Effect.forEach(["a", "b"], (id) => Simulation.state(Tally, id))
        expect(
          [simulator.engine.durableImage(0), simulator.engine.durableImage(1)].map(
            (image, shard) => image === images[shard],
          ),
        ).toEqual([false, false])
        expect(yield* fingerprints).toEqual(before)
        yield* Simulation.advance("1 day")
        const [a, b] = yield* Effect.all([
          Simulation.state(Tally, "a"),
          Simulation.state(Tally, "b"),
        ])
        expect([a.total, a.notes, b.total, b.notes]).toEqual([6, ["later", "tick"], 10, ["tick"]])
      }).pipe(Effect.scoped),
      handlers(1),
    ))

  it("runs every replayed action again: changed code under the same build stops the shard with ReplayMismatch", () =>
    Simulation.run(
      { actors: [Tally], seed: 62, shards: 1, checkpointEvery: 0 },
      Effect.gen(function* () {
        yield* workload
        yield* Simulation.settle
        const simulator = yield* SimulationService
        const [log] = yield* logs
        if (log === undefined) return yield* Effect.die(new Error("no log"))
        const live = simulator.engine.durableImage(0)
        if (live === undefined) return yield* Effect.die(new Error("shard closed"))
        const build = simulator.build
        const same = yield* catalogOf(Tally, handlers(1), 1)
        const changed = yield* catalogOf(Tally, handlers(2), 1)
        const replayed = Recovery.recover(same, 0, undefined, log.segments, build, "matching")
        expect(Result.isSuccess(replayed) && Recovery.fingerprint(replayed.success)).toBe(
          Recovery.fingerprint(live),
        )
        const refused = Recovery.recover(changed, 0, undefined, log.segments, build, "matching")
        expect(Result.isFailure(refused) && refused.failure._tag).toBe("ReplayMismatch")
      }).pipe(Effect.scoped),
      handlers(1),
    ))

  it("refuses a tail written by another build unless the operator replays it with the current build", () =>
    Simulation.run(
      { actors: [Tally], seed: 63, shards: 1, checkpointEvery: 0 },
      Effect.gen(function* () {
        yield* workload
        yield* Simulation.settle
        const simulator = yield* SimulationService
        const [log] = yield* logs
        if (log === undefined) return yield* Effect.die(new Error("no log"))
        const catalog = yield* catalogOf(Tally, handlers(1), 1)
        const other = { ...simulator.build, bundle: "another application" }
        const matching = Recovery.recover(catalog, 0, undefined, log.segments, other, "matching")
        expect(Result.isFailure(matching) && matching.failure._tag).toBe("BuildMismatch")
        expect(
          Result.isSuccess(Recovery.recover(catalog, 0, undefined, log.segments, other, "current")),
        ).toBe(true)
        const first = log.segments.findIndex((segment) => segment.entries.length > 0)
        const corrupt = log.segments.map((segment, index) =>
          index === first
            ? { ...segment, entries: segment.entries.map((bytes) => bytes.slice(1)) }
            : segment,
        )
        const broken = Recovery.recover(catalog, 0, undefined, corrupt, simulator.build, "matching")
        expect(Result.isFailure(broken) && broken.failure._tag).toBe("CorruptLog")
      }).pipe(Effect.scoped),
      handlers(1),
    ))
})
