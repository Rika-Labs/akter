import {
  Deferred,
  type Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Predicate,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect"
import { Actor, type AnyConnection, User } from "../../index.ts"
import type { ExecutorContext } from "../../contexts/job.ts"
import type { ActorRef } from "../../identity/caller.ts"
import { ActorTest, ProgressRecord, type TestConnection, type TestMessage } from "../actor-test.ts"
import { ActorCluster } from "../cluster.ts"
import type { ConformanceCase, ConformanceEnvironment, ConformanceSuite } from "../conformance.ts"

/** What one executor attempt does after reporting its frames. */
type ProgressStep = "ok" | "fail"

export interface ProgressFixture {
  /** Frames each Transcode attempt reports, in order, before it returns. */
  frames: Array<unknown>
  plan: Array<ProgressStep>
  /** The last attempt's executor context, kept past the attempt's end. */
  captured: ExecutorContext<typeof Transcode | typeof Import | typeof Thumbnail> | undefined
  /** Whether a Transcode attempt saw its own `progress` call fail. */
  progressFailed: boolean
}

export const progressFixture = (): ProgressFixture => ({
  frames: [],
  plan: [],
  captured: undefined,
  progressFailed: false,
})

class EncoderDown extends Schema.TaggedError<EncoderDown>()("EncoderDown", {}) {}

const Stage = Schema.Struct({
  percent: Schema.Finite,
  stage: Schema.Literals(["probe", "encode", "upload"]),
  note: Schema.optional(Schema.String),
})

const Transcode = Actor.job("Transcode", {
  payload: { assetId: Schema.String },
  success: Schema.String,
  progress: Stage,
})

const Import = Actor.job("Import", {
  payload: { rows: Schema.Int },
  progress: Schema.Struct({ done: Schema.Int }),
})

const Thumbnail = Actor.job("Thumbnail", {
  payload: { assetId: Schema.String },
})

const Start = Actor.command("Start", { payload: Schema.String })

const Thumb = Actor.command("Thumb", { payload: Schema.String })

const Transcoded = Actor.command("Transcoded", { payload: Schema.String })

const Watch = Actor.connection("Watch", {
  server: Schema.String,
  progress: { jobs: [Transcode, Import] },
})

const Encoder = Actor.make("Encoder", {
  key: Schema.String,
  state: Actor.state({
    outputs: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
  jobs: {
    Transcode: {
      job: Transcode,
      retry: { times: 1 },
      onSuccess: Transcoded,
      progressEvery: "1 minute",
    },
    Import: { job: Import },
    Thumbnail: { job: Thumbnail, retry: { times: 0 } },
  },
  api: { Start, Thumb, Watch },
  internal: { Transcoded },
})

const EncoderState = Schema.Struct({ outputs: Schema.optional(Schema.Array(Schema.String)) })

export const progressLayer = (fixture: ProgressFixture) =>
  Layer.mergeAll(
    Encoder.toLayer(
      Effect.succeed({
        Start: Effect.fnUntraced(function* (assetId: string) {
          yield* (yield* Encoder.Turn).enqueue(Transcode.make({ assetId }))
        }),
        Thumb: Effect.fnUntraced(function* (assetId: string) {
          yield* (yield* Encoder.Turn).enqueue(Thumbnail.make({ assetId }))
        }),
        Transcoded: Effect.fnUntraced(function* (output: string) {
          const turn = yield* Encoder.Turn
          yield* turn.state.set({ outputs: [...turn.state.outputs, output] })
        }),
        Watch: { open: () => Effect.void, frame: () => Effect.void },
      }),
    ),
    Encoder.toJobLayer(
      Effect.succeed({
        Transcode: Effect.fnUntraced(function* ({ assetId }) {
          const exec = yield* Encoder.Executor
          fixture.captured = exec

          for (const frame of fixture.frames)
            yield* exec.progress(Transcode, frame as typeof Stage.Type).pipe(
              Effect.exit,
              Effect.tap((exit) =>
                Effect.sync(() => {
                  fixture.progressFailed ||= Exit.isFailure(exit)
                }),
              ),
            )

          if (fixture.plan.shift() === "fail") return yield* EncoderDown.make({})

          return `${assetId}.mp4`
        }),
        Import: () => Effect.void,
        Thumbnail: Effect.fnUntraced(function* () {
          fixture.captured = yield* Encoder.Executor
        }),
      }),
    ),
  )

const recordsOf = Effect.fnUntraced(function* (id: string) {
  const records = yield* (yield* ActorTest).progress

  return records.filter((record) => record.ref.id === id)
})

const framesOf = (records: ReadonlyArray<ProgressRecord>) =>
  records.flatMap((record) =>
    ProgressRecord.$is("Progress")(record)
      ? [
          {
            attempt: record.attempt,
            seq: record.seq,
            frame: JSON.parse(new TextDecoder().decode(record.frame)) as unknown,
          },
        ]
      : [],
  )

const closedOf = (records: ReadonlyArray<ProgressRecord>) =>
  records.filter(ProgressRecord.$is("ProgressClosed"))

const outputsOf = Effect.fnUntraced(function* (id: string) {
  const encoder = yield* Encoder.get(id)
  const { state } = yield* (yield* ActorTest).inspect(encoder.ref)
  const decoded = yield* Schema.decodeUnknownEffect(EncoderState)(state).pipe(Effect.orDie)

  return decoded.outputs ?? []
})

const probe = { percent: 5, stage: "probe" } as const

const encode = { percent: 50, stage: "encode" } as const

const upload = { percent: 95, stage: "upload" } as const

export const progressConformance: ReadonlyArray<ConformanceCase<ProgressFixture>> = [
  {
    name: "sends an executor's latest progress frame before the effect settles, then closes it",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const encoder = yield* Encoder.get("latest")
          fixture.frames = [probe, encode, upload]
          yield* encoder.Start("a")
          yield* test.advance(0)
          const records = yield* recordsOf("latest")
          const frames = framesOf(records)
          const effectId = fixture.captured?.jobId

          expect([1, 2]).toContain(frames.length)
          expect(frames.at(-1)).toEqual({ attempt: 1, seq: 3, frame: upload })
          expect(frames.map((frame) => frame.seq)).toEqual(
            frames.map((frame) => frame.seq).toSorted((a, b) => a - b),
          )
          expect(records.every((record) => record.effectId === effectId)).toBe(true)
          expect(records.at(-1) && ProgressRecord.$is("ProgressClosed")(records.at(-1)!)).toBe(true)
          expect(records.at(-1)).toMatchObject({ attempt: 1 })
          expect(yield* outputsOf("latest")).toEqual(["a.mp4"])
          expect(yield* test.inspect(encoder.ref)).toMatchObject({ outbox: 0, jobs: 0 })
        }),
      ),
  },
  {
    name: "drops undecodable, oversized, and mismatched progress frames without failing the effect",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const encoder = yield* Encoder.get("invalid")
          const exec = () => fixture.captured!
          fixture.frames = [
            { percent: "half", stage: "encode" },
            { percent: 1, stage: "encode", note: "x".repeat(5000) },
            { percent: 1, stage: "mux" },
          ]
          fixture.progressFailed = false
          yield* encoder.Start("b")
          yield* test.advance(0)
          yield* exec().progress(Import as never, { done: 1 } as never)

          expect(fixture.progressFailed).toBe(false)
          expect(framesOf(yield* recordsOf("invalid"))).toEqual([])
          expect(closedOf(yield* recordsOf("invalid")).length).toBe(1)
          expect(yield* outputsOf("invalid")).toEqual(["b.mp4"])
        }),
      ),
  },
  {
    name: "ignores a captured progress callback once its attempt ends",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const encoder = yield* Encoder.get("captured")
          fixture.frames = [probe]
          yield* encoder.Start("c")
          yield* test.advance(0)
          const before = (yield* recordsOf("captured")).length
          yield* fixture.captured!.progress(Transcode, upload)
          yield* test.advance("1 minute")

          expect((yield* recordsOf("captured")).length).toBe(before)
          expect(framesOf(yield* recordsOf("captured"))).toEqual([
            { attempt: 1, seq: 1, frame: probe },
          ])
        }),
      ),
  },
  {
    name: "keeps progress open across a retryable failure and restarts the sequence per attempt",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const encoder = yield* Encoder.get("retry")
          fixture.frames = [encode]
          fixture.plan = ["fail"]
          yield* encoder.Start("d")
          yield* test.advance(0)

          expect(closedOf(yield* recordsOf("retry"))).toEqual([])
          expect(framesOf(yield* recordsOf("retry"))).toEqual([
            { attempt: 1, seq: 1, frame: encode },
          ])
          yield* test.advance("1 minute")
          const records = yield* recordsOf("retry")

          expect(framesOf(records)).toEqual([
            { attempt: 1, seq: 1, frame: encode },
            { attempt: 2, seq: 1, frame: encode },
          ])
          expect(closedOf(records)).toMatchObject([{ attempt: 2 }])
          expect(yield* outputsOf("retry")).toEqual(["d.mp4"])
        }),
      ),
  },
  {
    name: "closes progress when an effect dead-letters",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const encoder = yield* Encoder.get("dead")
          fixture.frames = [probe]
          fixture.plan = ["fail", "fail"]
          yield* encoder.Start("e")
          yield* test.advance(0)
          yield* test.advance("1 minute")
          const records = yield* recordsOf("dead")

          expect(framesOf(records).map((frame) => frame.attempt)).toEqual([1, 2])
          expect(closedOf(records)).toMatchObject([{ attempt: 2 }])
          expect(yield* outputsOf("dead")).toEqual([])
          expect(yield* test.inspect(encoder.ref)).toMatchObject({ outbox: 0, jobs: 0 })
        }),
      ),
  },
  {
    name: "loses dropped progress frames without changing the effect's durable outcome",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const encoder = yield* Encoder.get("lossy")
          fixture.frames = [probe, encode, upload]
          yield* test.dropProgress((message) => message.ref.id === "lossy")
          yield* encoder.Start("f")
          yield* test.advance(0)
          yield* test.dropProgress(() => false)
          const records = yield* recordsOf("lossy")

          expect(
            records.every(
              (record) => ProgressRecord.$is("ProgressClosed")(record) || record.dropped,
            ),
          ).toBe(true)
          expect(yield* outputsOf("lossy")).toEqual(["f.mp4"])
          expect(yield* test.receiptsFor(encoder.ref, "Transcoded")).toBe(1)
        }),
      ),
  },
  {
    name: "sends no progress for an effect that declares no progress schema",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const encoder = yield* Encoder.get("plain")
          yield* encoder.Thumb("g")
          yield* test.advance(0)
          yield* fixture.captured!.progress(Transcode, probe)

          expect(yield* recordsOf("plain")).toEqual([])
        }),
      ),
  },
]

