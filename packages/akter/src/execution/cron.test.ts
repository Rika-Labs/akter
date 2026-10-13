import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Actor } from "../index.ts"
import { Simulation, SimulationService } from "../testing/index.ts"
import { Entry, EntryCodec, Origin } from "./entries.ts"

const Counter = Actor.make("CronCounter", {
  state: Schema.Struct({
    ticks: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  actions: { tick: Actor.action({ cron: "@every 15 seconds" }) },
})

const CounterLive = Counter.toLayer({
  tick: (counter) => {
    counter.ticks += 1
  },
})

describe("cron downtime without a backlog", () => {
  it("fires one still-fresh pending tick after many missed intervals and durably resumes after now", () =>
    Simulation.run(
      { actors: [Counter], seed: 129, shards: 1, runners: [{}, {}] },
      Effect.scoped(
        Effect.gen(function* () {
          yield* Simulation.seed(Counter, "a", {})
          expect(yield* Simulation.drain()).toMatchObject({
            outcome: "clean",
            shards: [{ shard: 0, nextDue: 15_000 }],
          })
          yield* TestClock.adjust(1_807_000)
          yield* Simulation.assign(1)
          yield* Simulation.settle
          expect((yield* Simulation.state(Counter, "a")).ticks).toBe(1)
          const simulator = yield* SimulationService
          expect(simulator.engine.nextTimer(true)).toBe(1_815_000)
          const log = (yield* simulator.logs).flatMap((shard) =>
            shard.segments.flatMap((segment) =>
              segment.entries.map((bytes) => Result.getOrThrow(EntryCodec.decode(bytes))),
            ),
          )
          const fired = log.filter(
            (entry) => Entry.guards.Action(entry) && Origin.guards.Fired(entry.origin),
          )
          expect(fired).toHaveLength(1)
          expect(log.filter(Entry.guards.Skipped)).toHaveLength(0)
          expect(yield* Simulation.drain()).toMatchObject({
            outcome: "clean",
            shards: [{ shard: 0, nextDue: 1_815_000 }],
          })
          yield* Simulation.assign(0)
          yield* Simulation.settle
          expect((yield* Simulation.state(Counter, "a")).ticks).toBe(1)
          yield* Simulation.advance(7_999)
          expect((yield* Simulation.state(Counter, "a")).ticks).toBe(1)
          yield* Simulation.advance(1)
          expect((yield* Simulation.state(Counter, "a")).ticks).toBe(2)
        }),
      ),
      CounterLive,
    ))
})
