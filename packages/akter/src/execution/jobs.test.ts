import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, Fiber, Layer, Result, Schedule, Schema, Stream } from "effect"
import {
  Worker,
  WorkerLive,
  jobIO,
  jobPoint,
} from "../../../../tooling/conformance/src/conformance/job-runner.ts"
import { CommandIds } from "./command-ids.ts"
import { Entry, EntryCodec, Outcome } from "./entries.ts"
import { Simulation, SimulationService } from "../testing/index.ts"
import { Checkpoints } from "../snapshots/checkpoint.ts"
import { WorkflowRecord } from "./workflow.ts"
import { Actor, Job, JobFailure } from "../index.ts"
import type { DefOf, JobContext } from "../index.ts"
import type { Task } from "../../../../tooling/conformance/src/conformance/job-runner.ts"
import type { AnyHandler } from "../handlers/registry.ts"

const simulate = <A, E>(
  seed: number,
  io: ReturnType<typeof jobIO>,
  program: Effect.Effect<
    A,
    E,
    SimulationService | import("../contract/handle.ts").Client | import("effect").Scope.Scope
  >,
  faults: ReadonlyArray<import("../testing/simulated-bucket.ts").Fault> = [],
) =>
  Simulation.run(
    { actors: [Worker], seed, shards: 1, faults, checkpointEvery: 3, runners: [{}, {}] },
    Effect.scoped(program),
    WorkerLive.pipe(Layer.provide(io.layer)),
  )

const records = Effect.gen(function* () {
  const simulation = yield* SimulationService
  return (yield* simulation.logs).flatMap((log) =>
    log.segments.flatMap((segment) =>
      segment.entries.map((bytes) => Result.getOrThrow(EntryCodec.decode(bytes))),
    ),
  )
})

