import { Effect, Exit, Layer, Schema } from "effect"
import { Actor } from "../../index.ts"
import type { ExecutorContext } from "../../contexts/effect.ts"
import { ActorTest, ProgressRecord } from "../actor-test.ts"
import type { ConformanceCase } from "../conformance.ts"

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
})

class Transcode extends Actor.effect<Transcode>()("Transcode", {
  input: { assetId: Schema.String },
  success: Schema.String,
  progress: Stage,
}) {}

class Import extends Actor.effect<Import>()("Import", {
  input: { rows: Schema.Int },
  progress: Schema.Struct({ done: Schema.Int }),
}) {}

// Declares no progress schema, so its executor has nothing to report.
class Thumbnail extends Actor.effect<Thumbnail>()("Thumbnail", {
  input: { assetId: Schema.String },
}) {}

const Start = Actor.command("Start", { input: Schema.String })

const Thumb = Actor.command("Thumb", { input: Schema.String })

const Transcoded = Actor.command("Transcoded", { input: Schema.String })

const Encoder = Actor.make("Encoder", {
  key: Schema.String,
  state: Actor.state({
    outputs: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
  effects: [Transcode, Import, Thumbnail],
  api: { Start, Thumb },
  internal: { Transcoded },
  policy: {
    effects: {
      Transcode: { retry: { times: 1 }, onSuccess: Transcoded, progressEvery: "1 minute" },
      Thumbnail: { retry: { times: 0 } },
    },
  },
})

const EncoderState = Schema.Struct({ outputs: Schema.optional(Schema.Array(Schema.String)) })

export const progressLayer = (fixture: ProgressFixture) =>
  Layer.mergeAll(
    Encoder.toLayer(
      Effect.succeed({
        Start: Effect.fnUntraced(function* (assetId: string) {
          yield* (yield* Encoder.Turn).perform(Transcode.make({ assetId }))
        }),
        Thumb: Effect.fnUntraced(function* (assetId: string) {
          yield* (yield* Encoder.Turn).perform(Thumbnail.make({ assetId }))
        }),
        Transcoded: Effect.fnUntraced(function* (output: string) {
          const turn = yield* Encoder.Turn
          yield* turn.state.set({ outputs: [...turn.state.outputs, output] })
        }),
      }),
    ),
    Encoder.toEffectLayer(
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

export const progressConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "sends an executor's latest progress frame before the effect settles, then closes it",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const encoder = yield* Encoder.get("latest")
          fixture.progress.frames = [probe, encode, upload]
          yield* encoder.Start("a")
          yield* test.advance(0)
          const records = yield* recordsOf("latest")
          const frames = framesOf(records)
          const effectId = fixture.progress.captured?.effectId

          // Within one progressEvery window at most the first frame goes out
          // immediately; the latest replaces the rest and is flushed at the end.
          expect([1, 2]).toContain(frames.length)
          expect(frames.at(-1)).toEqual({ attempt: 1, seq: 3, frame: upload })
          expect(frames.map((frame) => frame.seq)).toEqual(
            frames.map((frame) => frame.seq).toSorted((a, b) => a - b),
          )
          expect(records.every((record) => record.effectId === effectId)).toBe(true)
          expect(records.at(-1) && ProgressRecord.$is("ProgressClosed")(records.at(-1)!)).toBe(true)
          expect(records.at(-1)).toMatchObject({ attempt: 1 })
          expect(yield* outputsOf("latest")).toEqual(["a.mp4"])
          expect(yield* test.inspect(encoder.ref)).toMatchObject({ outbox: 0, effects: 0 })
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
          const exec = () => fixture.progress.captured!
          fixture.progress.frames = [
            { percent: "half", stage: "encode" },
            { percent: 1, stage: "x".repeat(5000) },
            { percent: 1, stage: "mux" },
          ]
          fixture.progress.progressFailed = false
          yield* encoder.Start("b")
          yield* test.advance(0)
          yield* exec().progress(Import as never, { done: 1 } as never)

          expect(fixture.progress.progressFailed).toBe(false)
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
          fixture.progress.frames = [probe]
          yield* encoder.Start("c")
          yield* test.advance(0)
          const before = (yield* recordsOf("captured")).length
          yield* fixture.progress.captured!.progress(Transcode, upload)
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
          fixture.progress.frames = [encode]
          fixture.progress.plan = ["fail"]
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
          fixture.progress.frames = [probe]
          fixture.progress.plan = ["fail", "fail"]
          yield* encoder.Start("e")
          yield* test.advance(0)
          yield* test.advance("1 minute")
          const records = yield* recordsOf("dead")

          expect(framesOf(records).map((frame) => frame.attempt)).toEqual([1, 2])
          expect(closedOf(records)).toMatchObject([{ attempt: 2 }])
          expect(yield* outputsOf("dead")).toEqual([])
          expect(yield* test.inspect(encoder.ref)).toMatchObject({ outbox: 0, effects: 0 })
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
          fixture.progress.frames = [probe, encode, upload]
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
          yield* fixture.progress.captured!.progress(Transcode, probe)

          expect(framesOf(yield* recordsOf("plain"))).toEqual([])
        }),
      ),
  },
]