const Render = Actor.job("Render", {
  payload: { job: Schema.String },
  success: Schema.String,
  progress: Schema.Struct({ percent: Schema.Finite }),
})

class Rendered extends Schema.TaggedClass<Rendered>()("Rendered", { output: Schema.String }) {}

/** How one Render executor runs: it reports `frames` once `go` opens, then returns once `finish` opens. */
interface RenderPlan {
  readonly frames: ReadonlyArray<number>
  readonly go: Deferred.Deferred<void>
  readonly finish: Deferred.Deferred<void>
}

const renderPlans = new Map<string, RenderPlan>()

const plan = (job: string, frames: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    const created: RenderPlan = {
      frames,
      go: yield* Deferred.make<void>(),
      finish: yield* Deferred.make<void>(),
    }

    renderPlans.set(job, created)

    return created
  })

const Render_ = Actor.command("Render", { payload: Schema.String })

const Finished = Actor.command("Finished", { payload: Schema.String })

/** Performs Render under the job as its key, so a later turn can cancel it. */
const RenderKeyed = Actor.command("RenderKeyed", { payload: Schema.String })

/** Cancels the keyed Render of a job and tells `Mine` connections in the same turn. */
const CancelRender = Actor.command("CancelRender", { payload: Schema.String })

/** Progress for the performer's own connections only (the default audience). */
const Mine = Actor.connection("Mine", { server: Rendered, progress: { jobs: [Render] } })