describe("durable jobs", () => {
  it("F17: an interrupted in-flight step retries external I/O, not finished steps or actor effects (rejects exactly-once external I/O and losing accepted work)", () => {
    const io = jobIO("finish")
    return simulate(
      1700,
      io,
      Effect.gen(function* () {
        const worker = yield* Worker.client("one")
        yield* worker.submit({ id: "inside", amount: 17, mode: "normal" })
        while (!io.calls.some((call) => call.phase === "finish")) yield* Effect.sleep("1 millis")
        const simulator = yield* SimulationService
        yield* simulator.engine.crash(0)
        yield* Simulation.settle
        const state = yield* Simulation.state(Worker, "one")
        expect(state.total).toBe(17)
        expect(state.finished).toEqual(["inside"])
        expect(io.calls.filter((call) => call.phase === "prepare").length).toBe(1)
        expect(
          io.calls.filter((call) => call.phase === "finish").map((call) => call.attempt),
        ).toEqual([1, 1])
      }),
    )
  })

  for (const point of ["prepare", "call", "inside", "afterFailure", "cleanup"] as const) {
    it(`F17/F17′/F18 ${point}: recovery resumes the same attempt (rejects lost steps, repeated finished calls and duplicate onFailure)`, () => {
      const io = jobIO()
      return simulate(
        1701,
        io,
        Effect.gen(function* () {
          const simulation = yield* SimulationService
          const engine = simulation.engine
          const journal = engine.journal
          let armed = true
          engine.journal = (shard, entry) =>
            Effect.suspend(() => {
              const hit = jobPoint(point, entry)
              if (armed && hit) {
                armed = false
                simulation.bucket.script({
                  runner: 0,
                  fault: "crashBefore",
                  shard,
                  match: (operation, key) => operation === "create" && key.includes("/log/"),
                })
              }
              return journal(shard, entry)
            })
          const worker = yield* Worker.client("one")
          yield* worker.submit({
            id: "k",
            amount: 7,
            mode: point === "afterFailure" ? "defect" : "normal",
          })
          yield* Simulation.settle
          const state = yield* Simulation.state(Worker, "one")
          expect(state.total).toBe(7)
          expect(state.finished).toEqual(point === "afterFailure" ? [] : ["k"])
          expect(state.failed.length).toBe(point === "afterFailure" ? 1 : 0)
          expect(io.calls.filter((call) => call.phase === "prepare").length).toBe(
            point === "prepare" ? 2 : 1,
          )
          expect(armed).toBe(false)
          const log = yield* records
          expect(
            log.filter((entry) => Entry.guards.Action(entry) && entry.member === "credit").length,
          ).toBe(1)
          expect(
            log
              .filter((entry) => Entry.guards.Attempt(entry))
              .map((entry) => (Entry.guards.Attempt(entry) ? entry.attempt : 0)),
          ).toEqual(point === "afterFailure" ? [1, 2, 3] : [1])
          expect(
            log.filter((entry) => Entry.guards.Action(entry) && entry.member === "failedWork")
              .length,
          ).toBe(point === "afterFailure" ? 1 : 0)
        }),
      )
    })
  }

  it("F18: typed failure, defect and timeout preserve the last cause and ambiguity across exhausted retries (rejects treating every failure as ambiguous or retrying a finished step)", () => {
    const io = jobIO()
    return simulate(
      1801,
      io,
      Effect.gen(function* () {
        const worker = yield* Worker.client("one")
        for (const [mode, amount] of [
          ["failed", 3],
          ["defect", 11],
          ["timeout", 19],
        ] as const)
          yield* worker.submit({ id: mode, amount, mode })
        yield* Simulation.settle
        const state = yield* Simulation.state(Worker, "one")
        expect(state.total).toBe(33)
        expect(
          state.failed
            .map(({ declaration, attempts, cause, ambiguous }) => ({
              declaration,
              attempts,
              cause,
              ambiguous,
            }))
            .sort((a, b) => a.cause.localeCompare(b.cause)),
        ).toEqual([
          { declaration: "work", attempts: 3, cause: "Defect", ambiguous: true },
          { declaration: "work", attempts: 3, cause: "Failed", ambiguous: false },
          { declaration: "timed", attempts: 3, cause: "Timeout", ambiguous: true },
        ])
        expect(io.calls.filter((call) => call.phase === "prepare").length).toBe(3)
        for (const mode of ["failed", "defect", "timeout"]) {
          const calls = io.calls.filter((call) => call.phase === "finish" && call.id === mode)
          expect(calls.map((call) => call.attempt)).toEqual([1, 2, 3])
          expect(new Set(calls.map((call) => call.key)).size).toBe(1)
          expect(calls[0]?.key).not.toBe(
            io.calls.find((call) => call.id === mode && call.phase === "prepare")?.key,
          )
          expect((calls[1]?.at ?? 0) - (calls[0]?.at ?? 0)).toBeGreaterThanOrEqual(100)
        }
      }),
    )
  })

  it("F19: declaration concurrency and FIFO admission survive load (rejects a per-instance limit or starting later jobs first)", () => {
    const io = jobIO()
    return simulate(
      1901,
      io,
      Effect.gen(function* () {
        const left = yield* Worker.client("left")
        const right = yield* Worker.client("right")
        for (let n = 0; n < 12; n++)
          yield* (n % 2 === 0 ? left : right).submit({ id: `k${n}`, amount: n + 1, mode: "normal" })
        yield* Simulation.settle
        const a = yield* Simulation.state(Worker, "left")
        const b = yield* Simulation.state(Worker, "right")
        expect([a.total, b.total]).toEqual([36, 42])
        expect([a.finished.length, b.finished.length]).toEqual([6, 6])
        expect(io.peak()).toBe(2)
        const log = yield* records
        const starts = log.flatMap((entry) =>
          Entry.guards.Action(entry) ? entry.effects.starts.map((start) => start.jobId) : [],
        )
        expect(log.flatMap((entry) => (Entry.guards.Attempt(entry) ? [entry.jobId] : []))).toEqual(
          starts,
        )
      }),
    )
  })

  it("durable sleep survives a checkpoint, drain and owner move without restarting its deadline (rejects a local sleep or nextDue that omits job clocks)", () => {
    const io = jobIO()
    return simulate(
      1702,
      io,
      Effect.gen(function* () {
        const simulation = yield* SimulationService
        const engine = simulation.engine
        const journal = engine.journal
        let due: number | undefined
        engine.journal = (shard, entry) =>
          journal(shard, entry).pipe(
            Effect.tap(() => {
              if (!Entry.guards.Workflow(entry)) return Effect.void
              const record = Result.getOrThrow(
                Schema.decodeUnknownResult(WorkflowRecord)(entry.value),
              )
              if (!WorkflowRecord.guards.ClockScheduled(record)) return Effect.void
              due = record.wakeAt
              return Effect.never
            }),
          )
        const worker = yield* Worker.client("one")
        yield* worker.submit({ id: "sleep", amount: 13, mode: "sleep" })
        while (due === undefined) yield* Effect.sleep("1 millis")
        const checkpoint = Checkpoints.capture(engine.durableImage(0)!)
        expect(Checkpoints.restore(engine.catalog, checkpoint).jobs.size).toBe(1)
        const report = yield* simulation.drain("1 second")
        expect(report.shards[0]?.nextDue).toBe(due)
        yield* simulation.assign(1)
        yield* Simulation.settle
        const state = yield* Simulation.state(Worker, "one")
        expect(state.total).toBe(13)
        expect(state.finished).toEqual(["sleep"])
        expect(io.calls.filter((call) => call.phase === "prepare").length).toBe(1)
        expect(
          (yield* records).filter(
            (entry) =>
              Entry.guards.Workflow(entry) &&
              WorkflowRecord.guards.ClockScheduled(
                Result.getOrThrow(Schema.decodeUnknownResult(WorkflowRecord)(entry.value)),
              ),
          ).length,
        ).toBe(1)
      }),
    )
  })

  it("stream progress may repeat on retry but the completed text and actor call do not (rejects journaling progress as durable facts or repeating the completed state update)", () => {
    const io = jobIO()
    return simulate(
      1902,
      io,
      Effect.gen(function* () {
        const worker = yield* Worker.client("one")
        const tokens = yield* Effect.forkScoped(
          worker.token.pipe(Stream.take(3), Stream.runCollect),
        )
        yield* worker.submit({ id: "stream", amount: 5, mode: "stream" })
        yield* Simulation.settle
        expect(yield* Fiber.join(tokens)).toEqual(["partial", "whole", " answer"])
        const state = yield* Simulation.state(Worker, "one")
        expect(state.finished).toEqual(["stream:whole answer"])
        expect(state.total).toBe(5)
        expect(io.calls.filter((call) => call.phase === "finish").length).toBe(1)
      }),
    )
  })

  for (const changed of ["missing", "schema"] as const) {
    it(`a ${changed} completed step suspends rather than fails the job (rejects silently discarding a journal or delivering onFailure for incompatible code)`, () => {
      const io = jobIO("finish")
      return simulate(
        1903,
        io,
        Effect.gen(function* () {
          const simulator = yield* SimulationService
          const worker = yield* Worker.client("one")
          yield* worker.submit({ id: "old", amount: 13, mode: "normal" })
          while (!io.calls.some((call) => call.phase === "finish")) yield* Effect.sleep("1 millis")
          const bound = simulator.catalog.actors.get(Worker.name)!
          const handlers = bound.registered.handlers as Map<string, AnyHandler>
          const original = handlers.get("work")!
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              handlers.set(
                "work",
                (_: Task, { step }: JobContext<"JobWorker", DefOf<typeof Worker>>) =>
                  changed === "missing"
                    ? Effect.void
                    : step(
                        "prepare",
                        Schema.Struct({ value: Schema.String }),
                        Effect.succeed({ value: "new" }),
                      ),
              )
            }),
            () =>
              Effect.sync(() => {
                handlers.set("work", original)
              }),
          )
          yield* simulator.engine.crash(0)
          yield* simulator.assign(1)
          yield* Simulation.settle
          const image = simulator.engine.durableImage(0)!
          expect(image.jobs.size).toBe(1)
          expect(Array.from(image.jobs.values())[0]?.suspended).toMatch(
            changed === "missing" ? /missing completed steps/ : /incompatible step result/,
          )
          const state = yield* Simulation.state(Worker, "one")
          expect(state.total).toBe(13)
          expect(state.failed).toEqual([])
          expect(state.finished).toEqual([])
        }),
      )
    })
  }

  it("seed matrix and exact replay: 200 faulted runs conserve job effects and 20 seeds reproduce their bytes", () => {
    const run = (seed: number) => {
      const io = jobIO()
      return simulate(
        seed,
        io,
        Effect.gen(function* () {
          const worker = yield* Worker.client("one")
          for (const [id, amount, mode] of [
            ["a", 7, "normal"],
            ["b", 13, "failed"],
            ["c", 23, "stream"],
          ] as const)
            yield* worker.submit({ id, amount, mode })
          yield* Simulation.settle
          const state = yield* Simulation.state(Worker, "one")
          expect(state.total).toBe(43)
          expect((yield* SimulationService).engine.durableImage(0)?.calls.size).toBe(0)
          expect([...state.finished].sort(), `seed ${seed}`).toEqual(["a", "c:whole answer"])
          expect(
            state.failed.map((failure) => [failure.cause, failure.attempts, failure.ambiguous]),
          ).toEqual([["Failed", 3, false]])
          const simulation = yield* SimulationService
          return Result.getOrThrow(
            Schema.encodeUnknownResult(Schema.fromJsonString(Schema.Unknown))(
              (yield* simulation.logs).map((log) => ({
                ...log,
                segments: log.segments.map((segment) => ({
                  ...segment,
                  offset: String(segment.offset),
                  open: String(segment.open),
                  entries: segment.entries.map((bytes) => Array.from(bytes)),
                })),
              })),
            ),
          )
        }),
        ["crash", "lostResponse", "unavailable", "slowLog"],
      )
    }
    return Array.from({ length: 200 }, (_, n) => n)
      .reduce(
        (previous, n) => previous.then(() => run(0x5eed_e500 + n).then(() => undefined)),
        Promise.resolve(),
      )
      .then(() =>
        Array.from({ length: 20 }, (_, n) => n).reduce(
          (previous, n) =>
            previous.then(() =>
              run(0x5eed_f500 + n).then((first) =>
                run(0x5eed_f500 + n).then((second) => {
                  expect(first).toBe(second)
                }),
              ),
            ),
          Promise.resolve(),
        ),
      )
  }, 120_000)
})

