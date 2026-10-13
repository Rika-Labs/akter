import { describe, expect, it } from "@effect/vitest"
import {
  Clock,
  Context,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Random,
  Result,
  Schedule,
} from "effect"
import { TestClock } from "effect/testing"
import { SeededScheduler } from "../testing/seeded-scheduler.ts"
import { SimulatedBucket } from "../testing/simulated-bucket.ts"
import type { Bucket } from "./bucket.ts"
import { PageCorrupt, StaleEpoch, StorageUnavailable } from "./errors.ts"
import { Fault, Faults } from "./faults.ts"
import { fileSystemBucket } from "./file-system.ts"
import { GcStaleEpoch, PagePublicationBusy } from "./gc.ts"
import { checkpointKey, pageKey, PAGES_PREFIX } from "./keys.ts"
import { memoryBucket } from "./memory.ts"
import { storeOf } from "./service.ts"

const platform =
  globalThis.Bun === undefined
    ? (await import("@effect/platform-node")).NodeServices.layer
    : (await import("@effect/platform-bun")).BunServices.layer

const text = (value: string) => new TextEncoder().encode(value)

const references = (bytes: Uint8Array): ReadonlyArray<string> => {
  const [kind, , ...hashes] = new TextDecoder().decode(bytes).split(":")
  return kind === "branch" ? hashes : []
}

const entryReferences = (bytes: Uint8Array): ReadonlyArray<string> => {
  const [kind, hash] = new TextDecoder().decode(bytes).split(":")
  return kind === "forked" && hash !== undefined ? [hash] : []
}

const RETRY = Schedule.recurs(4)

const failed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), (exit) => Option.getOrUndefined(Exit.findErrorOption(exit)))

const age = (bucket: Bucket, duration: number) =>
  Effect.gen(function* () {
    let latest = 0
    for (const key of yield* bucket.list(""))
      latest = Math.max(
        latest,
        Option.getOrElse(yield* bucket.modified(key), () => 0),
      )
    yield* TestClock.setTime(latest + duration)
  })

const DAY = 24 * 60 * 60 * 1000

const gcKey = (epoch: number) => `gc/${epoch.toString(16).padStart(16, "0")}`

const backends = [
  { name: "memory", namespace: Effect.succeed(Effect.sync(memoryBucket)) },
  {
    name: "file system",
    namespace: Effect.flatMap(Layer.build(platform), (services) =>
      Effect.map(
        Context.get(services, FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "akter-gc-",
        }),
        (directory) => fileSystemBucket(directory).pipe(Effect.provide(services)),
      ),
    ),
  },
]

