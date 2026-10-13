import { describe, expect, it } from "@effect/vitest"
import { TestClock } from "effect/testing"
import { Cause, Effect, Exit, Option, Result, Schema } from "effect"
import { Library, LibraryLive } from "../../../../tooling/conformance/src/conformance/pages.ts"
import { Simulation, SimulationService } from "../testing/index.ts"
import { Forks } from "./forks.ts"
import { PageDocuments } from "../handlers/page-tree.ts"
import { Entry, EntryCodec } from "../execution/entries.ts"
import { Checkpoints } from "./checkpoint.ts"
import { PageCorrupt } from "../store/errors.ts"
import { checkpointKey, pageKey } from "../store/keys.ts"
import { Store } from "../store/service.ts"
import { collect } from "../store/layer.ts"
import { ForkRefused } from "./forks.ts"

const grant = {
  operator: "operator:seed",
  capabilities: [{ action: "fork" as const, tenant: "default" }],
}

const scenario = Effect.gen(function* () {
  const client = yield* Library.client("source")
  yield* client.fill(90)
  yield* client.remember(31)
  yield* Simulation.settle
  const simulator = yield* SimulationService
  yield* simulator.waiting(
    Forks.fork(simulator.engine, {
      actor: Library,
      from: "source",
      to: "branch",
      at: { version: 1 },
      grant,
    }),
  )
  yield* client.change(53)
  yield* Simulation.settle
  yield* Simulation.assign(1)
  expect((yield* Simulation.state(Library, "branch")).count).toBe(90)
  expect((yield* Simulation.state(Library, "branch")).items.find((item) => item.id === 53)).toEqual(
    { id: 53, at: 37, text: "53:" + "x".repeat(1100) },
  )
  expect((yield* Simulation.state(Library, "source")).count).toBe(90 + 31 + 1)
  yield* simulator.waiting(
    Forks.fork(simulator.engine, {
      actor: Library,
      from: "branch",
      to: "again",
      at: { version: 0 },
      grant,
    }),
  )
  yield* Simulation.settle
  const collected = yield* simulator.engine.store.gc.collect({
    references: (bytes) => {
      try {
        return PageDocuments.references(bytes)
      } catch (error) {
        if (Result.isSuccess(Checkpoints.decode(bytes))) return []
        throw error
      }
    },
    entryReferences: (bytes) => {
      const entry = Result.getOrThrow(EntryCodec.decode(bytes))
      return Entry.guards.Forked(entry) ? [entry.manifest] : []
    },
  })
  expect(collected.outcome).toBe("collected")
  yield* Simulation.assign(0)
  yield* Simulation.crash()
  expect((yield* Simulation.state(Library, "again")).items).toEqual(
    (yield* Simulation.state(Library, "branch")).items,
  )
  yield* Simulation.settle
  return (yield* simulator.logs).map((log) => ({
    segments: log.segments.map((segment) => segment.entries.map((bytes) => Array.from(bytes))),
    checkpoints: log.checkpoints.map((checkpoint) => Array.from(checkpoint.bytes)),
  }))
}).pipe(Effect.scoped)

