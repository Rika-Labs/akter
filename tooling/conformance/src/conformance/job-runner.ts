import { Clock, Context, Deferred, Duration, Effect, Layer, Match, Schema, Stream } from "effect"
import { Actor, JobFailure, user } from "../../../../packages/akter/src/index.ts"
import type { DefOf, JobContext } from "../../../../packages/akter/src/index.ts"
import { DurableClock } from "../../../../packages/akter/src/server.ts"
import { CommandIds } from "../../../../packages/akter/src/execution/command-ids.ts"
import type { Catalog } from "../../../../packages/akter/src/execution/durable.ts"
import { Engine } from "../../../../packages/akter/src/execution/engine.ts"
import { Jobs } from "../../../../packages/akter/src/execution/jobs.ts"
import { Entry } from "../../../../packages/akter/src/execution/entries.ts"
import { WorkflowRecord } from "../../../../packages/akter/src/execution/workflow.ts"
import { Result } from "effect"
import { dual } from "effect/Function"
import { Transports } from "../../../../packages/akter/src/execution/transport.ts"
import type { Bucket } from "../../../../packages/akter/src/store/bucket.ts"
import { Faults } from "../../../../packages/akter/src/store/faults.ts"
import { Store, storeOf } from "../../../../packages/akter/src/store/service.ts"

/** Asymmetric task inputs shared by simulator and real-bucket job evidence. */
export const Task = Schema.Struct({
  id: Schema.String,
  amount: Schema.Int,
  mode: Schema.Literals(["normal", "failed", "defect", "timeout", "sleep", "stream"]),
})

/** One task. */
export type Task = typeof Task.Type

/** One journal boundary where a fixture may interrupt the owning process. */
export type JobPoint = "prepare" | "call" | "inside" | "afterFailure" | "cleanup"

/** Shared crash points ensure simulated and real-store scenarios interrupt the same transition. */
export const jobPoint: {
  (point: JobPoint, entry: Entry): boolean
  (point: JobPoint): (entry: Entry) => boolean
} = dual(2, (point: JobPoint, entry: Entry) =>
  Match.value(point).pipe(
    Match.when("prepare", () => Entry.guards.Step(entry) && entry.name === "prepare"),
    Match.when(
      "call",
      () => Entry.guards.Step(entry) && entry.name.startsWith("\u0000call\u0000apply"),
    ),
    Match.when("inside", () => Entry.guards.Step(entry) && entry.name === "finish"),
    Match.when(
      "afterFailure",
      () =>
        Entry.guards.Workflow(entry) &&
        WorkflowRecord.guards.JobCompleted(
          Result.getOrThrow(Schema.decodeUnknownResult(WorkflowRecord)(entry.value)),
        ),
    ),
    Match.when("cleanup", () => Entry.guards.JobRetired(entry)),
    Match.exhaustive,
  ),
)

/** The external boundary of the fixture, separate from actor and storage authority. */
export class JobIO extends Context.Service<
  JobIO,
  {
    readonly perform: (
      phase: string,
      task: Task,
      attempt: number,
      key: string,
    ) => Effect.Effect<void, string>
  }
>()("@akter/conformance/conformance/job-runner/JobIO") {}