for (const backend of backends)
  describe(`GC on ${backend.name}`, () => {
    it.effect(
      "retains an expired fork in the recovery tail until a newer checkpoint covers it (rejects retention-only marking of uncovered log entries)",
      () =>
        Effect.gen(function* () {
          const bucket = yield* yield* backend.namespace
          const store = yield* storeOf(bucket, { shards: 1, writer: "tail", retry: RETRY })
          const initial = yield* store.putPage(text("leaf:initial"))
          const fork = yield* store.putPage(text("leaf:fork-tail"))
          const lease = yield* store.open(0)
          yield* store.checkpoint(lease, {
            offset: lease.head,
            statePages: [initial],
            indexPages: [],
          })
          yield* store.append(lease, [text(`forked:${fork}`)])
          yield* age(bucket, 8 * DAY)
          expect(yield* store.gc.collect({ references, entryReferences })).toMatchObject({
            marked: 2,
            deletedPages: 0,
          })
          expect(yield* store.getPage(fork)).toEqual(text("leaf:fork-tail"))
          yield* store.checkpoint(lease, {
            offset: lease.head,
            statePages: [initial],
            indexPages: [],
          })
          expect(yield* store.gc.collect({ references, entryReferences })).toMatchObject({
            marked: 1,
            deletedPages: 1,
          })
          expect(yield* bucket.list(PAGES_PREFIX)).toEqual([pageKey(initial)])
        }),
    )

    it.effect(
      "marks nested state and index pages from every retained checkpoint (rejects newest-only roots or shallow marking)",
      () =>
        Effect.gen(function* () {
          yield* TestClock.setTime(yield* TestClock.withLive(Clock.currentTimeMillis))
          const bucket = yield* yield* backend.namespace
          const store = yield* storeOf(bucket, { writer: "a", shards: 2, retry: RETRY })
          const leaves = yield* Effect.forEach(["a", "b", "c"], (label) =>
            store.putPage(text(`leaf:${label}`)),
          )
          const roots = yield* Effect.forEach(leaves, (hash, index) =>
            store.putPage(text(`branch:${index}:${hash}`)),
          )
          const index = yield* store.putPage(text(`branch:index:${leaves[0]}`))
          const orphan = yield* store.putPage(text("leaf:orphan"))
          const first = yield* store.open(0)
          yield* store.checkpoint(first, {
            offset: first.head,
            statePages: [roots[0]!],
            indexPages: [index],
          })
          yield* store.append(first, [text("new state")])
          yield* store.checkpoint(first, {
            offset: first.head,
            statePages: [roots[1]!],
            indexPages: [],
          })
          const second = yield* store.open(1)
          yield* store.checkpoint(second, {
            offset: second.head,
            statePages: [roots[2]!],
            indexPages: [],
          })
          yield* age(bucket, DAY + 1)

          const result = yield* store.gc.collect({ references, entryReferences })
          expect(result).toMatchObject({
            outcome: "collected",
            marked: 7,
            deletedPages: 1,
            deletedCheckpoints: 0,
          })
          expect(yield* bucket.list(PAGES_PREFIX)).toEqual(
            [...leaves, ...roots, index].map(pageKey).sort(),
          )
          expect(yield* bucket.head(pageKey(orphan))).toEqual(Option.none())
          expect(Option.isSome(yield* bucket.get(checkpointKey(0, 1n)))).toBe(true)
        }),
    )

    it.effect(
      "drops expired checkpoints but roots each shard's newest even when expired (rejects deleting the last checkpoint or protecting all history forever)",
      () =>
        Effect.gen(function* () {
          yield* TestClock.setTime(yield* TestClock.withLive(Clock.currentTimeMillis))
          const bucket = yield* yield* backend.namespace
          const store = yield* storeOf(bucket, {
            writer: "a",
            shards: 2,
            retention: "2 days",
            retry: RETRY,
          })
          const leaves = yield* Effect.forEach(["expired", "newest", "other shard"], (label) =>
            store.putPage(text(`leaf:${label}`)),
          )
          const roots = yield* Effect.forEach(leaves, (hash, index) =>
            store.putPage(text(`branch:${index}:${hash}`)),
          )
          const first = yield* store.open(0)
          yield* store.checkpoint(first, {
            offset: first.head,
            statePages: [roots[0]!],
            indexPages: [],
          })
          yield* store.append(first, [text("updated")])
          yield* store.checkpoint(first, {
            offset: first.head,
            statePages: [roots[1]!],
            indexPages: [],
          })
          const second = yield* store.open(1)
          yield* store.checkpoint(second, {
            offset: second.head,
            statePages: [roots[2]!],
            indexPages: [],
          })
          yield* age(bucket, 3 * DAY)

          const result = yield* store.gc.collect({ references, entryReferences, batchSize: 1 })
          expect(result).toMatchObject({
            outcome: "collected",
            marked: 4,
            deletedPages: 2,
            deletedCheckpoints: 1,
          })
          expect(yield* bucket.list(PAGES_PREFIX)).toEqual(
            [...leaves.slice(1), ...roots.slice(1)].map(pageKey).sort(),
          )
          expect(yield* bucket.get(checkpointKey(0, 1n))).toEqual(Option.none())
          expect(Option.isSome(yield* bucket.get(checkpointKey(0, 2n)))).toBe(true)
          expect(Option.isSome(yield* bucket.get(checkpointKey(1, 1n)))).toBe(true)
        }),
    )

    it.effect(
      "aborts before sweep on corrupt reachable pages (rejects treating a failed mark as an empty root)",
      () =>
        Effect.gen(function* () {
          const bucket = yield* yield* backend.namespace
          const faults = Faults.plan()
          const store = yield* storeOf(bucket, { writer: "a", shards: 1, faults, retry: RETRY })
          const leaf = yield* store.putPage(text("leaf:protected"))
          const root = yield* store.putPage(text(`branch:root:${leaf}`))
          const orphan = yield* store.putPage(text("leaf:orphan"))
          const lease = yield* store.open(0)
          yield* store.checkpoint(lease, { offset: lease.head, statePages: [root], indexPages: [] })
          yield* bucket.put(pageKey(leaf), text("wrong hash"))
          yield* age(bucket, DAY + 1)

          const exit = yield* Effect.exit(store.gc.collect({ references, entryReferences }))
          const defect = Exit.findDefect(exit)
          expect(Result.isSuccess(defect) ? defect.success : undefined).toBeInstanceOf(PageCorrupt)
          expect((yield* faults.operations).filter(({ kind }) => kind === "delete")).toEqual([])
          expect(Option.isSome(yield* bucket.get(pageKey(orphan)))).toBe(true)
        }),
    )

    it.effect(
      "takes over expired marking and fences the paused collector (rejects an immortal lease or deletion without rechecking the newest epoch)",
      () =>
        Effect.gen(function* () {
          const bucket = yield* yield* backend.namespace
          const faults = Faults.plan()
          const a = yield* storeOf(bucket, { writer: "a", shards: 1, faults, retry: RETRY })
          const b = yield* storeOf(bucket, { writer: "b", retry: RETRY })
          const orphan = yield* a.putPage(text("orphan"))
          yield* age(bucket, DAY + 1)
          const held = yield* faults.inject(Fault.Hold(), {
            match: ({ kind, key }) => kind === "list" && key === PAGES_PREFIX,
          })
          const collecting = yield* Effect.forkChild(a.gc.collect({ references, entryReferences }))
          yield* held.fired
          const original = yield* bucket.get(gcKey(1))
          expect(yield* b.gc.collect({ references, entryReferences })).toMatchObject({
            outcome: "busy",
            epoch: 1n,
          })
          yield* TestClock.adjust("11 minutes")
          expect(yield* b.gc.collect({ references, entryReferences })).toMatchObject({
            outcome: "collected",
            deletedPages: 1,
          })
          yield* held.release
          expect(
            Option.getOrUndefined(Exit.findErrorOption(yield* Fiber.await(collecting))),
          ).toBeInstanceOf(GcStaleEpoch)
          expect((yield* faults.operations).filter(({ kind }) => kind === "delete")).toEqual([])
          expect(yield* bucket.get(gcKey(1))).toEqual(original)
          expect(yield* bucket.head(pageKey(orphan))).toEqual(Option.none())
        }),
    )

    it.effect(
      "blocks takeover while a delete is in flight even past expiry (rejects concurrent collector deletes behind a stale lease check)",
      () =>
        Effect.gen(function* () {
          const bucket = yield* yield* backend.namespace
          const faults = Faults.plan()
          const a = yield* storeOf(bucket, { writer: "a", shards: 1, faults, retry: RETRY })
          const b = yield* storeOf(bucket, { writer: "b", retry: RETRY })
          yield* a.putPage(text("orphan"))
          yield* age(bucket, DAY + 1)
          const marking = yield* faults.inject(Fault.Hold(), {
            match: ({ kind, key }) => kind === "list" && key === PAGES_PREFIX,
          })
          const held = yield* faults.inject(Fault.Hold(), {
            match: ({ kind }) => kind === "delete",
          })
          const collecting = yield* Effect.forkChild(a.gc.collect({ references, entryReferences }))
          yield* marking.fired
          yield* TestClock.adjust("599 seconds")
          yield* marking.release
          yield* held.fired
          yield* TestClock.adjust("9 seconds")
          expect(yield* b.gc.collect({ references, entryReferences })).toMatchObject({
            outcome: "blocked",
            epoch: 2n,
          })
          expect(yield* bucket.list(PAGES_PREFIX)).toHaveLength(1)
          yield* held.release
          expect(yield* Fiber.join(collecting)).toMatchObject({
            outcome: "collected",
            deletedPages: 1,
          })
          expect(yield* b.gc.collect({ references, entryReferences })).toMatchObject({
            outcome: "collected",
            deletedPages: 0,
          })
          expect((yield* faults.operations).filter(({ kind }) => kind === "delete")).toHaveLength(1)
          expect((yield* faults.operations).filter(({ kind }) => kind === "lease.write")).toEqual(
            [],
          )
        }),
    )

    it.effect(
      "leaves an unknown delete outcome blocked and never retries it (rejects takeover or blind retries after a lost delete response)",
      () =>
        Effect.gen(function* () {
          const bucket = yield* yield* backend.namespace
          const faults = Faults.plan()
          const a = yield* storeOf(bucket, { writer: "a", shards: 1, faults, retry: RETRY })
          const b = yield* storeOf(bucket, { writer: "b", retry: RETRY })
          yield* a.putPage(text("orphan"))
          yield* age(bucket, DAY + 1)
          yield* faults.inject(Fault.LoseResponse(), { match: ({ kind }) => kind === "delete" })
          expect(yield* failed(a.gc.collect({ references, entryReferences }))).toBeInstanceOf(
            StorageUnavailable,
          )
          yield* TestClock.adjust("1 day")
          expect(yield* b.gc.collect({ references, entryReferences })).toMatchObject({
            outcome: "blocked",
            epoch: 2n,
          })
          expect(yield* bucket.list(PAGES_PREFIX)).toEqual([])
          expect((yield* faults.operations).filter(({ kind }) => kind === "delete")).toHaveLength(1)
        }),
    )

    it.effect(
      "recognizes an immutable epoch whose creation response was lost (rejects replacing the epoch or inventing a new owner on retry)",
      () =>
        Effect.gen(function* () {
          const bucket = yield* yield* backend.namespace
          const faults = Faults.plan()
          const store = yield* storeOf(bucket, { writer: "a", shards: 1, faults, retry: RETRY })
          yield* faults.inject(Fault.LoseResponse(), {
            match: ({ kind, key }) => kind === "create" && key === gcKey(1),
          })
          expect(yield* store.gc.collect({ references, entryReferences })).toMatchObject({
            outcome: "collected",
            epoch: 2n,
          })
          expect(
            (yield* faults.operations).filter(
              ({ kind, key }) => kind === "create" && key === gcKey(1),
            ),
          ).toHaveLength(2)
          expect(yield* bucket.list("gc/")).toEqual([gcKey(1), gcKey(2)])
        }),
    )

    it.effect(
      "serializes publication against HEAD/DELETE and marks a fork retained only in the log (rejects a dedup PUT racing an already selected delete)",
      () =>
        Effect.gen(function* () {
          const bucket = yield* yield* backend.namespace
          const faults = Faults.plan()
          const a = yield* storeOf(bucket, { writer: "a", shards: 1, faults, retry: RETRY })
          const b = yield* storeOf(bucket, { writer: "b", retry: RETRY })
          const hash = yield* a.putPage(text("leaf:forked"))
          const lease = yield* b.open(0)
          yield* age(bucket, DAY + 1)
          const held = yield* faults.inject(Fault.Hold(), {
            match: ({ kind }) => kind === "delete",
          })
          const collecting = yield* Effect.forkChild(a.gc.collect({ references, entryReferences }))
          yield* held.fired
          const publication = b.gc.protect(
            Effect.gen(function* () {
              expect(yield* b.putPage(text("leaf:forked"))).toBe(hash)
              yield* b.append(lease, [text(`forked:${hash}`)])
            }),
          )
          expect(yield* failed(publication)).toBeInstanceOf(PagePublicationBusy)
          yield* held.release
          expect(yield* Fiber.join(collecting)).toMatchObject({ deletedPages: 1 })
          yield* publication
          yield* age(bucket, DAY + 1)
          expect(yield* a.gc.collect({ references, entryReferences })).toMatchObject({
            marked: 1,
            deletedPages: 0,
          })
          expect(yield* b.getPage(hash)).toEqual(text("leaf:forked"))
        }),
    )

    it.effect(
      "blocks collection during publication and after an unknown publication failure (rejects marking through an unfinished checkpoint)",
      () =>
        Effect.gen(function* () {
          const bucket = yield* yield* backend.namespace
          const faults = Faults.plan()
          const a = yield* storeOf(bucket, { writer: "a", shards: 1, faults, retry: RETRY })
          const b = yield* storeOf(bucket, { writer: "b", retry: RETRY })
          const held = yield* faults.inject(Fault.Hold(), { match: ({ kind }) => kind === "put" })
          const publishing = yield* Effect.forkChild(
            a.gc.protect(a.putPage(text("leaf:publishing"))),
          )
          yield* held.fired
          expect(yield* b.gc.collect({ references, entryReferences })).toMatchObject({
            outcome: "blocked",
          })
          yield* held.release
          yield* Fiber.join(publishing)
          const error = StorageUnavailable.make({
            operation: "create",
            key: "checkpoint",
            reason: "unknown outcome",
          })
          expect(yield* failed(a.gc.protect(Effect.fail(error)))).toBe(error)
          yield* TestClock.adjust("1 day")
          expect(yield* b.gc.collect({ references, entryReferences })).toMatchObject({
            outcome: "blocked",
          })
        }),
    )

    it.effect(
      "releases publication exclusion after a confirmed owner fence (rejects stranding GC after an ordinary shard move)",
      () =>
        Effect.gen(function* () {
          const bucket = yield* yield* backend.namespace
          const a = yield* storeOf(bucket, { writer: "a", shards: 1, retry: RETRY })
          const b = yield* storeOf(bucket, { writer: "b", retry: RETRY })
          const old = yield* a.open(0)
          yield* b.open(0)
          yield* TestClock.adjust("11 seconds")
          const result = yield* failed(
            a.gc.protect(
              Effect.gen(function* () {
                const hash = yield* a.putPage(text("leaf:discarded-checkpoint"))
                yield* a.checkpoint(old, { offset: old.head, statePages: [hash], indexPages: [] })
              }),
            ),
          )
          expect(result).toBeInstanceOf(StaleEpoch)
          expect(yield* b.gc.collect({ references, entryReferences })).toMatchObject({
            outcome: "collected",
          })
          expect(yield* b.history.checkpoints(0)).toEqual([])
        }),
    )
  })