/** Progress for every open connection of the member. */
const Everyone = Actor.connection("Everyone", {
  server: Rendered,
  progress: { jobs: [Render], to: "all" },
})

/** Receives no progress: it lists no effect. */
const Quiet = Actor.connection("Quiet", { server: Rendered })

/** A stream of the job's progress percentages, filtered by the effect's own input. */
const Percent = Actor.stream("Percent", {
  payload: Schema.String,
  success: Schema.Finite,
  progress: { jobs: [Render] },
})

/** Receives every Render frame; each client frame `n` makes the owner send it `n` frames. */
const Busy = Actor.connection("Busy", {
  server: Rendered,
  client: Schema.Finite,
  progress: { jobs: [Render], to: "all" },
})

/** Broadcasts one frame to `Busy`, from a turn of whichever activation owns the actor. */
const Announce = Actor.command("Announce", { payload: Schema.String })

const Studio = Actor.make("Studio", {
  key: Schema.String,
  jobs: {
    Render: { job: Render, onSuccess: Finished, retry: { times: 0 }, progressEvery: "50 millis" },
  },
  api: {
    Render: Render_,
    RenderKeyed,
    CancelRender,
    Mine,
    Everyone,
    Quiet,
    Percent,
    Busy,
    Announce,
  },
  internal: { Finished },
})

