import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, Option, Result, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Library, LibraryLive } from "../../../../tooling/conformance/src/conformance/pages.ts"
import { Entry, EntryCodec } from "../execution/entries.ts"
import { CorruptSegment } from "../store/errors.ts"
import { segmentKey } from "../store/keys.ts"
import { Simulation, SimulationService } from "../testing/index.ts"
import { ForkRefused, Forks } from "./forks.ts"

const grant = {
  operator: "operator:fork-classification",
  capabilities: [{ action: "fork" as const, tenant: "default" }],
}

const refusal = (result: Result.Result<unknown, unknown>) =>
  Result.isFailure(result) && Schema.is(ForkRefused)(result.failure)
    ? result.failure.reason
    : undefined

const ownAction = (bytes: Uint8Array) => {
  const entry = Result.getOrThrow(EntryCodec.decode(bytes))
  return Entry.guards.Action(entry) && entry.key === "source"
}

describe("fork history classification", () => {
  it("refuses a position older than every retained checkpoint after retention trimmed its log prefix, instead of CorruptSegment (rejects reading the trimmed prefix as corruption)", () =>
    Simulation.run(
      { actors: [Library], seed: 960, shards: 1, checkpointEvery: 0, runners: [{}, {}] },
      Effect.gen(function* () {
        const client = yield* Library.client("source")
        const simulator = yield* SimulationService
        const store = simulator.engine.store
        yield* client.fill(90)
        yield* Simulation.drain()
        yield* Simulation.advance("8 days")
        yield* Simulation.assign(0)
        yield* client.change(17)
        yield* Simulation.drain()
        const anchor = (yield* store.history.checkpoints(0)).at(-1)!
        yield* Simulation.advance("8 days")
        yield* Simulation.assign(0)
        yield* client.change(29)
        yield* Simulation.drain()
        const lease = yield* store.open(0)
        yield* TestClock.adjust("11 minutes")
        expect(yield* store.trim(lease, lease.head)).toBe(anchor.offset)
        expect(Option.isNone(yield* simulator.bucket.inspect.head(segmentKey(0, 1n)))).toBe(true)
        expect((yield* store.history.checkpoints(0))[0]!.offset).toBe(anchor.offset)
        yield* Simulation.assign(1)
        const expired = yield* simulator.waiting(
          Forks.fork(simulator.engine, {
            actor: Library,
            from: "source",
            to: "expired",
            at: { version: 1 },
            grant,
          }).pipe(Effect.result),
        )
        expect(refusal(expired)).toBe("retention")
        yield* simulator.waiting(
          Forks.fork(simulator.engine, {
            actor: Library,
            from: "source",
            to: "anchored",
            at: { version: 3 },
            grant,
          }),
        )
        expect((yield* Simulation.state(Library, "anchored")).count).toBe(92)
      }).pipe(Effect.scoped),
      LibraryLive,
    ))

  it("refuses for retention when the oldest retained checkpoint was written inside retention but every position it covers is outside it (rejects judging expiry by the checkpoint's own timestamp)", () =>
    Simulation.run(
      { actors: [Library], seed: 962, shards: 1, checkpointEvery: 0, runners: [{}, {}] },
      Effect.gen(function* () {
        const client = yield* Library.client("source")
        const simulator = yield* SimulationService
        const store = simulator.engine.store
        yield* client.fill(90)
        yield* Simulation.drain()
        yield* Simulation.advance("8 days")
        yield* Simulation.assign(0)
        yield* client.change(17)
        yield* Simulation.advance("1 hour")
        yield* Simulation.drain()
        const anchor = (yield* store.history.checkpoints(0)).at(-1)!
        yield* Simulation.advance("6 days")
        yield* TestClock.adjust("1410 minutes")
        const lease = yield* store.open(0)
        yield* TestClock.adjust("11 minutes")
        expect(yield* store.trim(lease, lease.head)).toBe(anchor.offset)
        expect(Option.isNone(yield* simulator.bucket.inspect.head(segmentKey(0, 1n)))).toBe(true)
        const [oldest] = yield* store.history.checkpoints(0)
        expect(oldest!.offset).toBe(anchor.offset)
        expect(oldest!.expired).toBe(true)
        const cutoff = (yield* Clock.currentTimeMillis) - (yield* store.retention)
        expect(oldest!.modified >= cutoff).toBe(true)
        yield* Simulation.assign(1)
        const expired = yield* simulator.waiting(
          Forks.fork(simulator.engine, {
            actor: Library,
            from: "source",
            to: "expired",
            at: { version: 1 },
            grant,
          }).pipe(Effect.result),
        )
        expect(refusal(expired)).toBe("retention")
      }).pipe(Effect.scoped),
      LibraryLive,
    ))

  it("reports CorruptSegment for an in-window position whose log prefix is missing without a retention trim (rejects mapping every unreadable prefix to a retention refusal)", () =>
    Simulation.run(
      { actors: [Library], seed: 961, shards: 1, checkpointEvery: 0, runners: [{}, {}] },
      Effect.gen(function* () {
        const client = yield* Library.client("source")
        const simulator = yield* SimulationService
        const store = simulator.engine.store
        yield* client.fill(90)
        yield* Simulation.drain()
        yield* Simulation.assign(0)
        yield* client.change(17)
        yield* Simulation.drain()
        const segments = yield* Stream.runCollect(store.read(0, 0n))
        const filled = segments.find((segment) => segment.entries.some(ownAction))!
        const oldest = (yield* store.history.checkpoints(0))[0]!
        expect(oldest.offset >= filled.offset).toBe(true)
        yield* simulator.bucket.inspect.delete([segmentKey(0, 1n)])
        yield* Simulation.assign(1)
        const lost = yield* simulator.waiting(
          Forks.fork(simulator.engine, {
            actor: Library,
            from: "source",
            to: "lost",
            at: { offset: Number(filled.offset), index: filled.entries.findIndex(ownAction) },
            grant,
          }).pipe(Effect.result),
        )
        expect(Result.isFailure(lost) && Schema.is(CorruptSegment)(lost.failure)).toBe(true)
        expect(refusal(lost)).toBeUndefined()
      }).pipe(Effect.scoped),
      LibraryLive,
    ))

  it("reports CorruptSegment when every segment through the oldest checkpoint is lost inside retention without a trim (rejects judging expiry by which in-window segments survive)", () =>
    Simulation.run(
      { actors: [Library], seed: 963, shards: 1, checkpointEvery: 0, runners: [{}, {}] },
      Effect.gen(function* () {
        const client = yield* Library.client("source")
        const simulator = yield* SimulationService
        const store = simulator.engine.store
        yield* client.fill(90)
        yield* Simulation.drain()
        yield* Simulation.assign(0)
        yield* client.change(17)
        yield* Simulation.drain()
        yield* TestClock.adjust("5 minutes")
        const segments = yield* Stream.runCollect(store.read(0, 0n))
        const filled = segments.find((segment) => segment.entries.some(ownAction))!
        const oldest = (yield* store.history.checkpoints(0))[0]!
        expect(oldest.offset >= filled.offset).toBe(true)
        const lost = segments.filter((segment) => segment.offset <= oldest.offset)
        expect(lost.length).toBeGreaterThan(1)
        yield* simulator.bucket.inspect.delete(lost.map((segment) => segmentKey(0, segment.offset)))
        expect((yield* store.history.checkpoints(0))[0]!.expired).toBe(true)
        yield* Simulation.assign(1)
        const forked = yield* simulator.waiting(
          Forks.fork(simulator.engine, {
            actor: Library,
            from: "source",
            to: "lost",
            at: { offset: Number(filled.offset), index: filled.entries.findIndex(ownAction) },
            grant,
          }).pipe(Effect.result),
        )
        expect(Result.isFailure(forked) && Schema.is(CorruptSegment)(forked.failure)).toBe(true)
        expect(refusal(forked)).toBeUndefined()
      }).pipe(Effect.scoped),
      LibraryLive,
    ))
})