describe("GC timestamp and validity boundaries", () => {
  it.effect(
    "bounds a delete request and leaves its timed-out epoch blocked (rejects freeing an exclusion while the provider outcome is unknown)",
    () =>
      Effect.gen(function* () {
        const bucket = memoryBucket()
        const faults = Faults.plan()
        const store = yield* storeOf(bucket, { writer: "a", shards: 1, faults, retry: RETRY })
        yield* store.putPage(text("orphan"))
        yield* TestClock.adjust("25 hours")
        const held = yield* faults.inject(Fault.Hold(), { match: ({ kind }) => kind === "delete" })
        const collecting = yield* Effect.forkChild(
          store.gc.collect({ references, entryReferences }),
        )
        yield* held.fired
        yield* TestClock.adjust("10 seconds")
        expect(
          Option.getOrUndefined(Exit.findErrorOption(yield* Fiber.await(collecting))),
        ).toBeInstanceOf(StorageUnavailable)
        yield* held.release
        expect(yield* store.gc.collect({ references, entryReferences })).toMatchObject({
          outcome: "blocked",
          epoch: 2n,
        })
        expect(yield* bucket.list(PAGES_PREFIX)).toHaveLength(1)
      }),
  )

  it.effect(
    "retains a page exactly at grace and a refreshed page before a fork checkpoint (rejects inclusive expiry or a timestamp captured before the delete claim)",
    () =>
      Effect.gen(function* () {
        const bucket = memoryBucket()
        const faults = Faults.plan()
        const store = yield* storeOf(bucket, { writer: "a", shards: 1, faults, retry: RETRY })
        const hash = yield* store.putPage(text("leaf:reused"))
        yield* TestClock.adjust("24 hours")
        expect(yield* store.gc.collect({ references, entryReferences })).toMatchObject({
          deletedPages: 0,
        })
        yield* TestClock.adjust(1)
        const held = yield* faults.inject(Fault.Hold(), {
          match: ({ kind, key }) => kind === "create" && key === gcKey(4),
        })
        const collecting = yield* Effect.forkChild(
          store.gc.collect({ references, entryReferences }),
        )
        yield* held.fired
        expect(yield* store.putPage(text("leaf:reused"))).toBe(hash)
        const lease = yield* store.open(0)
        yield* store.checkpoint(lease, { offset: lease.head, statePages: [hash], indexPages: [] })
        yield* held.release
        expect(yield* Fiber.join(collecting)).toMatchObject({
          outcome: "collected",
          deletedPages: 0,
        })
        expect(yield* bucket.modified(pageKey(hash))).toEqual(Option.some(DAY + 1))
        expect(yield* store.getPage(hash)).toEqual(text("leaf:reused"))
        yield* TestClock.adjust("25 hours")
        expect(yield* store.gc.collect({ references, entryReferences })).toMatchObject({
          marked: 1,
          deletedPages: 0,
        })
      }),
  )

  it.effect(
    "rejects a verification response older than validFor (rejects starting deletion on a delayed list response)",
    () =>
      Effect.gen(function* () {
        const bucket = memoryBucket()
        const faults = Faults.plan()
        const store = yield* storeOf(bucket, { writer: "a", shards: 1, faults, retry: RETRY })
        yield* store.putPage(text("orphan"))
        yield* TestClock.adjust("25 hours")
        const marking = yield* faults.inject(Fault.Hold(), {
          match: ({ kind, key }) => kind === "list" && key === PAGES_PREFIX,
        })
        const collecting = yield* Effect.forkChild(
          store.gc.collect({ references, entryReferences }),
        )
        yield* marking.fired
        const verifying = yield* faults.inject(Fault.Hold(), {
          match: ({ kind, key }) => kind === "list" && key === "gc/",
        })
        yield* marking.release
        yield* verifying.fired
        yield* TestClock.adjust("11 seconds")
        yield* verifying.release
        expect(
          Option.getOrUndefined(Exit.findErrorOption(yield* Fiber.await(collecting))),
        ).toBeInstanceOf(GcStaleEpoch)
        expect(yield* bucket.list(PAGES_PREFIX)).toHaveLength(1)
        expect(yield* bucket.list("gc/")).toEqual([gcKey(1)])
      }),
  )

  it.effect(
    "refreshes marks but reuses page listings on its slow cadence (rejects cached reachability or listing on every collection)",
    () =>
      Effect.gen(function* () {
        const bucket = memoryBucket()
        const faults = Faults.plan()
        const store = yield* storeOf(bucket, { writer: "a", shards: 1, faults, retry: RETRY })
        const hash = yield* store.putPage(text("leaf:live"))
        expect(yield* store.gc.collect({ references, entryReferences })).toMatchObject({
          marked: 0,
        })
        const lease = yield* store.open(0)
        yield* store.checkpoint(lease, { offset: lease.head, statePages: [hash], indexPages: [] })
        expect(yield* store.gc.collect({ references, entryReferences })).toMatchObject({
          marked: 1,
        })
        expect(
          (yield* faults.operations).filter(
            ({ kind, key }) => kind === "list" && key === PAGES_PREFIX,
          ),
        ).toHaveLength(1)
        yield* TestClock.adjust("1 hour")
        expect(yield* store.gc.collect({ references, entryReferences })).toMatchObject({
          marked: 1,
        })
        expect(
          (yield* faults.operations).filter(
            ({ kind, key }) => kind === "list" && key === PAGES_PREFIX,
          ),
        ).toHaveLength(2)
      }),
  )
})