const handlers = { open: () => Effect.void, frame: () => Effect.void }

const studioCommands = Studio.toLayer(
  Effect.succeed({
    Render: Effect.fnUntraced(function* (job: string) {
      yield* (yield* Studio.Turn).enqueue(Render.make({ job }))
    }),
    RenderKeyed: Effect.fnUntraced(function* (job: string) {
      yield* (yield* Studio.Turn).enqueue(Render.make({ job }), { key: job })
    }),
    CancelRender: Effect.fnUntraced(function* (job: string) {
      const turn = yield* Studio.Turn
      yield* turn.cancelJob(job)
      yield* turn.broadcast(Mine, Rendered.make({ output: `cancelled-${job}` }))
    }),
    Finished: Effect.fnUntraced(function* (output: string) {
      const turn = yield* Studio.Turn
      yield* turn.broadcast(Mine, Rendered.make({ output }))
      yield* turn.broadcast(Everyone, Rendered.make({ output }))
      yield* turn.broadcast(Quiet, Rendered.make({ output }))
      yield* turn.broadcast(Busy, Rendered.make({ output }))
    }),
    Mine: handlers,
    Everyone: handlers,
    Quiet: handlers,
    Busy: {
      open: () => Effect.void,
      frame: Effect.fnUntraced(function* (count: number) {
        const conn = yield* Studio.Connection

        for (let index = 0; index < count; index++)
          yield* conn.send(Rendered.make({ output: `flood-${index}` }))
      }),
    },
    Announce: Effect.fnUntraced(function* (output: string) {
      yield* (yield* Studio.Turn).broadcast(Busy, Rendered.make({ output }))
    }),
    Percent: (job: string) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const read = yield* Studio.Read

          return read.progress(Render).pipe(
            Stream.filter((entry) => entry.job.job === job),
            Stream.map((entry) => entry.frame.percent),
          )
        }),
      ),
  }),
)

export const studioExecutors = Studio.toJobLayer(
  Effect.succeed({
    Render: Effect.fnUntraced(function* ({ job }) {
      const exec = yield* Studio.Executor
      const found = renderPlans.get(job)

      if (found === undefined) return job
      yield* Deferred.await(found.go)

      for (const percent of found.frames) {
        yield* exec.progress(Render, { percent })
        yield* Effect.sleep("150 millis")
      }

      yield* Deferred.await(found.finish)

      return `${job}.png`
    }),
  }),
)

export const studioLayer = Layer.mergeAll(studioCommands, studioExecutors)

type StudioMessage = TestMessage<Rendered>

const WAIT = "20 seconds"

const nextOf = <C extends AnyConnection>(connection: TestConnection<C>) =>
  connection.messages.pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.map((chunk) => [...chunk][0] as StudioMessage | undefined),
    Effect.timeoutOrElse({
      duration: WAIT,
      orElse: () => Effect.die(new Error("No connection message arrived")),
    }),
  )