describe("E6 seeded page and history evidence", () => {
  it("seed 900: retains an expired checkpoint and its complete boundary tail for an in-window fork, then releases the old anchor", async () => {
    await Simulation.run(
      { actors: [Library], seed: 900, shards: 1, checkpointEvery: 0, runners: [{}, {}] },
      Effect.gen(function* () {
        const client = yield* Library.client("source")
        const simulator = yield* SimulationService
        yield* client.fill(90)
        yield* Simulation.drain()
        const store = simulator.engine.store
        const old = (yield* store.history.checkpoints(0)).at(-1)!
        yield* Simulation.assign(0)
        yield* (yield* Library.client("other")).fill(7)
        yield* Simulation.crash()
        yield* Simulation.advance("8 days")
        yield* Simulation.assign(0)
        yield* client.change(17)
        yield* client.change(29)
        yield* Simulation.settle
        yield* Simulation.drain()
        const lease = yield* store.open(0)
        yield* TestClock.adjust("11 minutes")
        expect(yield* store.trim(lease, lease.head)).toBe(old.offset)
        expect(
          (yield* store.history.checkpoints(0)).some(
            (checkpoint) => checkpoint.offset === old.offset,
          ),
        ).toBe(true)
        expect((yield* collect().pipe(Effect.provideService(Store, store))).outcome).toBe(
          "collected",
        )
        yield* Simulation.assign(1)
        yield* simulator.waiting(
          Forks.fork(simulator.engine, {
            actor: Library,
            from: "source",
            to: "recent",
            at: { version: 2 },
            grant,
          }),
        )
        const branch = yield* Simulation.state(Library, "recent")
        expect(branch.count).toBe(91)
        expect((yield* Simulation.state(Library, "other")).count).toBe(7)
        expect(branch.items.map((item) => item.id).sort((a, b) => a - b)).toEqual(
          Array.from({ length: 90 }, (_, id) => id),
        )
        expect(branch.items.find((item) => item.id === 17)).toEqual({
          id: 17,
          at: -7,
          text: "changed",
        })
        expect(branch.items.find((item) => item.id === 29)).toEqual({
          id: 29,
          at: 61,
          text: "29:" + "x".repeat(1100),
        })
        const expired = yield* simulator.waiting(
          Forks.fork(simulator.engine, {
            actor: Library,
            from: "source",
            to: "expired",
            at: { version: 1 },
            grant,
          }).pipe(Effect.result),
        )
        expect(
          Result.isFailure(expired) &&
            Schema.is(ForkRefused)(expired.failure) &&
            expired.failure.reason,
        ).toBe("retention")
        yield* Simulation.drain()
        yield* TestClock.adjust("8 days")
        expect(
          (yield* collect().pipe(Effect.provideService(Store, simulator.engine.store))).outcome,
        ).toBe("collected")
        expect(
          Option.isNone(yield* simulator.bucket.inspect.get(checkpointKey(0, old.offset))),
        ).toBe(true)
        expect(
          Option.isNone(yield* simulator.bucket.inspect.get(pageKey(old.statePages[0]!))),
        ).toBe(true)
        yield* Simulation.assign(1)
        expect((yield* Simulation.state(Library, "recent")).items).toEqual(branch.items)
      }).pipe(Effect.scoped),
      LibraryLive,
    )
  }, 120_000)

  it("F20/F21 and I6/I7: rejects forks of current state, incorrect lineage, and a sweep of reachable list pages across 40 seeds", async () => {
    for (let seed = 100; seed < 140; seed++)
      await Simulation.run(
        { actors: [Library], seed, shards: 1, checkpointEvery: 2, runners: [{}, {}] },
        scenario,
        LibraryLive,
      )
  }, 120_000)

  it("replays E6 log and checkpoint bytes exactly for eight seeds", async () => {
    for (let seed = 200; seed < 208; seed++) {
      const run = () =>
        Simulation.run(
          { actors: [Library], seed, shards: 1, checkpointEvery: 2, runners: [{}, {}] },
          scenario,
          LibraryLive,
        )
      expect(await run()).toEqual(await run())
    }
  }, 120_000)

  it("F22: rejects a corrupt cold leaf after an owner move instead of publishing default or partial list state across 20 seeds", async () => {
    for (let seed = 300; seed < 320; seed++)
      await Simulation.run(
        { actors: [Library], seed, shards: 1, checkpointEvery: 0, runners: [{}, {}] },
        Effect.gen(function* () {
          const client = yield* Library.client("source")
          yield* client.fill(180)
          const simulator = yield* SimulationService
          expect((yield* Simulation.drain()).outcome).toBe("clean")
          const checkpoint = (yield* simulator.engine.store.history.checkpoints(0)).at(-1)!
          const root = PageDocuments.decode(
            yield* simulator.engine.store.getPage(checkpoint.statePages[0]!),
          )
          const actor = PageDocuments.decode(
            yield* simulator.engine.store.getPage(root.references[0]!),
          )
          const ordered = actor.references[1]!
          const tree = PageDocuments.decode(yield* simulator.engine.store.getPage(ordered))
          const leaf = tree.kind === "leaf" ? ordered : tree.references[0]!
          const original = Option.getOrThrow(yield* simulator.bucket.inspect.get(pageKey(leaf)))
          yield* simulator.bucket.inspect.put(pageKey(leaf), new Uint8Array([9, 1, 7]))
          yield* Simulation.assign(1)
          const failed = yield* simulator.waiting(
            client.items.range({ limit: 1 }).pipe(Effect.exit),
          )
          expect(Exit.isFailure(failed) && Schema.is(PageCorrupt)(Cause.squash(failed.cause))).toBe(
            true,
          )
          yield* simulator.bucket.inspect.put(pageKey(leaf), original)
          expect(yield* simulator.waiting(client.items.range({ limit: 1 }))).toEqual([
            { id: 179, at: 1, text: "179:" + "x".repeat(1100) },
          ])
        }).pipe(Effect.scoped),
        LibraryLive,
      )
  }, 120_000)
})
