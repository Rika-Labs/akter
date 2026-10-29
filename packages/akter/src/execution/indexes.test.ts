import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Fiber, Schema } from "effect"
import { Actor, anonymous } from "../index.ts"
import { FindCodec } from "../rpc/group.ts"
import { Finds } from "../contract/find.ts"
import { Simulation, SimulationService } from "../testing/index.ts"
import { Checkpoints } from "../snapshots/checkpoint.ts"
import { Indexes } from "./indexes.ts"
import { Operators } from "../runtime/operators/service.ts"
import { Origin } from "./entries.ts"
import { System } from "../contract/caller.ts"

class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}

const Item = Actor.make("IndexedItem", {
  state: Schema.Struct({
    score: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    label: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
    active: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
    at: Schema.DateTimeUtcFromMillis.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    optional: Schema.optional(Schema.String),
    nested: Schema.Struct({ value: Schema.Finite }).pipe(
      Schema.withDecodingDefault(Effect.succeed({ value: 0 })),
    ),
  }),
  commands: {
    set: Actor.command(Schema.Struct({ score: Schema.Finite, label: Schema.String })),
    reject: Actor.command({ fails: Refused }),
  },
})
const Live = Item.toLayer({
  set: (item, payload, { now }) => {
    item.score = payload.score
    item.label = payload.label
    item.active = payload.score > 0
    item.at = DateTime.makeUnsafe(now())
  },
  reject: (item) => {
    item.score = 999
    item.label = "discarded"
    return Refused.make({})
  },
})

