import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Fiber, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Actor } from "../index.ts"
import type { Catalog } from "../execution/durable.ts"
import { Engine } from "../execution/engine.ts"
import { Fault, Faults } from "../store/faults.ts"
import { memoryBucket } from "../store/memory.ts"
import { Store, storeOf } from "../store/service.ts"

const Counter = Actor.make("Counter", {
  state: Schema.Struct({ count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  actions: { add: Actor.action(Schema.Int, { success: Schema.Int }) },
})

const CounterLive = Counter.toLayer({
  add: (counter, amount) => {
    counter.count += amount
    return counter.count
  },
})

const SHARDS = 16

/** One provider round trip, the order of a Tigris request from the evidence run. */
const ROUND_TRIP = "125 millis"

describe("drain over a provider with request latency", () => {
  it.effect(
    "releases all 16 shards within a 15-second deadline at 125 ms per request and leaves the publication barrier idle (rejects one publishing epoch per shard checkpoint, serialized store-wide)",
    () =>
      Effect.gen(function* () {
        const bucket = memoryBucket()
        const faults = Faults.plan()
        const store = yield* storeOf(bucket, { shards: SHARDS, writer: "drainer", faults })
        const context = yield* Layer.build(CounterLive)
        const catalog: Catalog = {
          actors: new Map([
            [
              Counter.name,
              { actor: Counter, registered: Context.get(context, Counter.implementation) },
            ],
          ]),
          shards: SHARDS,
        }
        const engine = yield* Engine.make(catalog, {
          shards: SHARDS,
          policy: "matching",
          maxBatch: 64,
          checkpointEvery: 64,
          cronSkipIfOlderThan: 3_600_000,
          doubleRun: false,
          observer: undefined,
        }).pipe(Effect.provideService(Store, store))
        yield* engine.assign(Array.from({ length: SHARDS }, (_, id) => id))
        for (
          let turn = 0;
          turn < 1000 && !engine.shards().every(({ status }) => status === "open");
          turn++
        )
          yield* TestClock.adjust("10 millis")
        expect(engine.shards().every(({ status }) => status === "open")).toBe(true)
        yield* faults.inject(Fault.Delay({ duration: ROUND_TRIP }), {
          times: Number.POSITIVE_INFINITY,
        })
        const draining = yield* Effect.forkChild(engine.drain("15 seconds"))
        yield* TestClock.adjust("16 seconds")
        const report = yield* Fiber.join(draining)
        expect(report.outcome).toBe("clean")
        expect(report.shards).toHaveLength(SHARDS)
        const epochs = yield* bucket.list("gc/")
        const newest = Option.getOrThrow(yield* bucket.get(epochs.at(-1)!))
        expect(new TextDecoder().decode(newest)).toContain("idle")
      }).pipe(Effect.scoped),
  )
})
