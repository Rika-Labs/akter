import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Option, Result, Schedule, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Library, LibraryLive } from "../../../../tooling/conformance/src/conformance/pages.ts"
import { Operators } from "../runtime/operators/service.ts"
import { ForkRefused, Forks } from "../snapshots/forks.ts"
import { Simulation, SimulationService } from "../testing/index.ts"
import { collect, retention, setRetention } from "./layer.ts"
import { Fault, Faults } from "./faults.ts"
import { checkpointKey, checkpointPrefix, logPrefix, pageKey, segmentKey } from "./keys.ts"
import { memoryBucket } from "./memory.ts"
import { HistoryExpired } from "./retention.ts"
import { Store, storeOf } from "./service.ts"

const change = {
  grant: {
    operator: "plan-operator",
    capabilities: [{ action: "retention.set" as const, tenant: "*" }],
  },
  reason: "plan changed",
}
const forkGrant = {
  operator: "fork-operator",
  capabilities: [{ action: "fork" as const, tenant: "default" }],
}
const DAY = 86_400_000
const text = (value: string) => new TextEncoder().encode(value)

describe("changeable retention", () => {
  it.effect(
    "seeds 910–917: widening preserves 30-day history; narrowing keeps the anchor chain and immediately changes fork/log admission (rejects open-time caching and anchor loss)",
    () =>
      Effect.gen(function* () {
        for (let seed = 910; seed < 918; seed++)
          yield* Effect.promise(() =>
            Simulation.run(
              { actors: [Library], seed, shards: 1, checkpointEvery: 0, runners: [{}, {}] },
              Effect.gen(function* () {
                const client = yield* Library.client("source")
                const simulator = yield* SimulationService
                const store = simulator.engine.store
                yield* client.fill(90)
                yield* Simulation.drain()
                const first = (yield* store.history.checkpoints(0)).at(-1)!
                yield* Simulation.advance("10 days")
                yield* Simulation.assign(0)
                yield* client.change(17)
                yield* Simulation.drain()
                const anchor = (yield* store.history.checkpoints(0)).at(-1)!
                yield* Simulation.advance("8 days")
                yield* Simulation.assign(0)
                yield* client.change(29)
                yield* Simulation.drain()
                yield* Simulation.advance("2 days")
                yield* setRetention("30 days", change).pipe(Effect.provideService(Store, store))
                expect(yield* retention.pipe(Effect.provideService(Store, store))).toBe(30 * DAY)
                expect(
                  (yield* collect().pipe(Effect.provideService(Store, store))).deletedCheckpoints,
                ).toBe(0)
                expect(
                  Option.isSome(
                    yield* simulator.bucket.inspect.get(checkpointKey(0, first.offset)),
                  ),
                ).toBe(true)
                expect(
                  Option.isSome(yield* simulator.bucket.inspect.get(pageKey(first.statePages[0]!))),
                ).toBe(true)
                const lease = yield* store.open(0)
                yield* TestClock.adjust("11 minutes")
                expect(yield* store.trim(lease, lease.head)).toBe(0n)
                expect(
                  Option.isSome(yield* simulator.bucket.inspect.get(segmentKey(0, first.offset))),
                ).toBe(true)
                yield* Simulation.assign(1)
                const fork = (to: string, version: number) =>
                  simulator.waiting(
                    Forks.fork(simulator.engine, {
                      actor: Library,
                      from: "source",
                      to,
                      at: { version },
                      grant: forkGrant,
                    }),
                  )
                yield* fork("wide", 1)
                expect((yield* Simulation.state(Library, "wide")).count).toBe(90)
                yield* store.setRetention("7 days", change)
                const denied = yield* Effect.result(fork("narrow", 2))
                expect(
                  Result.isFailure(denied) &&
                    Schema.is(ForkRefused)(denied.failure) &&
                    denied.failure.reason,
                ).toBe("retention")
                const expired = yield* Effect.flip(
                  Stream.runCollect(store.history.read(0, first.offset)),
                )
                expect(expired).toBeInstanceOf(HistoryExpired)
                const log = yield* Operators.make(simulator.engine).run(
                  { operator: "logs", capabilities: [{ action: "log.read", tenant: "default" }] },
                  {
                    operation: "log",
                    target: { shard: 0 },
                    tenant: "default",
                    reason: "history boundary",
                  },
                )
                const decoded = yield* Schema.decodeUnknownEffect(
                  Schema.Struct({
                    entries: Schema.Array(
                      Schema.Struct({
                        entry: Schema.Struct({ member: Schema.optionalKey(Schema.String) }),
                      }),
                    ),
                  }),
                )(log)
                expect(decoded.entries.some(({ entry }) => entry.member === "fill")).toBe(false)
                expect(
                  (yield* collect().pipe(Effect.provideService(Store, store))).deletedCheckpoints,
                ).toBeGreaterThan(0)
                expect(
                  Option.isNone(
                    yield* simulator.bucket.inspect.get(checkpointKey(0, first.offset)),
                  ),
                ).toBe(true)
                expect(
                  Option.isSome(
                    yield* simulator.bucket.inspect.get(checkpointKey(0, anchor.offset)),
                  ),
                ).toBe(true)
                const trimming = yield* store.open(0)
                yield* TestClock.adjust("11 minutes")
                expect(yield* store.trim(trimming, trimming.head)).toBe(anchor.offset)
                const remaining = yield* simulator.bucket.inspect.list(logPrefix(0))
                expect(
                  remaining.every(
                    (key) => BigInt(`0x${key.slice(logPrefix(0).length)}`) > anchor.offset,
                  ),
                ).toBe(true)
                yield* Simulation.assign(0)
                yield* fork("anchored", 3)
                const branch = yield* Simulation.state(Library, "anchored")
                expect(branch.count).toBe(92)
                expect(branch.items.find(({ id }) => id === 17)?.text).toBe("changed")
                expect(branch.items.find(({ id }) => id === 29)?.text).toBe("changed")
              }).pipe(Effect.scoped),
              LibraryLive,
            ),
          )
      }),
  )

  it.effect(
    "captures retention once under the GC epoch across shards, applying a concurrent narrowing only on the next pass (rejects mixed-value marking)",
    () =>
      Effect.gen(function* () {
        const bucket = memoryBucket()
        const faults = Faults.plan()
        const store = yield* storeOf(bucket, { shards: 2, faults, retry: Schedule.recurs(2) })
        const old: Array<string> = []
        for (let shard = 0; shard < 2; shard++) {
          const lease = yield* store.open(shard)
          const hash = yield* store.putPage(text(`old:${shard}`))
          old.push(hash)
          yield* store.checkpoint(lease, { offset: lease.head, statePages: [hash], indexPages: [] })
          yield* store.append(lease, [text("latest")])
          const newest = yield* store.putPage(text(`new:${shard}`))
          yield* store.checkpoint(lease, {
            offset: lease.head,
            statePages: [newest],
            indexPages: [],
          })
        }
        yield* TestClock.adjust("20 days")
        yield* store.setRetention("30 days", change)
        const held = yield* faults.inject(Fault.Hold(), {
          match: ({ kind, key }) => kind === "list" && key === checkpointPrefix(1),
        })
        const collecting = yield* Effect.forkChild(
          store.gc.collect({ references: () => [], entryReferences: () => [] }),
        )
        yield* held.fired
        yield* store.setRetention("7 days", change)
        yield* held.release
        expect(yield* Fiber.join(collecting)).toMatchObject({
          deletedPages: 0,
          deletedCheckpoints: 0,
          marked: 4,
        })
        for (let shard = 0; shard < 2; shard++) {
          expect(Option.isSome(yield* bucket.get(checkpointKey(shard, 1n)))).toBe(true)
          expect(Option.isSome(yield* bucket.get(pageKey(old[shard]!)))).toBe(true)
        }
        expect(
          yield* store.gc.collect({ references: () => [], entryReferences: () => [] }),
        ).toMatchObject({ deletedPages: 2, deletedCheckpoints: 2, marked: 2 })
      }),
  )
})
