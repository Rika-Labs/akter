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
import { encodePage, sha256 } from "./codec.ts"
import { checkpointKey, pageKey, PAGES_PREFIX } from "./keys.ts"
import { memoryBucket } from "./memory.ts"
import { storeOf } from "./service.ts"

const platform =
  globalThis.Bun === undefined
    ? (await import("@effect/platform-node")).NodeServices.layer
    : (await import("@effect/platform-bun")).BunServices.layer

const text = (value: string) => new TextEncoder().encode(value)

const sha256Of = (value: string) => sha256(encodePage(text(value)))

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

const PUBLICATION_EXPIRY = 60_000

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
          const publication = b.gc.protect(b.putPage(text("leaf:forked")), (page) =>
            Effect.gen(function* () {
              expect(page).toBe(hash)
              yield* b.append(lease, [text(`forked:${page}`)])
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
      "blocks collection during publication and until expiry after a reference with an unknown outcome, but not after a failed upload (rejects marking through an unfinished checkpoint, or stranding the store when nothing was referenced)",
      () =>
        Effect.gen(function* () {
          const bucket = yield* yield* backend.namespace
          const faults = Faults.plan()
          const a = yield* storeOf(bucket, { writer: "a", shards: 1, faults, retry: RETRY })
          const b = yield* storeOf(bucket, { writer: "b", retry: RETRY })
          const held = yield* faults.inject(Fault.Hold(), { match: ({ kind }) => kind === "put" })
          const publishing = yield* Effect.forkChild(
            a.gc.protect(a.putPage(text("leaf:publishing")), () => Effect.void),
          )
          yield* held.fired
          expect(yield* b.gc.collect({ references, entryReferences })).toMatchObject({
            outcome: "blocked",
          })
          yield* held.release
          yield* Fiber.join(publishing)
          const uploadError = StorageUnavailable.make({
            operation: "put",
            key: "page",
            reason: "upload failed",
          })
          expect(yield* failed(a.gc.protect(Effect.fail(uploadError), () => Effect.void))).toBe(
            uploadError,
          )
          expect(yield* b.gc.collect({ references, entryReferences })).toMatchObject({
            outcome: "collected",
          })
          const error = StorageUnavailable.make({
            operation: "create",
            key: "checkpoint",
            reason: "unknown outcome",
          })
          expect(yield* failed(a.gc.protect(Effect.void, () => Effect.fail(error)))).toBe(error)
          yield* TestClock.adjust(PUBLICATION_EXPIRY - 1)
          expect(yield* b.gc.collect({ references, entryReferences })).toMatchObject({
            outcome: "blocked",
          })
          yield* TestClock.adjust(1)
          expect(yield* b.gc.collect({ references, entryReferences })).toMatchObject({
            outcome: "collected",
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
            a.gc.protect(a.putPage(text("leaf:discarded-checkpoint")), (hash) =>
              a.checkpoint(old, { offset: old.head, statePages: [hash], indexPages: [] }),
            ),
          )
          expect(result).toBeInstanceOf(StaleEpoch)
          expect(yield* b.gc.collect({ references, entryReferences })).toMatchObject({
            outcome: "collected",
          })
          expect(yield* b.history.checkpoints(0)).toEqual([])
        }),
    )

    it.effect(
      "expires a publishing epoch whose holder stopped without an outcome, then publication and collection resume (rejects an epoch stranded forever by an interrupted or killed publisher)",
      () =>
        Effect.gen(function* () {
          const bucket = yield* yield* backend.namespace
          const faults = Faults.plan()
          const a = yield* storeOf(bucket, { writer: "a", shards: 1, faults, retry: RETRY })
          const b = yield* storeOf(bucket, { writer: "b", retry: RETRY })
          const held = yield* faults.inject(Fault.Hold(), { match: ({ kind }) => kind === "put" })
          const publishing = yield* Effect.forkChild(
            a.gc.protect(a.putPage(text("leaf:interrupted")), () => Effect.void),
          )
          yield* held.fired
          yield* Fiber.interrupt(publishing)
          expect(
            yield* failed(b.gc.protect(b.putPage(text("leaf:next")), () => Effect.void)),
          ).toBeInstanceOf(PagePublicationBusy)
          expect(yield* b.gc.collect({ references, entryReferences })).toMatchObject({
            outcome: "blocked",
          })
          yield* TestClock.adjust(PUBLICATION_EXPIRY - 1)
          expect(yield* b.gc.collect({ references, entryReferences })).toMatchObject({
            outcome: "blocked",
          })
          expect(
            yield* failed(b.gc.protect(b.putPage(text("leaf:next")), () => Effect.void)),
          ).toBeInstanceOf(PagePublicationBusy)
          yield* TestClock.adjust(1)
          yield* b.gc.protect(b.putPage(text("leaf:next")), () => Effect.void)
          expect(yield* b.gc.collect({ references, entryReferences })).toMatchObject({
            outcome: "collected",
          })
          yield* held.release
        }),
    )

    it.effect(
      "lets concurrent publications of one process share a single publishing epoch (rejects serializing every checkpoint of a drain behind its own epoch)",
      () =>
        Effect.gen(function* () {
          const bucket = yield* yield* backend.namespace
          const faults = Faults.plan()
          const store = yield* storeOf(bucket, { writer: "a", shards: 16, faults, retry: RETRY })
          const leases = yield* Effect.forEach(
            Array.from({ length: 16 }, (_, shard) => shard),
            (shard) => store.open(shard),
          )
          const uploads = yield* faults.inject(Fault.Hold(), {
            match: ({ kind }) => kind === "put",
            times: Number.POSITIVE_INFINITY,
          })
          const publishing = yield* Effect.forkChild(
            Effect.forEach(
              leases,
              (lease) =>
                store.gc.protect(store.putPage(text(`leaf:shard-${lease.shard}`)), (hash) =>
                  store.checkpoint(lease, {
                    offset: lease.head,
                    statePages: [hash],
                    indexPages: [],
                  }),
                ),
              { concurrency: "unbounded", discard: true },
            ),
          )
          const held = Effect.map(
            faults.operations,
            (operations) => operations.filter(({ kind }) => kind === "put").length,
          )
          for (let turn = 0; turn < 10_000 && (yield* held) < 16; turn++) yield* Effect.yieldNow
          expect(yield* held).toBe(16)
          yield* uploads.release
          yield* Fiber.join(publishing)
          expect(yield* bucket.list("gc/")).toEqual([gcKey(1), gcKey(2)])
          for (const lease of leases)
            expect(yield* store.history.checkpoints(lease.shard)).toHaveLength(1)
        }),
    )

    it.effect(
      "keeps a shared epoch publishing when one member's reference has an unknown outcome and another member leaves last (rejects letting the last member's success decide the epoch)",
      () =>
        Effect.gen(function* () {
          const bucket = yield* yield* backend.namespace
          const faults = Faults.plan()
          const store = yield* storeOf(bucket, { writer: "a", shards: 2, faults, retry: RETRY })
          const collector = yield* storeOf(bucket, { writer: "b", retry: RETRY })
          const lease = yield* store.open(1)
          const unknownUpload = yield* faults.inject(Fault.Hold(), {
            match: ({ kind, key }) => kind === "put" && key.endsWith(sha256Of("leaf:unknown")),
          })
          const knownUpload = yield* faults.inject(Fault.Hold(), {
            match: ({ kind, key }) => kind === "put" && key.endsWith(sha256Of("leaf:known")),
          })
          const held = yield* faults.inject(Fault.Hold(), {
            match: ({ kind, key }) => kind === "create" && key === checkpointKey(1, lease.head),
          })
          const unknown = StorageUnavailable.make({
            operation: "create",
            key: checkpointKey(0, 0n),
            reason: "unknown outcome",
          })
          const unknownMember = yield* Effect.forkChild(
            store.gc.protect(store.putPage(text("leaf:unknown")), () => Effect.fail(unknown)),
          )
          const knownMember = yield* Effect.forkChild(
            store.gc.protect(store.putPage(text("leaf:known")), (hash) =>
              store.checkpoint(lease, { offset: lease.head, statePages: [hash], indexPages: [] }),
            ),
          )
          yield* unknownUpload.fired
          yield* knownUpload.fired
          yield* unknownUpload.release
          yield* knownUpload.release
          yield* held.fired
          expect(
            Option.getOrUndefined(Exit.findErrorOption(yield* Fiber.await(unknownMember))),
          ).toBe(unknown)
          yield* held.release
          yield* Fiber.join(knownMember)
          expect(yield* bucket.list("gc/")).toEqual([gcKey(1)])
          expect(yield* collector.gc.collect({ references, entryReferences })).toMatchObject({
            outcome: "blocked",
          })
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
    "refuses the durable reference of a publisher whose expired epoch was taken over while its page refresh was in flight (rejects expiry without a fence between uploads and the reference)",
    () =>
      Effect.gen(function* () {
        const bucket = memoryBucket()
        const publisherFaults = Faults.plan()
        const collectorFaults = Faults.plan()
        const a = yield* storeOf(bucket, {
          writer: "a",
          shards: 1,
          faults: publisherFaults,
          retry: RETRY,
        })
        const b = yield* storeOf(bucket, { writer: "b", faults: collectorFaults, retry: RETRY })
        const hash = yield* a.putPage(text("leaf:reused"))
        const lease = yield* a.open(0)
        yield* TestClock.adjust("25 hours")
        const upload = yield* publisherFaults.inject(Fault.Hold(), {
          match: ({ kind }) => kind === "put",
        })
        const publishing = yield* Effect.forkChild(
          a.gc.protect(a.putPage(text("leaf:reused")), (page) =>
            a.checkpoint(lease, { offset: lease.head, statePages: [page], indexPages: [] }),
          ),
        )
        yield* upload.fired
        yield* TestClock.adjust(PUBLICATION_EXPIRY + 1000)
        const deleting = yield* collectorFaults.inject(Fault.Hold(), {
          match: ({ kind }) => kind === "delete",
        })
        const collecting = yield* Effect.forkChild(b.gc.collect({ references, entryReferences }))
        expect(
          yield* Effect.raceFirst(
            Effect.as(deleting.fired, "deleting"),
            Effect.as(Fiber.await(collecting), "returned"),
          ),
        ).toBe("deleting")
        yield* upload.release
        expect(
          Option.getOrUndefined(Exit.findErrorOption(yield* Fiber.await(publishing))),
        ).toBeInstanceOf(PagePublicationBusy)
        yield* deleting.release
        expect(yield* Fiber.join(collecting)).toMatchObject({
          outcome: "collected",
          deletedPages: 1,
        })
        expect(yield* bucket.list("s/00/cp/")).toEqual([])
        expect(yield* bucket.head(pageKey(hash))).toEqual(Option.none())
      }),
  )

  it.effect(
    "keeps a reused page whose refresh was throttled when a collector takes over the expired epoch after the publisher's confirmation (rejects counting a throttled PUT of an old object as a refresh)",
    () =>
      Effect.gen(function* () {
        const bucket = memoryBucket()
        const publisherFaults = Faults.plan()
        const a = yield* storeOf(bucket, {
          writer: "a",
          shards: 1,
          faults: publisherFaults,
          retry: RETRY,
        })
        const b = yield* storeOf(bucket, { writer: "b", retry: RETRY })
        const hash = yield* a.putPage(text("leaf:reused"))
        const lease = yield* a.open(0)
        yield* TestClock.adjust("25 hours")
        yield* publisherFaults.inject(Fault.Unavailable({ status: 429 }), {
          match: ({ kind, key }) => kind === "put" && key === pageKey(hash),
        })
        const referencing = yield* publisherFaults.inject(Fault.Hold(), {
          match: ({ kind, key }) => kind === "create" && key === checkpointKey(0, lease.head),
        })
        const publishing = yield* Effect.forkChild(
          a.gc.protect(a.putPage(text("leaf:reused")), (page) =>
            a.checkpoint(lease, { offset: lease.head, statePages: [page], indexPages: [] }),
          ),
        )
        yield* referencing.fired
        yield* TestClock.adjust(PUBLICATION_EXPIRY + 1000)
        expect(yield* b.gc.collect({ references, entryReferences })).toMatchObject({
          outcome: "collected",
          deletedPages: 0,
        })
        yield* referencing.release
        yield* Fiber.join(publishing)
        expect(yield* a.getPage(hash)).toEqual(text("leaf:reused"))
        expect(yield* bucket.modified(pageKey(hash))).toEqual(Option.some(25 * 60 * 60 * 1000))
      }),
  )

  it.effect(
    "answers a publisher that lost the race to take over an expired epoch as busy (rejects failing a checkpoint with a collector error a caller does not retry)",
    () =>
      Effect.gen(function* () {
        const bucket = memoryBucket()
        const strandedFaults = Faults.plan()
        const losingFaults = Faults.plan()
        const stranded = yield* storeOf(bucket, {
          writer: "a",
          shards: 1,
          faults: strandedFaults,
          retry: RETRY,
        })
        const losing = yield* storeOf(bucket, { writer: "b", faults: losingFaults, retry: RETRY })
        const winning = yield* storeOf(bucket, { writer: "c", retry: RETRY })
        const upload = yield* strandedFaults.inject(Fault.Hold(), {
          match: ({ kind }) => kind === "put",
        })
        const publishing = yield* Effect.forkChild(
          stranded.gc.protect(stranded.putPage(text("leaf:stranded")), () => Effect.void),
        )
        yield* upload.fired
        yield* Fiber.interrupt(publishing)
        yield* TestClock.adjust(PUBLICATION_EXPIRY)
        const claiming = yield* losingFaults.inject(Fault.Hold(), {
          match: ({ kind, key }) => kind === "create" && key === gcKey(2),
        })
        const losingPublication = yield* Effect.forkChild(
          losing.gc.protect(losing.putPage(text("leaf:losing")), () => Effect.void),
        )
        yield* claiming.fired
        yield* winning.gc.protect(winning.putPage(text("leaf:winning")), () => Effect.void)
        yield* claiming.release
        expect(
          Option.getOrUndefined(Exit.findErrorOption(yield* Fiber.await(losingPublication))),
        ).toBeInstanceOf(PagePublicationBusy)
        expect(yield* bucket.list("gc/")).toEqual([gcKey(1), gcKey(2), gcKey(3)])
        yield* upload.release
      }),
  )

  it.effect(
    "answers members waiting on a claim whose publisher was interrupted as busy and frees the process's publication (rejects a joiner hanging or a membership leaked by an interrupted claim)",
    () =>
      Effect.gen(function* () {
        const bucket = memoryBucket()
        const faults = Faults.plan()
        const store = yield* storeOf(bucket, { writer: "a", shards: 1, faults, retry: RETRY })
        const claiming = yield* faults.inject(Fault.Hold(), {
          match: ({ kind, key }) => kind === "create" && key === gcKey(1),
        })
        const first = yield* Effect.forkChild(
          store.gc.protect(store.putPage(text("leaf:first")), () => Effect.void),
        )
        yield* claiming.fired
        const joined = yield* Effect.forkChild(
          store.gc.protect(store.putPage(text("leaf:joined")), () => Effect.void),
        )
        yield* Effect.yieldNow
        yield* Fiber.interrupt(first)
        expect(
          Option.getOrUndefined(Exit.findErrorOption(yield* Fiber.await(joined))),
        ).toBeInstanceOf(PagePublicationBusy)
        yield* claiming.release
        yield* store.gc.protect(store.putPage(text("leaf:after")), () => Effect.void)
        expect(yield* bucket.list("gc/")).toEqual([gcKey(1), gcKey(2)])
        expect(yield* store.gc.collect({ references, entryReferences })).toMatchObject({
          outcome: "collected",
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