class Refused extends Schema.TaggedError<Refused>()("JobResultsRefused", {}) {}

const Request = Schema.Struct({
  id: Schema.String,
  amount: Schema.Int,
  mode: Schema.Literals(["fixed", "drifting"]),
})

const Policy = Schema.Literals(["backoff", "bounded", "ending", "slow", "timed"])

/** Body runs per request id and the clock reading of every failing attempt, reset per test. */
const runs = new Map<string, number>()
const failedAt: Array<{ readonly job: string; readonly attempt: number; readonly at: number }> = []

const Results = Actor.make("JobResults", {
  state: Schema.Struct({
    total: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    received: Schema.Array(Schema.Int).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    failed: Schema.Array(JobFailure).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
  commands: {
    request: Actor.command(Request),
    fail: Actor.command(Policy),
    succeededGenerate: Actor.command(Schema.Int, { internal: true, fails: Refused }),
    failedGenerate: Actor.command(JobFailure, { internal: true }),
  },
  jobs: {
    generate: Actor.job({
      payload: Request,
      onSuccess: "succeededGenerate",
      onFailure: "failedGenerate",
    }),
    backoff: Actor.job({ onFailure: "failedGenerate" }).pipe(
      Job.retry({ times: 2, schedule: Schedule.exponential("2 seconds") }),
    ),
    bounded: Actor.job({ onFailure: "failedGenerate" }).pipe(Job.retry({ times: 2 })),
    ending: Actor.job({ onFailure: "failedGenerate" }).pipe(
      Job.retry({
        times: 5,
        schedule: Schedule.spaced("1 second").pipe(Schedule.upTo({ times: 1 })),
      }),
    ),
    slow: Actor.job({ onFailure: "failedGenerate" }).pipe(
      Job.retry({ times: 1, schedule: Schedule.exponential("5 minutes") }),
    ),
    timed: Actor.job({ onFailure: "failedGenerate" }).pipe(
      Job.timeout("1 second"),
      Job.retry({ times: 1 }),
    ),
  },
})

const failing =
  (job: string) =>
  (_: undefined, { attempt }: { readonly attempt: number }) =>
    Effect.gen(function* () {
      failedAt.push({ job, attempt, at: yield* Clock.currentTimeMillis })
      return yield* Effect.fail("declined")
    })

const ResultsLive = Results.toLayer({
  request: (_, request, { start }) => {
    start.generate(request)
  },
  fail: (_, policy, { start }) => {
    start[policy]()
  },
  succeededGenerate: (results, amount) => {
    if (amount < 0) return Refused.make({})
    results.total += amount
    results.received.push(amount)
  },
  failedGenerate: (results, failure) => {
    results.failed.push(failure)
  },
  generate: (request, { step }) =>
    Effect.gen(function* () {
      const amount = yield* step("compute", Effect.succeed(request.amount))
      const run = (runs.get(request.id) ?? 0) + 1
      runs.set(request.id, run)
      return request.mode === "fixed" ? amount : amount * run
    }),
  backoff: failing("backoff"),
  bounded: failing("bounded"),
  ending: failing("ending"),
  slow: failing("slow"),
  timed: () => Effect.never,
})

const simulateResults = <A, E>(
  seed: number,
  program: Effect.Effect<
    A,
    E,
    SimulationService | import("../contract/handle.ts").Client | import("effect").Scope.Scope
  >,
) => {
  runs.clear()
  failedAt.length = 0
  return Simulation.run(
    { actors: [Results], seed, shards: 1, checkpointEvery: 3, runners: [{}, {}] },
    Effect.scoped(program),
    ResultsLive,
  )
}

/** Crashes runner 0 at the next log segment create: before it is written, or after. */
const crashAtNextSegment = (
  simulation: SimulationService["Service"],
  fault: "crashBefore" | "crashAfter",
  shard: number,
) =>
  Effect.sync(() =>
    simulation.bucket.script({
      runner: 0,
      fault,
      shard,
      match: (operation, key) => operation === "create" && key.includes("/log/"),
    }),
  )

/** What the success delivery left on the log: its actions, journaled values and job ends. */
const delivery = Effect.gen(function* () {
  const log = yield* records
  const actions = log.flatMap((entry) =>
    Entry.guards.Action(entry) && entry.member === "succeededGenerate" ? [entry] : [],
  )
  const jobId = log.flatMap((entry) =>
    Entry.guards.Action(entry) ? entry.effects.starts.map((start) => start.jobId) : [],
  )[0]
  return {
    jobId,
    actions,
    steps: log.flatMap((entry) =>
      Entry.guards.Step(entry) && entry.name === "\u0000onSuccess" ? [entry.value] : [],
    ),
    done: log.flatMap((entry) => (Entry.guards.Done(entry) ? [entry.outcome] : [])),
    retired: log.filter((entry) => Entry.guards.JobRetired(entry)).length,
  }
})

/** Every journaled attempt failure; each policy test starts one job. */
const failures = Effect.map(records, (log) =>
  log.flatMap((entry) => (Entry.guards.JobFailed(entry) ? [entry] : [])),
)

describe("job success delivery", () => {
  it("delivers the success value once to onSuccess under the job's derived id (rejects dropping the value, delivering it per attempt or as a body call)", () =>
    simulateResults(
      2001,
      Effect.gen(function* () {
        const results = yield* Results.client("one")
        yield* results.request({ id: "a", amount: 7, mode: "fixed" })
        yield* Simulation.settle
        const state = yield* Simulation.state(Results, "one")
        expect(state.total).toBe(7)
        expect(state.received).toEqual([7])
        expect(state.failed).toEqual([])
        const seen = yield* delivery
        expect(seen.steps).toEqual([{ value: 7 }])
        expect(seen.actions.map((action) => [action.payload, action.effects.outcome._tag])).toEqual(
          [[7, "Success"]],
        )
        expect(seen.actions[0]?.commandId).toBe(CommandIds.derive(seen.jobId!, "onSuccess"))
        expect(seen.done).toEqual(["Succeeded"])
        expect(seen.retired).toBe(1)
      }),
    ))

  for (const point of ["afterStep", "afterDelivery"] as const)
    for (const mode of ["fixed", "drifting"] as const)
      it(`${mode} body, crash ${point}: exactly one application of the journaled value (rejects redelivering under a fresh id, rerunning the body for the value, and a same-id conflict that strands the job)`, () =>
        simulateResults(
          2002,
          Effect.gen(function* () {
            const simulation = yield* SimulationService
            const engine = simulation.engine
            const journal = engine.journal
            const execute = engine.execute
            let armed = true
            engine.journal = (shard, entry) =>
              Effect.gen(function* () {
                const hit =
                  point === "afterStep" &&
                  Entry.guards.Step(entry) &&
                  entry.name === "\u0000onSuccess"
                if (armed && hit) {
                  armed = false
                  yield* crashAtNextSegment(simulation, "crashAfter", shard)
                }
                return yield* journal(shard, entry)
              })
            engine.execute = (command) =>
              execute(command).pipe(
                Effect.tap(() =>
                  armed && point === "afterDelivery" && command.member === "succeededGenerate"
                    ? Effect.andThen(
                        Effect.sync(() => {
                          armed = false
                        }),
                        crashAtNextSegment(simulation, "crashBefore", 0),
                      )
                    : Effect.void,
                ),
              )
            const results = yield* Results.client("one")
            yield* results.request({ id: "b", amount: 7, mode })
            yield* Simulation.settle
            expect(armed).toBe(false)
            const state = yield* Simulation.state(Results, "one")
            expect(state.total).toBe(7)
            expect(state.received).toEqual([7])
            expect(state.failed).toEqual([])
            const seen = yield* delivery
            expect(seen.steps).toEqual([{ value: 7 }])
            expect(
              seen.actions.map((action) => [action.payload, action.effects.outcome._tag]),
            ).toEqual([[7, "Success"]])
            expect(seen.done).toEqual(["Succeeded"])
            expect(seen.retired).toBe(1)
            expect(simulation.engine.durableImage(0)?.jobs.size ?? 0).toBe(0)
            if (point === "afterStep") expect(runs.get("b")).toBe(1)
          }),
        ))

  it("a declared failure of the onSuccess command still completes the job (rejects retrying the body, delivering onFailure or leaving the job open)", () =>
    simulateResults(
      2003,
      Effect.gen(function* () {
        const results = yield* Results.client("one")
        yield* results.request({ id: "c", amount: -4, mode: "fixed" })
        yield* Simulation.settle
        const state = yield* Simulation.state(Results, "one")
        expect(state.total).toBe(0)
        expect(state.received).toEqual([])
        expect(state.failed).toEqual([])
        expect(runs.get("c")).toBe(1)
        const seen = yield* delivery
        const refused = yield* Schema.encodeEffect(Refused)(Refused.make({}))
        expect(seen.actions.map((action) => [action.payload, action.effects.outcome])).toEqual([
          [-4, Outcome.cases.Failure.make({ error: refused })],
        ])
        expect(seen.done).toEqual(["Succeeded"])
        expect(seen.retired).toBe(1)
      }),
    ))
})

describe("job retry and timeout policies", () => {
  it("an exponential schedule journals 2s then 4s before the retries and none after the last attempt (rejects a constant or recomputed delay)", () =>
    simulateResults(
      2101,
      Effect.gen(function* () {
        const results = yield* Results.client("one")
        yield* results.fail("backoff")
        yield* Simulation.settle
        const entries = yield* failures
        expect(entries.map((entry) => [entry.attempt, entry.final])).toEqual([
          [1, false],
          [2, false],
          [3, true],
        ])
        expect(failedAt.map((failure) => failure.attempt)).toEqual([1, 2, 3])
        expect(entries.map((entry, n) => entry.retryAt - failedAt[n]!.at)).toEqual([
          2_000, 4_000, 0,
        ])
        const attempts = (yield* records).flatMap((entry) =>
          Entry.guards.Attempt(entry) ? [entry.at] : [],
        )
        expect(attempts.length).toBe(3)
        expect(attempts[1]!).toBeGreaterThanOrEqual(entries[0]!.retryAt)
        expect(attempts[2]!).toBeGreaterThanOrEqual(entries[1]!.retryAt)
        const state = yield* Simulation.state(Results, "one")
        expect(state.failed.map((failure) => [failure.attempts, failure.cause])).toEqual([
          [3, "Failed"],
        ])
      }),
    ))

  it("times bounds the retries after the first attempt with no delay by default (rejects times as total attempts or unbounded retries)", () =>
    simulateResults(
      2102,
      Effect.gen(function* () {
        const results = yield* Results.client("one")
        yield* results.fail("bounded")
        yield* Simulation.settle
        const entries = yield* failures
        expect(entries.map((entry) => [entry.attempt, entry.final])).toEqual([
          [1, false],
          [2, false],
          [3, true],
        ])
        expect(entries.map((entry, n) => entry.retryAt - failedAt[n]!.at)).toEqual([0, 0, 0])
        const state = yield* Simulation.state(Results, "one")
        expect(state.failed.map((failure) => failure.attempts)).toEqual([3])
      }),
    ))

  it("a schedule that ends stops retrying before times is spent (rejects ignoring the schedule's end)", () =>
    simulateResults(
      2103,
      Effect.gen(function* () {
        const results = yield* Results.client("one")
        yield* results.fail("ending")
        yield* Simulation.settle
        const entries = yield* failures
        expect(entries.map((entry) => [entry.attempt, entry.final])).toEqual([
          [1, false],
          [2, true],
        ])
        expect(entries.map((entry, n) => entry.retryAt - failedAt[n]!.at)).toEqual([1_000, 0])
        const state = yield* Simulation.state(Results, "one")
        expect(state.failed.map((failure) => failure.attempts)).toEqual([2])
      }),
    ))

  it("a crash between a failure and its retry, recovered two minutes later, keeps the journaled retryAt (rejects recomputing the delay or restarting it from recovery)", () =>
    simulateResults(
      2104,
      Effect.gen(function* () {
        const simulation = yield* SimulationService
        const engine = simulation.engine
        const journal = engine.journal
        let armed = true
        engine.journal = (shard, entry) =>
          Effect.gen(function* () {
            if (!armed || !Entry.guards.JobFailed(entry) || entry.attempt !== 1)
              return yield* journal(shard, entry)
            armed = false
            yield* crashAtNextSegment(simulation, "crashAfter", shard)
            return yield* journal(shard, entry).pipe(
              Effect.ensuring(
                Effect.gen(function* () {
                  const until = (yield* Clock.currentTimeMillis) + 120_000
                  for (const runner of [0, 1]) simulation.bucket.partition(runner, until)
                }),
              ),
            )
          })
        const results = yield* Results.client("one")
        yield* results.fail("slow")
        yield* Simulation.settle
        expect(armed).toBe(false)
        const entries = yield* failures
        expect(entries.map((entry) => [entry.attempt, entry.final])).toEqual([
          [1, false],
          [2, true],
        ])
        expect(entries[0]!.retryAt - failedAt[0]!.at).toBe(300_000)
        const second = (yield* records).flatMap((entry) =>
          Entry.guards.Attempt(entry) && entry.attempt === 2 ? [entry.at] : [],
        )
        expect(second.length).toBe(1)
        expect(second[0]!).toBeGreaterThanOrEqual(entries[0]!.retryAt)
        expect(second[0]!).toBeLessThan(entries[0]!.retryAt + 60_000)
        const state = yield* Simulation.state(Results, "one")
        expect(state.failed.map((failure) => failure.attempts)).toEqual([2])
      }),
    ))

  it("a timeout policy ends each attempt with cause Timeout (rejects losing the timeout when it is piped)", () =>
    simulateResults(
      2105,
      Effect.gen(function* () {
        const results = yield* Results.client("one")
        yield* results.fail("timed")
        yield* Simulation.settle
        const state = yield* Simulation.state(Results, "one")
        expect(state.failed.map((failure) => [failure.attempts, failure.cause])).toEqual([
          [2, "Timeout"],
        ])
      }),
    ))

  it("a JobFailed entry written before final existed decodes and stops by times (rejects breaking 0.2 logs or retrying them forever)", () => {
    const legacy = new TextEncoder().encode(
      `{"_tag":"JobFailed","jobId":"j","attempt":1,"cause":"Failed","ambiguous":false,"retryAt":5}`,
    )
    const decoded = Result.getOrThrow(EntryCodec.decode(legacy))
    expect(Entry.guards.JobFailed(decoded) && decoded.final).toBe(undefined)
    return simulateResults(
      2106,
      Effect.gen(function* () {
        const simulation = yield* SimulationService
        const engine = simulation.engine
        const journal = engine.journal
        engine.journal = (shard, entry) => {
          if (!Entry.guards.JobFailed(entry)) return journal(shard, entry)
          const { final: _, ...older } = entry
          return journal(shard, Entry.cases.JobFailed.make(older))
        }
        const results = yield* Results.client("one")
        yield* results.fail("bounded")
        yield* Simulation.settle
        const entries = yield* failures
        expect(entries.map((entry) => [entry.attempt, entry.final])).toEqual([
          [1, undefined],
          [2, undefined],
          [3, undefined],
        ])
        const state = yield* Simulation.state(Results, "one")
        expect(state.failed.map((failure) => failure.attempts)).toEqual([3])
      }),
    )
  })
})
