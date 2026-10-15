import { describe, expect, it } from "@effect/vitest"
import {
  Cause,
  Clock,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { Durable } from "../../../../packages/akter/src/execution/durable.ts"
import { PageDocuments } from "../../../../packages/akter/src/handlers/page-tree.ts"
import { Forks } from "../../../../packages/akter/src/snapshots/forks.ts"
import { decodeManifest } from "../../../../packages/akter/src/store/codec.ts"
import { checkpointPrefix, pageKey } from "../../../../packages/akter/src/store/keys.ts"
import { storeOf } from "../../../../packages/akter/src/store/service.ts"
import { Fault, Faults } from "../../../../packages/akter/src/store/faults.ts"
import { ForkRefused } from "../../../../packages/akter/src/snapshots/forks.ts"
import { PagePublicationBusy } from "../../../../packages/akter/src/store/gc.ts"
import { PageCorrupt } from "../../../../packages/akter/src/store/errors.ts"
import type { Bucket } from "../../../../packages/akter/src/store/bucket.ts"
import type { EngineBackend } from "./engine.ts"
import { Entry, EntryCodec } from "../../../../packages/akter/src/execution/entries.ts"
import { jobIO, jobRunner, jobState, jobUntil, submit, Worker } from "./job-runner.ts"
import { collect } from "../../../../packages/akter/src/store/layer.ts"
import { Store } from "../../../../packages/akter/src/store/service.ts"
import { checkpointKey } from "../../../../packages/akter/src/store/keys.ts"
import { Operators } from "../../../../packages/akter/src/runtime/operators/service.ts"

export { Library, LibraryLive, pageRunner } from "./page-runner.ts"
import { Library, pageRunner } from "./page-runner.ts"
/**
 * Bucket requests the seed 900 scenario issues one after another between admitting a version and
 * forking it (about 110 measured, with margin). Its retention must outlast them at the bucket's
 * latency, or the version it forks as recent has really left retention by the time it is forked.
 */
const SCENARIO_REQUESTS = 150

/** The median round trip of a listing on `bucket`, in milliseconds. */
const listingLatency = (bucket: Bucket) =>
  Effect.gen(function* () {
    const samples: Array<number> = []
    for (let sample = 0; sample < 5; sample++) {
      const start = yield* Clock.currentTimeMillis
      yield* bucket.list("latency-probe/")
      samples.push((yield* Clock.currentTimeMillis) - start)
    }
    return samples.sort((a, b) => a - b)[2]!
  })

/** The same page-miss, fork and corruption scenarios run on filesystem and a real S3 bucket. */
export const pageConformance = <E, E2>(backend: EngineBackend<E, E2>) => {
  describe(`Pages, history and forks on ${backend.name}`, () => {
    it.live(
      "seed 900 history pattern: a recent version survives expired baseline trim and GC, while an older position is refused and its old anchor later expires",
      () =>
        Effect.gen(function* () {
          const bucket = yield* (yield* backend.location).bucket
          const retention = 3_000 + SCENARIO_REQUESTS * (yield* listingLatency(bucket))
          const expiry = Duration.millis(retention + 1_000)
          const options = {
            retention: Duration.millis(retention),
            validFor: "100 millis",
            trimAfter: "300 millis",
            checkpointEvery: 0,
          } as const
          const first = yield* pageRunner(bucket, { ...options, writer: "retention-first" })
          yield* first.call("source", "fill", 90)
          expect((yield* first.engine.drain("10 seconds")).outcome).toBe("clean")
          const old = (yield* first.store.history.checkpoints(0)).at(-1)!
          const scope = yield* Scope.make()
          const boundary = yield* Scope.provide(scope)(
            pageRunner(bucket, { ...options, writer: "retention-boundary" }),
          )
          yield* boundary.call("other", "fill", 7)
          yield* Scope.close(scope, Exit.void)
          yield* Effect.sleep(expiry)
          const recent = yield* pageRunner(bucket, { ...options, writer: "retention-recent" })
          yield* recent.call("source", "change", 17)
          yield* recent.call("source", "change", 29)
          expect((yield* recent.engine.drain("10 seconds")).outcome).toBe("clean")
          const lease = yield* recent.store.open(0)
          yield* Effect.sleep("400 millis")
          expect(yield* recent.store.trim(lease, lease.head)).toBe(old.offset)
          const gc = { checkpointInterval: "10 millis", gracePeriod: "1 second" } as const
          expect(
            (yield* collect(gc).pipe(Effect.provideService(Store, recent.store))).outcome,
          ).toBe("collected")
          expect(Option.isSome(yield* bucket.get(checkpointKey(0, old.offset)))).toBe(true)
          const target = yield* pageRunner(bucket, { ...options, writer: "retention-fork" })
          const grant = {
            operator: "operator:retention",
            capabilities: [{ action: "fork" as const, tenant: "default" }],
          }
          yield* Forks.fork(target.engine, {
            actor: Library,
            from: "source",
            to: "recent",
            at: { version: 2 },
            grant,
          })
          expect((yield* target.engine.durableRecord(Library, "recent")).image.state.count).toBe(91)
          const items = yield* target.range("recent")
          expect(
            items
              .map(
                (item) =>
                  Result.getOrThrow(
                    Schema.decodeUnknownResult(Schema.Struct({ id: Schema.Int }))(item),
                  ).id,
              )
              .sort((a, b) => a - b),
          ).toEqual(Array.from({ length: 90 }, (_, id) => id))
          expect(items.find(Schema.is(Schema.Struct({ id: Schema.Literal(17) })))).toEqual({
            id: 17,
            at: -7,
            text: "changed",
          })
          expect(items.find(Schema.is(Schema.Struct({ id: Schema.Literal(29) })))).toEqual({
            id: 29,
            at: 61,
            text: "29:" + "x".repeat(1100),
          })
          expect((yield* target.engine.durableRecord(Library, "other")).image.state.count).toBe(7)
          const expired = yield* Forks.fork(target.engine, {
            actor: Library,
            from: "source",
            to: "expired",
            at: { version: 1 },
            grant,
          }).pipe(Effect.result)
          expect(
            Result.isFailure(expired) &&
              Schema.is(ForkRefused)(expired.failure) &&
              expired.failure.reason,
          ).toBe("retention")
          expect((yield* target.engine.drain("10 seconds")).outcome).toBe("clean")
          yield* Effect.sleep(expiry)
          expect(
            (yield* collect(gc).pipe(Effect.provideService(Store, target.store))).outcome,
          ).toBe("collected")
          expect(Option.isNone(yield* bucket.get(checkpointKey(0, old.offset)))).toBe(true)
          expect(Option.isNone(yield* bucket.get(pageKey(old.statePages[0]!)))).toBe(true)
          const reopened = yield* pageRunner(bucket, { ...options, writer: "retention-restored" })
          expect(yield* reopened.range("recent")).toEqual(items)
        }).pipe(Effect.scoped),
      30_000,
    )

    it.live(
      "page-backed replay: the rebuilt state/index image and audit share one segment, and its page graph survives GC without a checkpoint",
      () =>
        Effect.gen(function* () {
          const bucket = yield* (yield* backend.location).bucket
          const options = {
            validFor: "100 millis",
            trimAfter: "300 millis",
            checkpointEvery: 0,
          } as const
          const scope = yield* Scope.make()
          const old = yield* Scope.provide(scope)(
            pageRunner(bucket, {
              ...options,
              writer: "replay-old",
              build: { bundle: "old-pages", framework: "0.2-pages" },
            }),
          )
          yield* old.call("source", "fill", 90)
          yield* Scope.close(scope, Exit.void)
          const current = yield* pageRunner(bucket, {
            ...options,
            writer: "replay-current",
            build: { bundle: "current-pages", framework: "0.2-pages" },
          })
          yield* jobUntil(
            "new build refused the old page tail",
            () => current.engine.status(0).status === "refused",
          )
          expect(current.engine.status(0).status).toBe("refused")
          yield* Operators.make(current.engine).run(
            {
              operator: "operator:replay",
              capabilities: [{ action: "replay", tenant: "default" }],
            },
            {
              operation: "replay",
              target: { shard: 0 },
              tenant: "default",
              reason: "verified list replay",
              replay: "current",
            },
          )
          const entries = (yield* Stream.runCollect(current.store.read(0, 0n))).flatMap((segment) =>
            segment.entries.map((bytes) => Result.getOrThrow(EntryCodec.decode(bytes))),
          )
          const replayed = entries.find(Entry.guards.Replayed)!
          expect(replayed.page).toBeDefined()
          const segments = yield* Stream.runCollect(current.store.read(0, 0n))
          expect(
            segments
              .find((segment) =>
                segment.entries.some((bytes) =>
                  Entry.guards.Replayed(Result.getOrThrow(EntryCodec.decode(bytes))),
                ),
              )!
              .entries.map((bytes) => Result.getOrThrow(EntryCodec.decode(bytes))._tag),
          ).toEqual(["Replayed", "Audit"])
          const checkpoint = (yield* current.store.history.checkpoints(0)).at(-1)!
          expect(checkpoint.statePages).toEqual(checkpoint.indexPages)
          yield* bucket.delete(yield* bucket.list(checkpointPrefix(0)))
          yield* Effect.sleep("1100 millis")
          expect(
            (yield* collect({ checkpointInterval: "10 millis", gracePeriod: "1 second" }).pipe(
              Effect.provideService(Store, current.store),
            )).outcome,
          ).toBe("collected")
          expect(Option.isSome(yield* bucket.get(pageKey(replayed.page!)))).toBe(true)
          const restored = yield* pageRunner(bucket, {
            ...options,
            writer: "replay-restored",
            build: { bundle: "current-pages", framework: "0.2-pages" },
          })
          expect((yield* restored.engine.durableRecord(Library, "source")).image.state.count).toBe(
            90,
          )
          expect(yield* restored.range("source", 61, 62, 1)).toEqual([
            { id: 29, at: 61, text: "29:" + "x".repeat(1100) },
          ])
        }).pipe(Effect.scoped),
      30_000,
    )

    it.effect(
      "F20: rejects current-state forks, copied work by default, repeated PageMiss staging and a fork-of-fork lineage error",
      () =>
        Effect.gen(function* () {
          const bucket = yield* (yield* backend.location).bucket
          const runner = yield* pageRunner(bucket)
          yield* runner.call("source", "fill", 270)
          yield* runner.call("source", "remember", 41)
          yield* runner.engine.drain("10 seconds")
          const reopened = yield* pageRunner(bucket, { writer: "reopened" })
          const grant = {
            operator: "operator:test",
            capabilities: [{ action: "fork" as const, tenant: "default" }],
          }
          const [fork] = yield* Effect.all(
            [
              Forks.fork(reopened.engine, {
                actor: Library,
                from: "source",
                to: "branch",
                at: { version: 1 },
                grant,
              }),
              reopened.call("source", "change", 173),
            ],
            { concurrency: 2 },
          )
          expect(fork.position.version).toBe(1)
          expect(yield* reopened.range("branch", 95, 101, 3)).toEqual([
            { id: 175, at: 95, text: "175:" + "x".repeat(1100) },
            { id: 174, at: 96, text: "174:" + "x".repeat(1100) },
            { id: 173, at: 97, text: "173:" + "x".repeat(1100) },
          ])
          expect((yield* reopened.engine.durableRecord(Library, "branch")).image.state.count).toBe(
            270,
          )
          const before = reopened.engine.durableImage(0)!
          expect(
            Array.from(before.timers.values()).filter(
              (timer) => timer.address === Durable.addressOf(Library.name, "branch"),
            ),
          ).toHaveLength(0)
          yield* Forks.fork(reopened.engine, {
            actor: Library,
            from: "source",
            to: "work",
            at: { version: 2 },
            grant,
            withWork: true,
          })
          expect(
            Array.from(before.timers.values())
              .filter((timer) => timer.address === Durable.addressOf(Library.name, "work"))
              .map(({ timer }) => timer.payload),
          ).toEqual([41])
          yield* Forks.fork(reopened.engine, {
            actor: Library,
            from: "branch",
            to: "again",
            at: { version: 0 },
            grant,
          })
          expect(yield* reopened.range("again", 95, 101, 3)).toEqual(
            yield* reopened.range("branch", 95, 101, 3),
          )
          const denied = yield* Forks.fork(reopened.engine, {
            actor: Library,
            from: "source",
            to: "denied",
            at: { version: 1 },
            grant,
            tenant: "other",
          }).pipe(Effect.result)
          expect(
            Result.isFailure(denied) &&
              Schema.is(ForkRefused)(denied.failure) &&
              denied.failure.reason,
          ).toBe("scope")
          const record = yield* reopened.engine.durableRecord(Library, "source")
          const count = record.image.state.count
          const oversized = yield* reopened.call("source", "grow", 262_144).pipe(Effect.exit)
          expect(Exit.isFailure(oversized) && Cause.squash(oversized.cause)).toMatchObject({
            kind: "StateTooLarge",
          })
          expect(record.image.state.count).toBe(count)
          expect(record.image.state.text).toBe("")
          expect(
            Array.from(before.timers.values()).filter((timer) => timer.address === record.address),
          ).toHaveLength(1)
          expect(reopened.engine.pages.size).toBeLessThanOrEqual(72_000)
          yield* reopened.engine.drain("10 seconds")
          const restored = yield* pageRunner(bucket, { writer: "restored" })
          expect(yield* restored.range("again", 95, 101, 3)).toHaveLength(3)
        }).pipe(Effect.scoped, TestClock.withLive),
      60_000,
    )

    it.live(
      "F20 with-work: resumes copied job steps under a new id without repeating completed effects or copying work by default",
      () =>
        Effect.gen(function* () {
          const bucket = yield* (yield* backend.location).bucket
          const io = jobIO("finish")
          const runner = yield* jobRunner(bucket, "fork-jobs", io.layer)
          yield* submit(runner.engine, { id: "resume", amount: 17, mode: "normal" })
          yield* jobUntil("source job held after journaled steps", () =>
            io.calls.some((call) => call.phase === "finish"),
          )
          const sourceJob = Array.from(runner.engine.durableImage(0)!.jobs.values())[0]!
          const grant = {
            operator: "operator:jobs",
            capabilities: [{ action: "fork" as const, tenant: "default" }],
          }
          const at = { before: (yield* Clock.currentTimeMillis) + 1 }
          yield* Forks.fork(runner.engine, { actor: Worker, from: "one", to: "without", at, grant })
          yield* Forks.fork(runner.engine, {
            actor: Worker,
            from: "one",
            to: "with",
            at,
            grant,
            withWork: true,
          })
          yield* jobUntil(
            "copied job completed",
            () => runner.engine.durableImage(0)!.jobs.size === 1,
          )
          expect(yield* jobState(runner.engine, "one")).toMatchObject({ total: 17, finished: [] })
          expect(yield* jobState(runner.engine, "without")).toMatchObject({
            total: 17,
            finished: [],
          })
          expect(yield* jobState(runner.engine, "with")).toMatchObject({
            total: 17,
            finished: ["resume"],
          })
          expect(io.calls.filter((call) => call.phase === "prepare")).toHaveLength(1)
          const finishing = io.calls.filter((call) => call.phase === "finish")
          expect(finishing).toHaveLength(2)
          expect(finishing[0]!.key).not.toBe(finishing[1]!.key)
          const entries = (yield* Stream.runCollect(runner.store.read(0, 0n))).flatMap((segment) =>
            segment.entries.map((bytes) => Result.getOrThrow(EntryCodec.decode(bytes))),
          )
          const installed = entries.filter(Entry.guards.Forked)
          expect(installed.find((entry) => entry.key === "without")!.jobs).toEqual([])
          const copied = installed.find((entry) => entry.key === "with")!.jobs
          expect(copied).toHaveLength(1)
          expect(copied[0]!.jobId).not.toBe(sourceJob.jobId)
          expect(copied[0]!.steps.some((step) => step.name === "prepare")).toBe(true)
        }).pipe(Effect.scoped),
      30_000,
    )

    it.effect(
      "F21/F21′: serializes a checkpoint dedup PUT against an already selected old-page DELETE and retains the published root",
      () =>
        Effect.gen(function* () {
          const bucket = yield* (yield* backend.location).bucket
          const faults = Faults.plan()
          const a = yield* storeOf(bucket, { shards: 1, writer: "collector", faults })
          const b = yield* storeOf(bucket, { writer: "publisher" })
          const bytes = PageDocuments.encode({
            kind: "leaf",
            references: [],
            value: [[[1], { id: 1, at: 3, text: "deduplicated" }]],
          })
          const hash = yield* a.putPage(bytes)
          const lease = yield* b.open(0)
          yield* TestClock.setTime(
            Option.getOrThrow(yield* bucket.modified(pageKey(hash))) + 25 * 3_600_000,
          )
          const held = yield* faults.inject(Fault.Hold(), {
            match: ({ kind }) => kind === "delete",
          })
          const collecting = yield* Effect.forkChild(
            a.gc.collect({ references: PageDocuments.references, entryReferences: () => [] }),
          )
          yield* held.fired
          const publishing = b.gc.protect(b.putPage(bytes), (page) =>
            Effect.gen(function* () {
              expect(page).toBe(hash)
              yield* b.checkpoint(lease, { offset: lease.head, statePages: [page], indexPages: [] })
            }),
          )
          const blocked = yield* publishing.pipe(Effect.result)
          expect(Result.isFailure(blocked) && Schema.is(PagePublicationBusy)(blocked.failure)).toBe(
            true,
          )
          yield* held.release
          expect(yield* Fiber.join(collecting)).toMatchObject({
            outcome: "collected",
            deletedPages: 1,
          })
          expect(Option.isNone(yield* bucket.head(pageKey(hash)))).toBe(true)
          yield* publishing
          const report = yield* a.gc.collect({
            references: PageDocuments.references,
            entryReferences: () => [],
          })
          expect(report).toMatchObject({ outcome: "collected", marked: 1, deletedPages: 0 })
          expect(yield* b.getPage(hash)).toEqual(bytes)
        }).pipe(Effect.scoped),
      60_000,
    )

    it.effect(
      "F22: refuses a hash-corrupt cold page instead of returning default or partial list state",
      () =>
        Effect.gen(function* () {
          const bucket = yield* (yield* backend.location).bucket
          const runner = yield* pageRunner(bucket)
          yield* runner.call("source", "fill", 270)
          yield* runner.engine.drain("10 seconds")
          const [key] = yield* bucket.list(checkpointPrefix(0), { limit: 1 })
          const stored = yield* bucket.get(key!)
          const manifest = yield* decodeManifest(key!)(Option.getOrThrow(stored))
          const root = PageDocuments.decode(yield* runner.store.getPage(manifest.statePages[0]!))
          const actor = PageDocuments.decode(yield* runner.store.getPage(root.references[0]!))
          const ordered = actor.references[1]!
          const tree = PageDocuments.decode(yield* runner.store.getPage(ordered))
          const leaf = tree.kind === "leaf" ? ordered : tree.references[0]!
          yield* bucket.put(pageKey(leaf), new Uint8Array([1, 9, 4]))
          const cold = yield* pageRunner(bucket, { writer: "corrupt-reader" })
          const failed = yield* cold.range("source", undefined, undefined, 1).pipe(Effect.exit)
          expect(Exit.isFailure(failed) && Schema.is(PageCorrupt)(Cause.squash(failed.cause))).toBe(
            true,
          )
        }).pipe(Effect.scoped),
      60_000,
    )
  })
}