/** Messages that arrive within `window`, without waiting past it. */
const quietFor = <C extends AnyConnection>(connection: TestConnection<C>, window: Duration.Input) =>
  connection.messages.pipe(
    Stream.interruptWhen(Effect.sleep(window)),
    Stream.runCollect,
    Effect.map((chunk): ReadonlyArray<StudioMessage> => [...chunk] as never),
  )

const progressOf = (message: StudioMessage | undefined) =>
  Predicate.isTagged(message, "Progress") ? message : undefined

/** A member frame's value, or undefined for progress and control frames. */
const frameOf = (message: StudioMessage | undefined) =>
  Predicate.isTagged(message, "Frame") ? message.frame : undefined

const bob = User.make({ subject: "bob" })

const withStudioCluster = <A, E>(
  environment: ConformanceEnvironment,
  body: Effect.Effect<A, E, ActorCluster | Scope.Scope>,
) =>
  environment.run(
    Effect.gen(function* () {
      const database = yield* environment.freshDatabase

      const context = yield* Layer.build(
        ActorTest.cluster({
          database,
          runners: 3,
          shardLockExpiration: "3 seconds",
          actors: studioCommands,
          runnerActors: (runner) => (runner === 2 ? studioExecutors : Layer.empty),
          as: User.make({ subject: "alice" }),
          authorize: () => Effect.succeed(true),
        }),
      )

      return yield* body.pipe(Effect.scoped, Effect.provideContext(context))
    }),
  )

/** Waits until the pool sent `count` progress frames for actor `id`, then for them to reach the holder. */
const sentFor = (id: string, count: number) =>
  Effect.gen(function* () {
    const test = yield* ActorTest

    const sent = Effect.map(
      test.progress,
      (records) =>
        records.filter((record) => record.ref.id === id && ProgressRecord.$is("Progress")(record))
          .length,
    )

    yield* sent.pipe(
      Effect.repeat({ schedule: Schedule.spaced("20 millis"), until: (found) => found >= count }),
      Effect.timeout(WAIT),
      Effect.orDie,
    )
    yield* Effect.sleep("300 millis")
  })