describe("durable owner index", () => {
  it("rejects speculative publication, and loses neither old nor new entries after a crash and replay", () =>
    Simulation.run(
      {
        actors: [Item],
        seed: 91,
        checkpointEvery: 1,
        faults: ["slowLog"],
        rates: {
          crashBefore: 0,
          crashAfter: 0,
          lostResponse: 0,
          unavailable: 0,
          maxOutage: 0,
          slow: 1,
          maxDelayTurns: 40,
        },
      },
      Effect.scoped(
        Effect.gen(function* () {
          yield* Simulation.seed(Item, "z", { score: 7, label: "old" })
          yield* Simulation.settle
          const handle = yield* Item.client("z")
          const call = yield* Effect.forkChild(handle.set({ score: 13, label: "new" }))
          const simulator = yield* SimulationService
          for (let turn = 0; turn < 1_000; turn++) {
            if (simulator.engine.busy(0)?.includes("in flight") === true) break
            yield* Effect.yieldNow
          }
          expect(yield* Item.find({ where: { score: 7 } })).toEqual(["z"])
          expect(yield* Item.find({ where: { score: 13 } })).toEqual([])
          yield* Simulation.crash(Item, "z")
          yield* simulator.waiting(Fiber.join(call))
          yield* Simulation.settle
          expect(yield* Item.find({ where: { score: 7 } })).toEqual([])
          expect(yield* Item.find({ where: { score: { eq: 13 } } })).toEqual(["z"])
          yield* Effect.flip(handle.reject())
          yield* Simulation.crash(Item, "z")
          expect(yield* Item.find({ where: { label: "discarded" } })).toEqual([])
          expect(yield* Item.find({ where: { score: 13 } })).toEqual(["z"])
          yield* simulator.waiting(
            simulator.engineFor(Item, "z")!.execute({
              origin: Origin.cases.Delivery.make({ stream: "sender>target", sequence: 1 }),
              commandId: "rejected-send",
              actor: Item,
              keyJson: "z",
              member: "reject",
              payload: null,
              caller: System.make({ source: "send", subject: "actor:sender" }),
              connection: undefined,
            }),
          )
          const inspected = yield* Operators.make(simulator.engineFor(Item, "z")!).run(
            {
              operator: "test",
              capabilities: [
                { action: "inspect", tenant: "default", actorType: Item.name, actorId: "z" },
              ],
            },
            {
              operation: "inspect",
              tenant: "default",
              reason: "rejection tags",
              target: { actorType: Item.name, actorId: "z" },
            },
          )
          expect(inspected).toMatchObject({
            rejections: [{ commandId: "rejected-send", member: "reject", outcome: "Failure" }],
          })
          const shard = simulator.engineFor(Item, "z")!
          const image = shard.durableImage(shard.shardOf('IndexedItem/"z"'))!
          const snapshot = Checkpoints.capture(image)
          expect(snapshot.index).toEqual(Indexes.capture(image.index))
          expect(Indexes.capture(Checkpoints.restore(simulator.catalog, snapshot).index)).toEqual(
            snapshot.index,
          )
        }),
      ),
      Live,
    ))

  it("equals independently computed durable values across seeded changes, checkpoints, crashes and split-owner moves", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (let seed = 0; seed < 32; seed++)
          yield* Effect.promise(() =>
            Simulation.run(
              {
                actors: [Item],
                seed: seed + 2_301,
                runners: [{}, {}],
                assignments: [0, 1, 0, 1],
                checkpointEvery: 2,
              },
              Effect.scoped(
                Effect.gen(function* () {
                  const expected = new Map<string, number>()
                  for (let i = 0; i < 20; i++) {
                    const id = `i${(i * 7 + seed) % 9}`
                    const score = ((seed * 13 + i * 19) % 41) - 10
                    const handle = yield* Item.client(id)
                    yield* handle.set({ score, label: `v${i}` })
                    expected.set(id, score)
                    if (i % 4 === 0) yield* Simulation.crash(Item, id)
                    if (i === 9) yield* Simulation.assignShards(1, [0, 1])
                    const ids = Array.from(expected)
                      .filter(([, n]) => n >= 7 && n < 29)
                      .sort(([a, x], [b, y]) => x - y || (a < b ? -1 : 1))
                      .slice(0, 3)
                      .map(([id]) => id)
                    expect(
                      yield* Item.find({
                        where: { score: { gte: 7, lt: 29 } },
                        orderBy: { field: "score" },
                        limit: 3,
                      }),
                    ).toEqual(ids)
                    const simulator = yield* SimulationService
                    for (let shard = 0; shard < simulator.catalog.shards; shard++) {
                      const owner = simulator.runners.find(
                        (runner) => runner.engine.status(shard).assigned,
                      )
                      const image = owner?.engine.durableImage(shard)
                      if (image === undefined) continue
                      const expectedRows = Array.from(image.actors.values())
                        .filter((record) => record.created)
                        .map((record) => ({
                          actor: Item.name,
                          id: record.keyJson,
                          fields: {
                            score: record.image.state.score,
                            label: record.image.state.label
                              .split("")
                              .map((point: string) =>
                                point.charCodeAt(0).toString(16).padStart(2, "0"),
                              )
                              .join(""),
                            active: record.image.state.score > 0,
                            at: DateTime.toEpochMillis(record.image.state.at),
                          },
                        }))
                      const sorted = (rows: ReadonlyArray<(typeof expectedRows)[number]>) =>
                        Array.from(rows).sort((a, b) => {
                          const x = JSON.stringify(a.id)
                          const y = JSON.stringify(b.id)
                          return x < y ? -1 : x > y ? 1 : 0
                        })
                      expect(sorted(Indexes.capture(image.index) as typeof expectedRows)).toEqual(
                        sorted(expectedRows),
                      )
                    }
                  }
                  yield* Simulation.settle
                }),
              ),
              Live,
            ),
          )
      }),
    ))

  it("uses byte prefixes and deterministic id ties and refuses non-scalars, invalid limits and denied find access", () =>
    Simulation.run(
      { actors: [Item], seed: 171 },
      Effect.scoped(
        Effect.gen(function* () {
          const prefix = "a".repeat(63)
          for (const [id, label] of [
            ["z", `${prefix}éz`],
            ["b", `${prefix}êb`],
            ["m", `${prefix}z`],
          ] as const) {
            const handle = yield* Item.client(id)
            yield* handle.set({ score: 8, label })
          }
          expect(yield* Item.find({ orderBy: { field: "label" } })).toEqual(["m", "b", "z"])
          expect(yield* Item.find({ where: { label: `${prefix}é-other` } })).toEqual(["b", "z"])
          expect(yield* Item.find({ orderBy: { field: "label", direction: "desc" } })).toEqual([
            "b",
            "z",
            "m",
          ])
          const malformed = yield* Effect.flip(
            FindCodec.decode(Item, { where: {}, orderBy: { field: "nested" } }),
          )
          expect(malformed.reason._tag).toBe("InvalidInput")
          expect((yield* Effect.flip(Item.find({ limit: 1_001 }))).reason._tag).toBe("InvalidInput")
          const simulator = yield* SimulationService
          const denied = yield* Effect.flip(
            simulator.client(anonymous).find({ actor: Item, query: {} }),
          )
          expect(denied.reason._tag).toBe("Unauthorized")
          expect(Finds.field(Item, "nested")).toBeUndefined()
          expect((yield* Effect.flip(Item.find({ limit: -1 }))).reason._tag).toBe("InvalidInput")
        }),
      ),
      Live,
    ))
})
