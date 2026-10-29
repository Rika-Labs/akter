import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Result, Schema, Scope, Stream } from "effect"
import { Durable } from "../../../../packages/akter/src/execution/durable.ts"
import { Entry, EntryCodec } from "../../../../packages/akter/src/execution/entries.ts"
import { WorkflowRecord } from "../../../../packages/akter/src/execution/workflow.ts"
import { Fault, Faults } from "../../../../packages/akter/src/store/faults.ts"
import type { Injection } from "../../../../packages/akter/src/store/faults.ts"
import type { EngineBackend, EngineLocation } from "./engine.ts"
import { gatedJobIO, jobIO, jobPoint, jobRunner, jobState, jobUntil, submit } from "./job-runner.ts"

/** Closing this runner's scope discards its memory while the bucket keeps its durable segments. */
const started = <E>(
  location: EngineLocation<E>,
  writer: string,
  io: ReturnType<typeof jobIO>,
  faults = Faults.plan(),
) =>
  Effect.gen(function* () {
    const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    )
    const opened = yield* Scope.provide(scope)(
      Effect.flatMap(location.bucket, (bucket) => jobRunner(bucket, writer, io.layer, faults)),
    )
    return { ...opened, crash: Scope.close(scope, Exit.void) }
  })

/** Runs failure evidence on the actual backend, with faults before real create-once segment writes. */
export const jobConformance = <OpenError, ClientError>(
  backend: EngineBackend<OpenError, ClientError>,
) =>
  describe(`Jobs on ${backend.name}`, () => {
    it.live(
      "F17: a process lost inside a step repeats that external attempt but not its finished steps (rejects losing accepted work or claiming exactly-once provider I/O)",
      () =>
        Effect.gen(function* () {
          const io = jobIO("finish")
          const location = yield* backend.location
          const a = yield* started(location, "a", io)
          yield* submit(a.engine, { id: "inside", amount: 17, mode: "normal" })
          yield* jobUntil("in-flight external effect", () =>
            io.calls.some((call) => call.phase === "finish"),
          )
          yield* a.crash
          const b = yield* started(location, "b", io)
          yield* jobUntil("job resumed", () => b.engine.durableImage(0)?.jobs.size === 0)
          const state = yield* jobState(b.engine)
          expect(state.total).toBe(17)
          expect(state.finished).toEqual(["inside"])
          expect(io.calls.filter((call) => call.phase === "prepare").length).toBe(1)
          expect(
            io.calls.filter((call) => call.phase === "finish").map((call) => call.attempt),
          ).toEqual([1, 1])
        }),
      30_000,
    )

    it.live(
      "a mid-stream retry repeats progress but commits one complete answer (rejects durable progress events or duplicate final actor calls)",
      () =>
        Effect.gen(function* () {
          const io = jobIO()
          const a = yield* started(yield* backend.location, "a", io)
          const channel = yield* a.engine.channel(Durable.addressOf("JobWorker", "one"))
          const tokens = yield* Effect.forkChild(
            Stream.fromPubSub(channel.events).pipe(
              Stream.map((event) => event.value),
              Stream.take(3),
              Stream.runCollect,
            ),
          )
          yield* submit(a.engine, { id: "stream", amount: 5, mode: "stream" })
          yield* jobUntil("stream completion", () => a.engine.durableImage(0)?.jobs.size === 0)
          expect(yield* Fiber.join(tokens)).toEqual(["partial", "whole", " answer"])
          const state = yield* jobState(a.engine)
          expect(state.total).toBe(5)
          expect(state.finished).toEqual(["stream:whole answer"])
          expect(io.calls.filter((call) => call.phase === "finish").length).toBe(1)
        }),
      30_000,
    )

    for (const point of ["prepare", "call", "inside", "afterFailure", "cleanup"] as const) {
      it.live(
        `F17/F17′/F18 ${point}: crash before journal durability resumes one effect (rejects forgotten completed steps, duplicate actor calls and duplicate onFailure)`,
        () =>
          Effect.gen(function* () {
            const io = jobIO()
            const location = yield* backend.location
            const faults = Faults.plan()
            const a = yield* started(location, "a", io, faults)
            const hit = yield* Deferred.make<Injection>()
            const journal = a.engine.journal
            let armed = true
            a.engine.journal = (shard, entry) =>
              Effect.gen(function* () {
                const matches = jobPoint(point, entry)
                if (armed && matches) {
                  armed = false
                  const injection = yield* faults.inject(Fault.Hold(), {
                    match: (operation) =>
                      operation.kind === "create" && operation.key.includes("/log/"),
                  })
                  yield* Deferred.succeed(hit, injection)
                }
                yield* journal(shard, entry)
              })
            yield* submit(a.engine, {
              id: "crash",
              amount: 7,
              mode: point === "afterFailure" ? "defect" : "normal",
            })
            const injection = yield* Deferred.await(hit)
            yield* injection.fired
            yield* a.crash
            const b = yield* started(location, "b", io)
            yield* jobUntil(
              "recovered job completion",
              () => b.engine.durableImage(0)?.jobs.size === 0,
            )
            const state = yield* jobState(b.engine)
            expect(state.total).toBe(7)
            expect(state.finished).toEqual(point === "afterFailure" ? [] : ["crash"])
            expect(Array.isArray(state.failed) ? state.failed.length : -1).toBe(
              point === "afterFailure" ? 1 : 0,
            )
            expect(io.calls.filter((call) => call.phase === "prepare").length).toBe(
              point === "prepare" ? 2 : 1,
            )
            const log = (yield* Stream.runCollect(b.store.read(0, 0n))).flatMap((segment) =>
              segment.entries.map((bytes) => Result.getOrThrow(EntryCodec.decode(bytes))),
            )
            expect(
              log.filter((entry) => Entry.guards.Action(entry) && entry.member === "credit").length,
            ).toBe(1)
            expect(
              log.filter((entry) => Entry.guards.Action(entry) && entry.member === "failedWork")
                .length,
            ).toBe(point === "afterFailure" ? 1 : 0)
          }),
        30_000,
      )
    }

    it.live(
      "F18: exhausted typed failures, defects and timeouts record the right ambiguous flag and one failure action (rejects reexecuting successful steps and claiming uncertain I/O was rejected)",
      () =>
        Effect.gen(function* () {
          const io = jobIO()
          const a = yield* started(yield* backend.location, "a", io)
          for (const [mode, amount] of [
            ["failed", 3],
            ["defect", 11],
            ["timeout", 19],
          ] as const)
            yield* submit(a.engine, { id: mode, amount, mode })
          yield* jobUntil("three failure reports", () => a.engine.durableImage(0)?.jobs.size === 0)
          const state = yield* jobState(a.engine)
          expect(state.total).toBe(33)
          const failures = Result.getOrThrow(
            Schema.decodeUnknownResult(Schema.Array(WorkerFailure))(state.failed),
          )
          expect(
            failures
              .map(({ attempts, cause, ambiguous }) => ({ attempts, cause, ambiguous }))
              .sort((a, b) => a.cause.localeCompare(b.cause)),
          ).toEqual([
            { attempts: 3, cause: "Defect", ambiguous: true },
            { attempts: 3, cause: "Failed", ambiguous: false },
            { attempts: 3, cause: "Timeout", ambiguous: true },
          ])
          expect(io.calls.filter((call) => call.phase === "prepare").length).toBe(3)
          for (const id of ["failed", "defect", "timeout"]) {
            const calls = io.calls.filter((call) => call.phase === "finish" && call.id === id)
            expect(calls.map((call) => call.attempt)).toEqual([1, 2, 3])
            expect(new Set(calls.map((call) => call.key)).size).toBe(1)
            expect(calls[0]?.key).not.toBe(
              io.calls.find((call) => call.id === id && call.phase === "prepare")?.key,
            )
            expect((calls[1]?.at ?? 0) - (calls[0]?.at ?? 0)).toBeGreaterThanOrEqual(100)
          }
        }),
      30_000,
    )

    it.live(
      "F19: one declaration admits in start order and never exceeds its shard limit (rejects unbounded or per-instance concurrency)",
      () =>
        Effect.gen(function* () {
          const open = yield* Deferred.make<void>()
          const io = gatedJobIO({ phase: "prepare", count: 2, open })
          const a = yield* started(yield* backend.location, "a", io)
          const submitting = (n: number) =>
            submit(
              a.engine,
              { id: `k${n}`, amount: n + 1, mode: "normal" },
              n % 2 === 0 ? "left" : "right",
            )
          for (let n = 0; n < 4; n++) yield* submitting(n)
          yield* jobUntil("two jobs in flight together", () => io.active() === 2)
          yield* Effect.sleep("500 millis")
          expect(io.calls.map((call) => call.id)).toEqual(["k0", "k1"])
          yield* Deferred.succeed(open, undefined)
          for (let n = 4; n < 12; n++) yield* submitting(n)
          yield* jobUntil("all accepted jobs", () => a.engine.durableImage(0)?.jobs.size === 0)
          const left = yield* jobState(a.engine, "left")
          const right = yield* jobState(a.engine, "right")
          expect([left.total, right.total]).toEqual([36, 42])
          expect([
            Array.isArray(left.finished) ? left.finished.length : -1,
            Array.isArray(right.finished) ? right.finished.length : -1,
          ]).toEqual([6, 6])
          expect(io.peak()).toBe(2)
          const log = (yield* Stream.runCollect(a.store.read(0, 0n))).flatMap((segment) =>
            segment.entries.map((bytes) => Result.getOrThrow(EntryCodec.decode(bytes))),
          )
          const starts = log.flatMap((entry) =>
            Entry.guards.Action(entry) ? entry.effects.starts.map((start) => start.jobId) : [],
          )
          expect(
            log.flatMap((entry) => (Entry.guards.Attempt(entry) ? [entry.jobId] : [])),
          ).toEqual(starts)
        }),
      30_000,
    )

    it.live(
      "checkpointed sleep moves owners and retains its original nextDue (rejects a sleep that restarts after drain)",
      () =>
        Effect.gen(function* () {
          const io = jobIO()
          const location = yield* backend.location
          const a = yield* started(location, "a", io)
          const hit = yield* Deferred.make<number>()
          const journal = a.engine.journal
          a.engine.journal = (shard, entry) =>
            journal(shard, entry).pipe(
              Effect.tap(() => {
                if (!Entry.guards.Workflow(entry)) return Effect.void
                const record = Result.getOrThrow(
                  Schema.decodeUnknownResult(WorkflowRecord)(entry.value),
                )
                return WorkflowRecord.guards.ClockScheduled(record)
                  ? Deferred.succeed(hit, record.wakeAt).pipe(Effect.andThen(Effect.never))
                  : Effect.void
              }),
            )
          yield* submit(a.engine, { id: "sleep", amount: 13, mode: "sleep" })
          const due = yield* Deferred.await(hit)
          const report = yield* a.engine.drain("2 seconds")
          expect(report.outcome).toBe("clean")
          expect(report.shards[0]?.nextDue).toBe(due)
          yield* a.crash
          const b = yield* started(location, "b", io)
          yield* jobUntil(
            "sleep completion on next owner",
            () => b.engine.durableImage(0)?.jobs.size === 0,
          )
          const state = yield* jobState(b.engine)
          expect(state.total).toBe(13)
          expect(state.finished).toEqual(["sleep"])
          expect(io.calls.filter((call) => call.phase === "prepare").length).toBe(1)
          expect(io.calls.find((call) => call.phase === "finish")?.at).toBeGreaterThanOrEqual(due)
        }),
      30_000,
    )
  })

const WorkerFailure = Schema.Struct({
  attempts: Schema.Int,
  cause: Schema.String,
  ambiguous: Schema.Boolean,
})