/** Progress-delivery cases: frames stay in order, drop after cancellation, and coalesce per effect for a paused client. */
export const progressDeliveryConformance: ReadonlyArray<ConformanceCase<ProgressFixture>> = [
  {
    name: "keeps an effect's progress in order when its first frames on an activation arrive together",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const studio = yield* Studio.get("racing")
          const mine = yield* test.connect(studio.ref, Mine, undefined)
          const job = yield* plan("racing", [10])
          yield* studio.Render("racing")
          yield* test.advance(0).pipe(Effect.forkChild)
          yield* Deferred.succeed(job.go, undefined)
          expect(progressOf(yield* nextOf(mine))?.seq).toBe(1)

          const [sent] = (yield* test.progress).filter(
            (record) => record.ref.id === "racing" && ProgressRecord.$is("Progress")(record),
          )

          if (sent === undefined || !ProgressRecord.$is("Progress")(sent))
            return yield* Effect.die(new Error("No progress was sent"))

          yield* test.hibernate(studio.ref)
          yield* Effect.all(
            [test.resendProgress({ ...sent, seq: 5 }), test.resendProgress({ ...sent, seq: 3 })],
            { concurrency: "unbounded" },
          )
          yield* Effect.sleep("500 millis")

          const seqs = (yield* quietFor(mine, "1 second")).flatMap((message) => {
            const found = progressOf(message)

            return found === undefined ? [] : [found.seq]
          })

          expect(seqs.at(-1)).toBe(5)
          expect(seqs).toEqual(seqs.toSorted((a, b) => a - b))
          yield* Deferred.succeed(job.finish, undefined)
        }),
      ),
  },
  {
    name: "drops progress after the cancelling commit",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const studio = yield* Studio.get("cancelled")
          const mine = yield* test.connect(studio.ref, Mine, undefined)
          const job = yield* plan("cancelled", [10])
          yield* test.dropProgress(
            (message) => message.ref.id === "cancelled" && !("seq" in message),
          )
          yield* studio.RenderKeyed("cancelled")
          yield* test.advance(0).pipe(Effect.forkChild)
          yield* Deferred.succeed(job.go, undefined)
          expect(progressOf(yield* nextOf(mine))?.frame).toEqual({ percent: 10 })

          yield* studio.CancelRender("cancelled")
          expect(frameOf(yield* nextOf(mine))).toEqual(
            Rendered.make({ output: "cancelled-cancelled" }),
          )

          const [sent] = (yield* test.progress).filter(
            (record) => record.ref.id === "cancelled" && ProgressRecord.$is("Progress")(record),
          )

          if (sent === undefined || !ProgressRecord.$is("Progress")(sent))
            return yield* Effect.die(new Error("No progress was sent"))

          yield* test.resendProgress({ ...sent, seq: sent.seq + 1 })
          expect(yield* quietFor(mine, "1 second")).toEqual([])
          yield* test.hibernate(studio.ref)
          yield* test.resendProgress({ ...sent, seq: sent.seq + 2 })
          expect(yield* quietFor(mine, "1 second")).toEqual([])
          yield* test.dropProgress(() => false)
          yield* Deferred.succeed(job.finish, undefined)
        }),
      ),
  },
  {
    name: "coalesces a paused client's progress per effect at the holder, newest in place",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const studio = yield* Studio.get("coalesce")
          const busy = yield* test.connect(studio.ref, Busy, undefined)
          const job = yield* plan("coalesce", [10, 20, 30, 40])
          yield* studio.Render("coalesce")
          yield* test.advance(0).pipe(Effect.forkChild)
          yield* Deferred.succeed(job.go, undefined)
          yield* sentFor("coalesce", 4)

          expect(progressOf(yield* nextOf(busy))).toMatchObject({ seq: 4, frame: { percent: 40 } })
          yield* Deferred.succeed(job.finish, undefined)
          expect(frameOf(yield* nextOf(busy))).toEqual(Rendered.make({ output: "coalesce.png" }))
        }),
      ),
  },
  {
    name: "discards a paused client's buffered progress at the effect's route",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const studio = yield* Studio.get("ended")
          const busy = yield* test.connect(studio.ref, Busy, undefined)
          const job = yield* plan("ended", [10])
          yield* studio.Render("ended")
          yield* test.advance(0).pipe(Effect.forkChild)
          yield* Deferred.succeed(job.go, undefined)
          yield* sentFor("ended", 1)
          yield* Deferred.succeed(job.finish, undefined)

          yield* test.receiptsFor(studio.ref, "Finished").pipe(
            Effect.repeat({
              schedule: Schedule.spaced("20 millis"),
              until: (found) => found === 1,
            }),
            Effect.timeout(WAIT),
            Effect.orDie,
          )
          yield* Effect.sleep("300 millis")

          expect((yield* quietFor(busy, "1 second")).map(frameOf)).toEqual([
            Rendered.make({ output: "ended.png" }),
          ])
        }),
      ),
  },
  {
    name: "evicts progress before member frames overflow, and drops progress instead of ending a full session",
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const studio = yield* Studio.get("evict")
          const busy = yield* test.connect(studio.ref, Busy, undefined)

          const jobs = yield* Effect.forEach(["evict-a", "evict-b", "evict-c", "evict-d"], (job) =>
            plan(job, [1]),
          )

          yield* Effect.forEach(
            jobs.map((_, index) => `evict-${"abcd"[index]}`),
            studio.Render,
            {
              discard: true,
            },
          )
          yield* test.advance(0).pipe(Effect.forkChild)

          for (const job of jobs.slice(0, 3)) yield* Deferred.succeed(job.go, undefined)
          yield* sentFor("evict", 3)

          yield* busy.send(1022)
          yield* Effect.sleep("1500 millis")

          yield* Deferred.succeed(jobs[3]!.go, undefined)
          yield* sentFor("evict", 4)

          const drained = yield* quietFor(busy, "2 seconds")

          const progress = drained.flatMap((message) => {
            const found = progressOf(message)

            return found === undefined ? [] : [found.effectId]
          })

          expect(drained.length).toBe(1024)
          expect(progress.length).toBe(2)
          expect(drained.filter((message) => frameOf(message) !== undefined).length).toBe(1022)

          yield* busy.send(1)
          expect(frameOf(yield* nextOf(busy))).toEqual(Rendered.make({ output: "flood-0" }))

          for (const job of jobs) yield* Deferred.succeed(job.finish, undefined)
        }),
      ),
  },
  {
    name: "discards an older owner's buffered progress once a newer owner sends",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const studio = yield* Studio.get("moved")
          const busy = yield* test.connect(studio.ref, Busy, undefined)
          const job = yield* plan("moved", [10])
          yield* studio.Render("moved")
          yield* test.advance(0).pipe(Effect.forkChild)
          yield* Deferred.succeed(job.go, undefined)
          yield* sentFor("moved", 1)

          yield* test.hibernate(studio.ref)
          yield* studio.Announce("moved-on")

          expect((yield* quietFor(busy, "1 second")).map(frameOf)).toEqual([
            Rendered.make({ output: "moved-on" }),
          ])
          yield* Deferred.succeed(job.finish, undefined)
        }),
      ),
  },
  {
    name: "delivers performer progress only to the performer's connection, and to every connection with to: all",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const studio = yield* Studio.get("audience")
          const mine = yield* test.connect(studio.ref, Mine, undefined)
          const theirs = yield* test.connect(studio.ref, Mine, undefined).pipe(Actor.as(bob))
          const everyone = yield* test.connect(studio.ref, Everyone, undefined).pipe(Actor.as(bob))
          const quiet = yield* test.connect(studio.ref, Quiet, undefined)
          const job = yield* plan("audience", [10, 60])
          yield* studio.Render("audience")
          yield* test.advance(0).pipe(Effect.forkChild)
          yield* Deferred.succeed(job.go, undefined)

          const first = progressOf(yield* nextOf(mine))
          expect(first).toMatchObject({
            effect: "Render",
            attempt: 1,
            seq: 1,
            frame: { percent: 10 },
          })
          expect(progressOf(yield* nextOf(everyone))?.frame).toEqual({ percent: 10 })
          expect(progressOf(yield* nextOf(mine))).toMatchObject({ seq: 2, frame: { percent: 60 } })

          yield* Deferred.succeed(job.finish, undefined)
          const seen = yield* quietFor(theirs, "1500 millis")

          expect(seen.map(frameOf)).toEqual([Rendered.make({ output: "audience.png" })])
          expect(frameOf(yield* nextOf(quiet))).toEqual(Rendered.make({ output: "audience.png" }))
        }),
      ),
  },
  {
    name: "loses nothing durable when every progress message is dropped",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const studio = yield* Studio.get("dropped")
          const mine = yield* test.connect(studio.ref, Mine, undefined)
          const job = yield* plan("dropped", [10, 60])
          yield* test.dropProgress((message) => message.ref.id === "dropped")
          yield* studio.Render("dropped")
          yield* test.advance(0).pipe(Effect.forkChild)
          yield* Deferred.succeed(job.go, undefined)
          yield* Deferred.succeed(job.finish, undefined)

          const [arrived] = yield* mine.messages.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.timeout(WAIT),
            Effect.ensuring(test.dropProgress(() => false)),
          )

          expect(frameOf(arrived)).toEqual(Rendered.make({ output: "dropped.png" }))

          const settled = yield* test.inspect(studio.ref).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("20 millis"),
              until: (inspection) => inspection.outbox === 0 && inspection.jobs === 0,
            }),
            Effect.timeout(WAIT),
            Effect.orDie,
          )

          expect(settled).toMatchObject({ outbox: 0, jobs: 0 })
          expect(yield* test.receiptsFor(studio.ref, "Finished")).toBe(1)
          const sent = (yield* test.progress).filter((record) => record.ref.id === "dropped")
          expect(sent.some(ProgressRecord.$is("Progress"))).toBe(true)
        }),
      ),
  },
  {
    name: "drops progress that arrives after the effect's route commits, on the same activation and after a move",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const studio = yield* Studio.get("late")
          const mine = yield* test.connect(studio.ref, Mine, undefined)
          const job = yield* plan("late", [10])
          yield* test.dropProgress((message) => message.ref.id === "late" && !("seq" in message))
          yield* studio.Render("late")
          yield* test.advance(0).pipe(Effect.forkChild)
          yield* Deferred.succeed(job.go, undefined)
          expect(progressOf(yield* nextOf(mine))?.frame).toEqual({ percent: 10 })
          yield* Deferred.succeed(job.finish, undefined)
          expect(frameOf(yield* nextOf(mine))).toEqual(Rendered.make({ output: "late.png" }))

          const [sent] = (yield* test.progress).filter(
            (record) => record.ref.id === "late" && ProgressRecord.$is("Progress")(record),
          )

          if (sent === undefined || !ProgressRecord.$is("Progress")(sent))
            return yield* Effect.die(new Error("No progress was sent"))

          yield* test.resendProgress({ ...sent, seq: sent.seq + 1 })
          expect(yield* quietFor(mine, "1 second")).toEqual([])
          yield* test.hibernate(studio.ref)
          yield* test.resendProgress({ ...sent, seq: sent.seq + 2 })
          expect(yield* quietFor(mine, "1 second")).toEqual([])
          yield* test.dropProgress(() => false)
        }),
      ),
  },
  {
    name: "streams progress to an Actor.stream handler through read.progress, filtered by effect input",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const studio = yield* Studio.get("streamed")
          const one = yield* plan("streamed-one", [20, 40])
          const other = yield* plan("streamed-other", [99])

          const percents = yield* studio
            .Percent("streamed-one")
            .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild)

          yield* Effect.sleep("300 millis")
          yield* studio.Render("streamed-one")
          yield* studio.Render("streamed-other")
          yield* test.advance(0).pipe(Effect.forkChild)
          yield* Deferred.succeed(other.go, undefined)
          yield* Deferred.succeed(one.go, undefined)

          expect([...(yield* Fiber.join(percents).pipe(Effect.timeout(WAIT)))]).toEqual([20, 40])
          yield* Deferred.succeed(one.finish, undefined)
          yield* Deferred.succeed(other.finish, undefined)
        }),
      ),
  },
  {
    name: "delivers progress from an executor on runner C to a connection parked at holder A for an actor owned by runner B",
    requiresFreshDatabase: true,
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment }) =>
      withStudioCluster(
        environment,
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          yield* cluster.ready
          let ref: ActorRef | undefined

          for (let index = 0; ref === undefined && index < 200; index++) {
            const candidate = (yield* cluster.on(0)(Studio.get(`parked-${index}`))).ref

            if ((yield* cluster.owner(candidate)) === 1) ref = candidate
          }

          if (ref === undefined)
            return yield* Effect.die(new Error("Runner 1 owns no probed actor"))
          const target = ref

          const mine = yield* cluster.on(0)(
            ActorTest.use((test) => test.connect(target, Mine, undefined)),
          )

          const job = yield* plan(target.id, [30])
          yield* cluster.on(0)(
            Studio.get(target.id).pipe(Effect.flatMap((s) => s.Render(target.id))),
          )

          yield* cluster.on(1)(ActorTest.use((test) => test.hibernate(target)))

          const before = (yield* cluster.on(0)(ActorTest.use((test) => test.inspect(target))))
            .generation

          yield* Deferred.succeed(job.go, undefined)

          const first = yield* nextOf(mine)

          expect(progressOf(first)).toMatchObject({ effect: "Render", frame: { percent: 30 } })

          const after = (yield* cluster.on(0)(ActorTest.use((test) => test.inspect(target))))
            .generation

          expect(BigInt(after!) > BigInt(before!)).toBe(true)
          yield* Deferred.succeed(job.finish, undefined)
        }),
      ),
  },
]

/** Progress actors, executors and the studio. */
export const progressSuite: ConformanceSuite<ProgressFixture> = {
  fixture: progressFixture,
  layer: (fixture) => Layer.merge(progressLayer(fixture), studioLayer),
}