/** One actor's accepted tasks, amounts and failure reports. */
export const Worker = Actor.make("JobWorker", {
  state: Schema.Struct({
    total: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    finished: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    failed: Schema.Array(JobFailure).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
  actions: {
    submit: Actor.action(Task),
    credit: Actor.action(Schema.Int, { internal: true, success: Schema.Int }),
    complete: Actor.action(Schema.String, { internal: true }),
    rejected: Actor.action(JobFailure, { internal: true }),
  },
  events: { token: Actor.event(Schema.String) },
  jobs: {
    work: Actor.job({
      payload: Task,
      retry: { attempts: 3, backoff: "100 millis" },
      concurrency: 2,
      onFailure: "rejected",
    }),
    timed: Actor.job({
      payload: Task,
      retry: { attempts: 3, backoff: "100 millis" },
      timeout: "2 seconds",
      concurrency: 2,
      onFailure: "rejected",
    }),
  },
})

/** A job keeps finished steps across retries, including non-JSON results and actor calls. */
const work = (
  task: Task,
  { self, step, attempt, emit, id }: JobContext<"JobWorker", DefOf<typeof Worker>>,
) =>
  Effect.gen(function* () {
    const io = yield* JobIO
    const amount = yield* step(
      "prepare",
      Schema.BigInt,
      Effect.suspend(() => io.perform("prepare", task, attempt, id())).pipe(
        Effect.as(BigInt(task.amount)),
      ),
    )
    yield* step("apply", self.credit(Number(amount)))
    if (task.mode === "sleep") yield* DurableClock.sleep({ name: "pause", duration: "250 millis" })
    yield* step(
      "finish",
      Effect.suspend(() => io.perform("finish", task, attempt, id())),
    )
    if (task.mode === "stream") {
      const tokens: Stream.Stream<string, string> =
        attempt === 1
          ? Stream.concat(Stream.make("partial"), Stream.fail("reset"))
          : Stream.make("whole", " answer")
      const text = yield* step(
        "stream",
        tokens.pipe(
          Stream.tap((token: string) => emit.token(token)),
          Stream.runFold(
            () => "",
            (all, token) => all + token,
          ),
        ),
      )
      yield* self.complete(`${task.id}:${text}`)
    } else yield* self.complete(task.id)
  })

/** Both declarations run the same body; only `timed` puts a deadline on an attempt. */
export const WorkerLive = Worker.toLayer({
  submit: (_, task, { start }) => {
    if (task.mode === "timeout") start.timed(task, { key: task.id })
    else start.work(task, { key: task.id })
  },
  credit: (worker, amount) => {
    worker.total += amount
    return worker.total
  },
  complete: (worker, id) => {
    worker.finished.push(id)
  },
  rejected: (worker, failure) => {
    worker.failed.push(failure)
  },
  work,
  timed: work,
})

/**
 * Instrumentation reports calls, admitted order and live external effects independently of state.
 * With `gate`, the first `gate.count` calls of `gate.phase` stay in flight until `gate.open`
 * completes, so concurrency is observed as calls held together rather than as short sleeps that
 * happen to overlap, which bucket latency spreads apart.
 */
export const jobIO = (
  holdPhase?: string,
  gate?: {
    readonly phase: string
    readonly count: number
    readonly open: Deferred.Deferred<void>
  },
) => {
  const calls: Array<{ phase: string; id: string; attempt: number; at: number; key: string }> = []
  let active = 0
  let peak = 0
  let held = false
  let gated = 0
  const layer = Layer.succeed(JobIO, {
    perform: (phase, task, attempt, key) =>
      Effect.gen(function* () {
        calls.push({ phase, id: task.id, attempt, key, at: yield* Clock.currentTimeMillis })
        active++
        peak = Math.max(peak, active)
        yield* Effect.gen(function* () {
          if (!held && phase === holdPhase) {
            held = true
            return yield* Effect.never
          }
          if (gate !== undefined && phase === gate.phase && gated < gate.count) {
            gated++
            yield* Deferred.await(gate.open)
          }
          yield* Effect.sleep("20 millis")
          if (phase !== "finish") return
          if (task.mode === "failed") return yield* Effect.fail("declined")
          if (task.mode === "defect") return yield* Effect.die("connection uncertain")
          if (task.mode === "timeout") return yield* Effect.never
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              active--
            }),
          ),
        )
      }),
  })
  return { layer, calls, peak: () => peak, active: () => active }
}

/** Opens one independent process-equivalent runner over the real bucket location. */
export const jobRunner = Effect.fnUntraced(function* (
  bucket: Bucket,
  writer: string,
  io: Layer.Layer<JobIO>,
  faults: Faults = Faults.plan(),
) {
  const store = yield* storeOf(bucket, {
    writer,
    build: { bundle: "job-conformance", framework: "0.2.0" },
    shards: 1,
    faults,
  })
  const context = yield* Layer.build(WorkerLive.pipe(Layer.provide(io)))
  const catalog: Catalog = {
    actors: new Map([
      [Worker.name, { actor: Worker, registered: Context.get(context, Worker.implementation) }],
    ]),
    shards: 1,
  }
  const engine = yield* Engine.make(catalog, {
    shards: 1,
    policy: "matching",
    maxBatch: 64,
    checkpointEvery: 3,
    cronSkipIfOlderThan: 3_600_000,
    doubleRun: false,
    observer: undefined,
  }).pipe(Effect.provideService(Store, store))
  Jobs.install(engine)
  yield* engine.assign([0])
  return { store, engine }
})

/** Submits a task through admission, never by inserting job records. */
export const submit = Effect.fnUntraced(function* (engine: Engine, task: Task, key = "one") {
  const id = yield* CommandIds.mint(yield* Clock.currentTimeMillis)
  return yield* Transports.admit(engine, user("jobs"), id, {
    actor: Worker,
    id: key,
    member: "submit",
    payload: task,
  })
})

/** Waits on real time for the observable phase; a timeout fails the scenario. */
export const jobUntil = Effect.fnUntraced(function* (what: string, check: () => boolean) {
  for (let poll = 0; poll < 2_000; poll++) {
    if (check()) return
    yield* Effect.sleep(Duration.millis(5))
  }
  return yield* Effect.die(new Error(`never ${what}`))
})

/** The actor's independently observable durable results. */
export const jobState = Effect.fnUntraced(function* (engine: Engine, key = "one") {
  return (yield* engine.durableRecord(Worker, key)).image.encoded
})