describe("GC over the seeded bucket", () => {
  for (const seed of [0x6c01, 0x6c02, 0x6c03, 0x6c04])
    it(`keeps reachable pages under raced collectors and seeded delays, seed ${seed} (rejects trusting a process-local lock)`, async () => {
      let state = seed
      const random = () => {
        state ^= state << 13
        state ^= state >>> 17
        state ^= state << 5
        return (state >>> 0) / 4294967296
      }
      const scheduler = new SeededScheduler(seed)
      const program = Effect.gen(function* () {
        const simulated = SimulatedBucket.make(random, ["slowLog", "lostResponse"])
        const a = yield* storeOf(simulated.view(0), { writer: "a", shards: 1, retry: RETRY })
        const b = yield* storeOf(simulated.view(1), { writer: "b", retry: RETRY })
        const live = yield* a.putPage(text("leaf:live"))
        const root = yield* a.putPage(text(`branch:root:${live}`))
        yield* a.putPage(text("orphan"))
        const lease = yield* a.open(0)
        yield* a.checkpoint(lease, { offset: lease.head, statePages: [root], indexPages: [] })
        yield* TestClock.adjust("25 hours")
        simulated.arm(() => Effect.void)
        const results = yield* Effect.all(
          [
            Effect.result(a.gc.collect({ references, entryReferences })),
            Effect.result(b.gc.collect({ references, entryReferences })),
          ],
          { concurrency: 2 },
        )
        for (const result of results)
          if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(GcStaleEpoch)
        expect(yield* simulated.inspect.list(PAGES_PREFIX)).toEqual(
          [live, root].map(pageKey).sort(),
        )
        expect(Option.isSome(yield* simulated.inspect.get(checkpointKey(0, 1n)))).toBe(true)
        expect(scheduler.picks).toBeGreaterThan(0)
      }).pipe(Random.withSeed(seed), Effect.provide(TestClock.layer()))
      await Effect.runPromise(program, { scheduler })
    })
})
