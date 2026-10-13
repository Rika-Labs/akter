import { describe, expect, it } from "@effect/vitest"
import { Cause, Clock, Effect, Exit, Fiber, Option, Result, Schema, Stream } from "effect"
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
import type { EngineBackend } from "./engine.ts"
import { Entry, EntryCodec } from "../../../../packages/akter/src/execution/entries.ts"
import { jobIO, jobRunner, jobState, jobUntil, submit, Worker } from "./job-runner.ts"

export { Library, LibraryLive, pageRunner } from "./page-runner.ts"
import { Library, pageRunner } from "./page-runner.ts"
/** The same page-miss, fork and corruption scenarios run on filesystem and a real S3 bucket. */
export const pageConformance = <E, E2>(backend: EngineBackend<E, E2>) => {
  describe(`Pages, history and forks on ${backend.name}`, () => {
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
          const publishing = b.gc.protect(
            Effect.gen(function* () {
              expect(yield* b.putPage(bytes)).toBe(hash)
              yield* b.checkpoint(lease, { offset: lease.head, statePages: [hash], indexPages: [] })
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
