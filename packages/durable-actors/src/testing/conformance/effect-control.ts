import type { Mutable } from "effect/Types"
import {
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schedule,
  Schema,
} from "effect"
import { SqlClient, type SqlError } from "effect/unstable/sql"
import { Actor, Intent, User } from "../../index.ts"
import type { Cancelled } from "../../members/effect.ts"
import type { PerformOptions } from "../../contexts/effect.ts"
import type { Request } from "../../handles/actors.ts"
import type { ActorRef } from "../../identity/caller.ts"
import type { layer as runtimeLayer } from "../../runtime/layer.ts"
import { TurnHooks } from "../../runtime/turn/hooks.ts"
import { wakeWaiting } from "../../runtime/turn/relay.ts"
import { ActorTest } from "../actor-test.ts"
import { ActorCluster, type RunnerServices } from "../cluster.ts"
import type { ConformanceCase, ConformanceEnvironment } from "../conformance.ts"

/** One executor attempt as the fake provider saw it; times are this process's clock. */
interface ControlAttempt {
  readonly label: string
  readonly actor: string
  readonly effect: string
  readonly effectId: string
  readonly attempt: number
  readonly runner: number
  readonly startedAt: number
  endedAt: number | undefined
  interrupted: boolean
}

/** Shared by the effect-control actors and cases; each case resets it first. */
export interface EffectControlFixture {
  readonly attempts: Array<ControlAttempt>
  /** What the provider does on one attempt; the default succeeds with the label. */
  provider: (attempt: ControlAttempt) => Effect.Effect<string, ControlDown>
  /** Behaviour at a fault point on every cluster runner. */
  hook: (point: string, request: Request) => Effect.Effect<void>
}

export const effectControlFixture = (): EffectControlFixture => ({
  attempts: [],
  provider: (attempt) => Effect.succeed(attempt.label),
  hook: () => Effect.void,
})

const reset = (fixture: EffectControlFixture) =>
  Effect.sync(() => {
    fixture.attempts.length = 0
    fixture.provider = (attempt) => Effect.succeed(attempt.label)
    fixture.hook = () => Effect.void
  })

class ControlDown extends Schema.TaggedError<ControlDown>()("ControlDown", {}) {}

class Job extends Actor.effect<Job>()("Job", {
  input: { label: Schema.String },
  success: Schema.String,
}) {}

class Capped extends Actor.effect<Capped>()("Capped", {
  input: { label: Schema.String },
  success: Schema.String,
}) {}

class Serial extends Actor.effect<Serial>()("Serial", {
  input: { label: Schema.String },
  success: Schema.String,
}) {}

class Picky extends Actor.effect<Picky>()("Picky", {
  input: { label: Schema.String },
  success: Schema.String,
}) {}

const EffectName = Schema.Literals(["Job", "Capped", "Serial", "Picky"])

type EffectName = typeof EffectName.Type

const Perform = Actor.command("Perform", {
  input: Schema.Struct({
    effect: EffectName,
    labels: Schema.Array(Schema.String),
    keyed: Schema.optional(Schema.Boolean),
    afterMs: Schema.optional(Schema.Int),
  }),
})

const CancelEffect = Actor.command("CancelEffect", { input: Schema.Array(Schema.String) })

const PerformThenCancel = Actor.command("PerformThenCancel", { input: Schema.String })

const CancelThenRefuse = Actor.command("CancelThenRefuse", {
  input: Schema.String,
  errors: [ControlDown],
})

const CancelThenDie = Actor.command("CancelThenDie", { input: Schema.String })

const CaptureCancel = Actor.command("CaptureCancel", {})

const UseCaptured = Actor.command("UseCaptured", { input: Schema.String })

const Done = Actor.command("Done", { input: Schema.String })

const JobCancelled = Actor.command("JobCancelled", { input: Actor.Cancelled(Job) })

const CappedCancelled = Actor.command("CappedCancelled", { input: Actor.Cancelled(Capped) })

const SerialFailed = Actor.command("SerialFailed", { input: Actor.DeadLetter(Serial) })

const PickyDone = Actor.command("PickyDone", {
  input: Schema.String.check(Schema.isPattern(/^accepted$/)),
})

const PickyCancelled = Actor.command("PickyCancelled", { input: Actor.Cancelled(Picky) })

const Report = Schema.Struct({
  label: Schema.String,
  effectId: Schema.String,
  outcome: Schema.String,
  ambiguous: Schema.Boolean,
  value: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.String),
})

const Controlled = Actor.make("Controlled", {
  key: Schema.String,
  state: Actor.state({
    done: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    cancelled: Schema.Array(Report).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    letters: Schema.Array(Report).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
  effects: [Job, Capped, Serial, Picky],
  api: {
    Perform,
    CancelEffect,
    PerformThenCancel,
    CancelThenRefuse,
    CancelThenDie,
    CaptureCancel,
    UseCaptured,
  },
  internal: { Done, JobCancelled, CappedCancelled, SerialFailed, PickyDone, PickyCancelled },
  policy: {
    effects: {
      Job: {
        retry: { times: 2, backoff: { base: "1 second", max: "1 second" } },
        onSuccess: Done,
        onCancelled: JobCancelled,
      },
      Capped: {
        retry: { times: 1, backoff: { base: "1 second", max: "1 second" } },
        concurrency: { perActor: 2 },
        onSuccess: Done,
        onCancelled: CappedCancelled,
      },
      Serial: {
        retry: { times: 1, backoff: { base: "1 second", max: "1 second" } },
        concurrency: { perActor: 1 },
        onSuccess: Done,
        onDeadLetter: SerialFailed,
      },
      Picky: {
        retry: { times: 0 },
        onSuccess: PickyDone,
        onCancelled: PickyCancelled,
      },
    },
  },
})

const reportCancelled = (cancelled: Cancelled<typeof Job>) =>
  Effect.gen(function* () {
    const turn = yield* Controlled.Turn
    const { outcome } = cancelled

    yield* turn.state.set({
      cancelled: [
        ...turn.state.cancelled,
        {
          label: cancelled.effect.label,
          effectId: cancelled.effectId,
          outcome: outcome._tag,
          ambiguous: cancelled.ambiguous,
          ...("value" in outcome ? { value: String(outcome.value) } : { cause: outcome.cause }),
        },
      ],
    })
  })

let captured: ((key: string) => Effect.Effect<void>) | undefined

/** The effect-control actors' command layers, which every runner builds. */
export const effectControlLayer = Controlled.toLayer(
  Effect.succeed({
    Perform: Effect.fnUntraced(function* ({ effect, labels, keyed, afterMs }) {
      const turn = yield* Controlled.Turn

      for (const label of labels) {
        const instance = { Job, Capped, Serial, Picky }[effect].make({ label })

        const options: Mutable<PerformOptions> = {}

        if (keyed === true) options.key = label

        if (afterMs !== undefined) options.after = Duration.millis(afterMs)
        yield* turn.perform(instance, options)
      }
    }),
    CancelEffect: Effect.fnUntraced(function* (keys) {
      const turn = yield* Controlled.Turn

      for (const key of keys) yield* turn.cancelEffect(key)
    }),
    PerformThenCancel: Effect.fnUntraced(function* (label) {
      const turn = yield* Controlled.Turn
      yield* turn.perform(Job.make({ label }), { key: label })
      yield* turn.cancelEffect(label)
    }),
    CancelThenRefuse: Effect.fnUntraced(function* (key) {
      yield* (yield* Controlled.Turn).cancelEffect(key)

      return yield* ControlDown.make({})
    }),
    CancelThenDie: Effect.fnUntraced(function* (key) {
      yield* (yield* Controlled.Turn).cancelEffect(key)

      return yield* Effect.die(new Error("Canceller defect"))
    }),
    CaptureCancel: Effect.fnUntraced(function* () {
      captured = (yield* Controlled.Turn).cancelEffect
    }),
    UseCaptured: Effect.fnUntraced(function* (key) {
      if (captured !== undefined) yield* captured(key)
    }),
    Done: Effect.fnUntraced(function* (value) {
      const turn = yield* Controlled.Turn
      yield* turn.state.set({ done: [...turn.state.done, value] })
    }),
    JobCancelled: reportCancelled,
    CappedCancelled: (cancelled) => reportCancelled(cancelled as never),
    PickyDone: Effect.fnUntraced(function* (value) {
      const turn = yield* Controlled.Turn
      yield* turn.state.set({ done: [...turn.state.done, value] })
    }),
    PickyCancelled: (cancelled) => reportCancelled(cancelled as never),
    SerialFailed: Effect.fnUntraced(function* (letter) {
      const turn = yield* Controlled.Turn

      yield* turn.state.set({
        letters: [
          ...turn.state.letters,
          {
            label: letter.effect.label,
            effectId: letter.effectId,
            outcome: "DeadLetter",
            ambiguous: letter.ambiguous,
            cause: letter.cause,
          },
        ],
      })
    }),
  }),
)

/** The executors of `runner`. */
const runnerEffects = (fixture: EffectControlFixture, runner: number) => {
  const execute = (effect: EffectName, label: string) =>
    Effect.gen(function* () {
      const exec = yield* Controlled.Executor

      const attempt: ControlAttempt = {
        label,
        actor: exec.ref.id,
        effect,
        effectId: exec.effectId,
        attempt: exec.attempt,
        runner,
        startedAt: yield* Clock.currentTimeMillis,
        endedAt: undefined,
        interrupted: false,
      }

      fixture.attempts.push(attempt)

      return yield* Effect.suspend(() => fixture.provider(attempt)).pipe(
        Effect.onExit((exit) =>
          Effect.map(Clock.currentTimeMillis, (now) => {
            attempt.endedAt = now
            attempt.interrupted = Exit.hasInterrupts(exit)
          }),
        ),
      )
    })

  return Controlled.toEffectLayer(
    Effect.succeed({
      Job: ({ label }) => execute("Job", label),
      Capped: ({ label }) => execute("Capped", label),
      Serial: ({ label }) => execute("Serial", label),
      Picky: ({ label }) => execute("Picky", label),
    }),
  )
}

/** The executors of the conformance environment's single runtime. */
export const effectControlEffects = (fixture: EffectControlFixture) => runnerEffects(fixture, 0)

type RuntimeOptions = Parameters<typeof runtimeLayer>[0]

/** A poll far longer than any case, so only wakes after commit and `advance` claim rows. */
const NO_POLL = { poll: "1 hour" } as const

const SHORT_LEASE = { lease: "3 seconds" } as const

/** Builds a fresh database and `runners` runners on it for one case. */
const withCluster = <A, E>(
  environment: ConformanceEnvironment,
  fixture: EffectControlFixture,
  runners: number,
  settings: {
    readonly relay?: RuntimeOptions["relay"]
    readonly executors?: RuntimeOptions["executors"]
  },
  body: Effect.Effect<A, E, ActorCluster>,
) =>
  environment.run(
    Effect.gen(function* () {
      yield* reset(fixture)
      const database = yield* environment.freshDatabase

      const context = yield* Layer.build(
        ActorTest.cluster({
          database,
          runners,
          shardLockExpiration: "3 seconds",
          actors: effectControlLayer,
          runnerActors: (runner) =>
            runnerEffects(fixture, runner) as Layer.Layer<never, never, RunnerServices>,
          as: User.make({ subject: "alice" }),
          relay: settings.relay,
          executors: settings.executors,
        }),
      ).pipe(
        Effect.provideService(TurnHooks, {
          at: (point, request) => Effect.suspend(() => fixture.hook(point, request)),
        }),
      )

      return yield* body.pipe(Effect.provideContext(context))
    }),
  )

const on = <A, E, R>(runner: number, effect: Effect.Effect<A, E, R>) =>
  ActorCluster.use((cluster) => cluster.on(runner)(effect))

const perform = (
  id: string,
  effect: EffectName,
  labels: ReadonlyArray<string>,
  options: { readonly keyed?: boolean; readonly afterMs?: number } = {},
) =>
  Controlled.get(id).pipe(
    Effect.flatMap((actor) => actor.Perform({ effect, labels, ...options })),
    Effect.orDie,
  )

const cancel = (id: string, keys: ReadonlyArray<string>) =>
  Controlled.get(id).pipe(
    Effect.flatMap((actor) => actor.CancelEffect(keys)),
    Effect.orDie,
  )

const stateOf = (id: string) =>
  Effect.gen(function* () {
    const actor = yield* Controlled.get(id)
    const { state } = yield* (yield* ActorTest).inspect(actor.ref)

    return state as {
      readonly done?: ReadonlyArray<string>
      readonly cancelled?: ReadonlyArray<typeof Report.Type>
      readonly letters?: ReadonlyArray<typeof Report.Type>
    }
  })

interface EffectRow {
  readonly command: string
  readonly kind: string
  readonly attempts: number
  readonly running: boolean
  readonly cancelled: boolean
  readonly waiting: boolean
  readonly timer_key: string | null
}

const effectRows = (sql: SqlClient.SqlClient) =>
  sql<EffectRow>`SELECT command, kind, attempts, running, cancelled_at_ms IS NOT NULL AS cancelled,
      waiting, timer_key
    FROM actor_outbox WHERE actor_type = 'Controlled' ORDER BY ready_at_ms, intent_id`

const deadLetters = (sql: SqlClient.SqlClient) =>
  sql<{ attempts: number; ambiguous: boolean; cause: string }>`SELECT attempts, ambiguous, cause
    FROM actor_dead_letters WHERE actor_type = 'Controlled'`

/** Runs a query on `runner`'s database pool. */
const query = <A>(
  runner: number,
  statement: (sql: SqlClient.SqlClient) => Effect.Effect<A, SqlError.SqlError>,
) =>
  on(
    runner,
    Effect.gen(function* () {
      return yield* statement(yield* SqlClient.SqlClient)
    }),
  ).pipe(Effect.orDie)

/** Polls `check` until it holds, dying after `timeout`. */
const eventually = <E, R>(
  check: Effect.Effect<boolean, E, R>,
  timeout: Duration.Input = "20 seconds",
  what = "a condition",
) =>
  check.pipe(
    Effect.repeat({ schedule: Schedule.spaced("25 millis"), until: (held) => held }),
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.die(new Error(`Timed out waiting for ${what}`)),
    }),
    Effect.asVoid,
  )

const advance = (runner: number, duration: Duration.Input) =>
  on(
    runner,
    ActorTest.use((test) => test.advance(duration)),
  )

/** The runner that owns `ref`'s shard, and another one. */
const ownerAndOther = (ref: ActorRef) =>
  Effect.gen(function* () {
    const cluster = yield* ActorCluster
    const owner = (yield* cluster.owner(ref))!

    return { owner, other: (owner + 1) % cluster.runners }
  })

const refOf = (id: string) => on(0, Controlled.get(id).pipe(Effect.map((actor) => actor.ref)))

/** The most attempts of one actor's `effect` whose runs overlapped in time. */
const maxInFlight = (attempts: ReadonlyArray<ControlAttempt>, actor: string, effect: string) => {
  const mine = attempts.filter((attempt) => attempt.actor === actor && attempt.effect === effect)

  return Math.max(
    0,
    ...mine.map(
      (attempt) =>
        1 +
        mine.filter(
          (other) =>
            other !== attempt &&
            other.startedAt <= attempt.startedAt &&
            (other.endedAt ?? Number.POSITIVE_INFINITY) > attempt.startedAt,
        ).length,
    ),
  )
}

const thrown = (build: () => void) => {
  try {
    build()

    return ""
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** Single-runtime cases, on every backend. */
export const effectControlConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "never runs a pending keyed effect cancelled by a later turn or in its own turn",
    run: ({ expect, environment, fixture: { effectControl: fixture } }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          yield* perform("pending", "Job", ["later"], { keyed: true, afterMs: 60_000 })
          expect(yield* effectRows(sql)).toMatchObject([
            { command: "Job", timer_key: "$effect:later", attempts: 0 },
          ])
          yield* cancel("pending", ["later", "never-performed"])
          const actor = yield* Controlled.get("pending")
          yield* actor.PerformThenCancel("same-turn").pipe(Effect.orDie)
          yield* test.advance("2 minutes")

          expect(fixture.attempts).toEqual([])
          expect(yield* effectRows(sql)).toEqual([])
          const pending = yield* stateOf("pending")
          expect([...(pending.done ?? []), ...(pending.cancelled ?? [])]).toEqual([])
        }),
      ),
  },
  {
    name: "replaces a pending keyed effect performed again under its key",
    run: ({ expect, environment, fixture: { effectControl: fixture } }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)
          const test = yield* ActorTest
          fixture.provider = (attempt) => Effect.succeed(`${attempt.label}@${attempt.attempt}`)
          const actor = yield* Controlled.get("replaced")
          yield* actor
            .Perform({ effect: "Job", labels: ["k"], keyed: true, afterMs: 60_000 })
            .pipe(Effect.orDie)
          yield* actor
            .Perform({ effect: "Job", labels: ["k"], keyed: true, afterMs: 30_000 })
            .pipe(Effect.orDie)
          yield* test.advance("2 minutes")

          expect(fixture.attempts.map(({ label }) => label)).toEqual(["k"])
          expect((yield* stateOf("replaced")).done).toEqual(["k@1"])
        }),
      ),
  },
  {
    name: "reports Failed when cancelled while backing off after a typed failure, and never retries",
    run: ({ expect, environment, fixture: { effectControl: fixture } }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          fixture.provider = () => Effect.fail(ControlDown.make({}))
          yield* perform("typed", "Job", ["typed"], { keyed: true })
          yield* eventually(Effect.sync(() => fixture.attempts[0]?.endedAt !== undefined))
          yield* eventually(
            effectRows(sql).pipe(Effect.map((rows) => rows[0]?.running === false)),
            "5 seconds",
            "the failure's backoff",
          )
          yield* cancel("typed", ["typed"])
          yield* test.advance("5 seconds")

          expect(fixture.attempts.length).toBe(1)
          expect((yield* stateOf("typed")).cancelled).toMatchObject([
            { label: "typed", outcome: "Failed", ambiguous: false },
          ])
          expect(yield* effectRows(sql)).toEqual([])
        }),
      ),
  },
  {
    name: "reports Unknown when cancelled while backing off after an attempt that may have applied",
    run: ({ expect, environment, fixture: { effectControl: fixture } }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          fixture.provider = () => Effect.die(new Error("provider connection reset"))
          yield* perform("maybe", "Job", ["maybe"], { keyed: true })
          yield* eventually(
            effectRows(sql).pipe(
              Effect.map((rows) => rows[0]?.attempts === 1 && rows[0].running === false),
            ),
            "5 seconds",
            "the defect's backoff",
          )
          yield* cancel("maybe", ["maybe"])
          yield* test.advance("5 seconds")

          expect(fixture.attempts.length).toBe(1)
          expect((yield* stateOf("maybe")).cancelled).toMatchObject([
            { label: "maybe", outcome: "Unknown", ambiguous: true },
          ])
        }),
      ),
  },
  {
    name: "interrupts a running attempt its own runner cancels and reports Unknown, never Failed",
    run: ({ expect, environment, fixture: { effectControl: fixture } }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          fixture.provider = () => Effect.never
          yield* perform("running", "Job", ["running"], { keyed: true })
          yield* eventually(Effect.sync(() => fixture.attempts.length === 1))
          const cancelledAt = yield* Clock.currentTimeMillis
          yield* cancel("running", ["running"])
          yield* eventually(
            Effect.sync(() => fixture.attempts[0]?.interrupted === true),
            "5 seconds",
            "the interruption",
          )

          // The local commit reached the attempt without waiting for a renewal.
          expect(fixture.attempts[0]!.endedAt! - cancelledAt < 5000).toBe(true)
          yield* eventually(
            stateOf("running").pipe(Effect.map((state) => (state.cancelled ?? []).length === 1)),
            "5 seconds",
            "the cancellation report",
          )
          yield* test.advance("5 minutes")
          expect(fixture.attempts.length).toBe(1)
          expect((yield* stateOf("running")).cancelled).toMatchObject([
            { label: "running", outcome: "Unknown", ambiguous: true },
          ])
          expect(yield* effectRows(sql)).toEqual([])
        }),
      ),
  },
  {
    name: "interrupts at once an attempt its own runner cancels between its claim and its call",
    run: ({ expect, environment, fixture: { effectControl: fixture } }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          fixture.provider = () => Effect.never
          const paused = yield* test.pauseNext("beforeExecute")
          yield* perform("claimed", "Job", ["claimed"], { keyed: true })
          yield* paused.reached
          const cancelledAt = yield* Clock.currentTimeMillis
          yield* cancel("claimed", ["claimed"])
          yield* paused.release
          yield* eventually(
            Effect.sync(() => fixture.attempts[0]?.interrupted === true),
            "5 seconds",
            "the interruption",
          )

          // The commit's local signal came before the renewal loop started.
          expect(fixture.attempts[0]!.endedAt! - cancelledAt < 5000).toBe(true)
          yield* eventually(
            stateOf("claimed").pipe(Effect.map((state) => (state.cancelled ?? []).length === 1)),
            "5 seconds",
            "the cancellation report",
          )
          expect(fixture.attempts.length).toBe(1)
          expect((yield* stateOf("claimed")).cancelled).toMatchObject([
            { label: "claimed", outcome: "Unknown", ambiguous: true },
          ])
          expect(yield* effectRows(sql)).toEqual([])
        }),
      ),
  },
  {
    name: "dead-letters an ambiguous cancellation as ambiguous and drops a failed one without onCancelled",
    run: ({ expect, environment, fixture: { effectControl: fixture } }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          fixture.provider = (attempt) =>
            attempt.label === "hung" ? Effect.never : Effect.fail(ControlDown.make({}))
          yield* perform("unrouted", "Serial", ["hung"], { keyed: true })
          yield* eventually(Effect.sync(() => fixture.attempts.length === 1))
          yield* cancel("unrouted", ["hung"])
          yield* eventually(
            stateOf("unrouted").pipe(Effect.map((state) => (state.letters ?? []).length === 1)),
            "5 seconds",
            "the dead letter",
          )
          expect(yield* deadLetters(sql)).toMatchObject([{ attempts: 1, ambiguous: true }])

          yield* perform("unrouted", "Serial", ["refused"], { keyed: true })
          yield* eventually(
            effectRows(sql).pipe(
              Effect.map((rows) => rows[0]?.attempts === 1 && rows[0].running === false),
            ),
            "5 seconds",
            "the typed failure's backoff",
          )
          yield* cancel("unrouted", ["refused"])
          yield* test.advance("5 seconds")

          expect(fixture.attempts.map(({ label }) => label)).toEqual(["hung", "refused"])
          expect((yield* stateOf("unrouted")).letters?.length).toBe(1)
          expect((yield* deadLetters(sql)).length).toBe(1)
          expect(yield* effectRows(sql)).toEqual([])
        }),
      ),
  },
  {
    name: "runs one capped attempt at a time per actor, in perform order, without holding other actors back",
    run: ({ expect, environment, fixture: { effectControl: fixture } }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)
          fixture.provider = (attempt) => Effect.sleep("20 millis").pipe(Effect.as(attempt.label))
          const labels = Array.from({ length: 6 }, (_, index) => `hot-${index}`)

          // One turn's performs share its clock millisecond, so only a
          // tie-break in perform order keeps them in order; the rest arrive
          // one turn at a time while those wait.
          yield* perform("hot", "Serial", labels.slice(0, 3))

          for (const label of labels.slice(3)) yield* perform("hot", "Serial", [label])

          yield* perform("cold", "Serial", ["cold-0"])
          yield* eventually(
            stateOf("hot").pipe(Effect.map((state) => (state.done ?? []).length === 6)),
            "20 seconds",
            "the hot actor's effects",
          )
          yield* eventually(
            stateOf("cold").pipe(Effect.map((state) => (state.done ?? []).length === 1)),
          )

          expect(maxInFlight(fixture.attempts, "hot", "Serial")).toBe(1)
          expect(
            fixture.attempts.filter(({ actor }) => actor === "hot").map(({ label }) => label),
          ).toEqual(labels)
          const cold = fixture.attempts.find(({ actor }) => actor === "cold")!
          const lastHot = fixture.attempts.filter(({ actor }) => actor === "hot").at(-1)!
          expect(cold.startedAt <= lastHot.startedAt).toBe(true)
        }),
      ),
  },
  {
    name: "rejects effect keys, intent keys in the effect namespace, and caps out of range",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const actor = yield* Controlled.get("keys")

          const failure = yield* actor
            .Perform({ effect: "Job", labels: ["x".repeat(201)], keyed: true })
            .pipe(Effect.exit)

          expect(Exit.isFailure(failure)).toBe(true)

          for (const perActor of [0, 65, 1.5])
            expect(
              thrown(() =>
                Actor.make("BadCap", {
                  effects: [Job],
                  api: { Done },
                  policy: { effects: { Job: { concurrency: { perActor } } } },
                }),
              ),
            ).toContain("perActor")
        }),
      ),
  },
  {
    name: "cancels nothing when the cancelling turn rolls back",
    run: ({ expect, environment, fixture: { effectControl: fixture } }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)
          const test = yield* ActorTest
          const actor = yield* Controlled.get("rollback")
          yield* perform("rollback", "Job", ["kept"], { keyed: true, afterMs: 60_000 })

          expect(yield* actor.CancelThenRefuse("kept").pipe(Effect.flip)).toBeInstanceOf(
            ControlDown,
          )
          const died = yield* actor.CancelThenDie("kept").pipe(Effect.exit)
          expect(Exit.isFailure(died) && Cause.pretty(died.cause)).toContain("Canceller defect")
          // A crash before commit rolls the cancellation back; the handle's retry commits it once.
          yield* perform("rollback", "Job", ["retried"], { keyed: true, afterMs: 60_000 })
          yield* test.crashNext("beforeCommit")
          yield* actor.CancelEffect(["retried"]).pipe(Effect.orDie)
          yield* test.advance("2 minutes")

          expect(fixture.attempts.map(({ label }) => label)).toEqual(["kept"])
          const state = yield* stateOf("rollback")
          expect(state.done).toEqual(["kept"])
          expect(state.cancelled ?? []).toEqual([])
        }),
      ),
  },
  {
    name: "does nothing when cancelling an effect that already completed",
    run: ({ expect, environment, fixture: { effectControl: fixture } }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          yield* perform("completed", "Job", ["done"], { keyed: true })
          yield* eventually(
            stateOf("completed").pipe(Effect.map((state) => (state.done ?? []).length === 1)),
          )
          yield* cancel("completed", ["done"])
          yield* test.advance("1 minute")

          expect(fixture.attempts.length).toBe(1)
          const state = yield* stateOf("completed")
          expect(state.done).toEqual(["done"])
          expect(state.cancelled ?? []).toEqual([])
          expect(yield* effectRows(sql)).toEqual([])
          // The key is free again.
          yield* perform("completed", "Job", ["done"], { keyed: true })
          yield* eventually(
            stateOf("completed").pipe(Effect.map((state) => (state.done ?? []).length === 2)),
          )
        }),
      ),
  },
  {
    name: "replaces a running keyed effect: reports the old one and runs the new one under a new id",
    run: ({ expect, environment, fixture: { effectControl: fixture } }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)
          fixture.provider = (attempt) =>
            fixture.attempts.indexOf(attempt) === 0 ? Effect.never : Effect.succeed("second")
          yield* perform("rerun", "Job", ["k"], { keyed: true })
          yield* eventually(Effect.sync(() => fixture.attempts.length === 1))
          yield* perform("rerun", "Job", ["k"], { keyed: true })
          yield* eventually(
            stateOf("rerun").pipe(
              Effect.map(
                (state) => (state.done ?? []).length === 1 && (state.cancelled ?? []).length === 1,
              ),
            ),
          )
          const [first, second] = fixture.attempts

          expect(first!.interrupted).toBe(true)
          expect(second!.effectId === first!.effectId).toBe(false)
          const state = yield* stateOf("rerun")
          expect(state.done).toEqual(["second"])
          expect(state.cancelled).toMatchObject([
            { effectId: first!.effectId, outcome: "Unknown", ambiguous: true },
          ])
        }),
      ),
  },
  {
    name: "rejects reserved intent keys and a captured cancelEffect",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          expect(thrown(() => Intent.key("$effect:x"))).toContain(
            'Intent key "$effect:x" is reserved for effects',
          )

          const inTurn = yield* Intent.cancel("$effect:x").pipe(
            Effect.provideService(Actor.InTurn, Actor.InTurn.of({ turn: Symbol() })),
            Effect.exit,
          )

          expect(Exit.isFailure(inTurn) && Cause.pretty(inTurn.cause)).toContain(
            "is reserved for effects",
          )
          const actor = yield* Controlled.get("escape")
          yield* actor.CaptureCancel().pipe(Effect.orDie)
          const stolen = yield* actor.UseCaptured("k").pipe(Effect.exit)
          expect(Exit.isFailure(stolen) && Cause.pretty(stolen.cause)).toContain(
            "Effect capability escaped its turn",
          )
        }),
      ),
  },
]

/** Multi-runner cases: real Postgres only, each on a fresh database and cluster. */
export const effectControlClusterConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "never shortens the lease of a waiting row a claim takes while a settle wakes it",
    requiresIndependentConnections: true,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient

          const group = {
            routing_key: "7",
            tenant_id: "wake-race",
            actor_type: "Controlled",
            actor_id: "raced",
            command: "Serial",
          }

          const now = yield* Clock.currentTimeMillis
          const leaseEnd = now + 60_000

          yield* sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id)
            VALUES (7, 'wake-race', 'Controlled', 'raced')`

          // Two rows wait at the cap; the older one is the one a claim takes.
          yield* sql`INSERT INTO actor_outbox ${sql.insert(
            ["oldest", "next"].map((intentId, index) => ({
              routing_key: 7,
              intent_id: intentId,
              kind: "effect",
              bucket: 0,
              due_at_ms: leaseEnd,
              scheduled_at_ms: now + index,
              ready_at_ms: now + index,
              waiting: true,
              tenant_id: "wake-race",
              actor_type: "Controlled",
              actor_id: "raced",
              target_type: "Controlled",
              target_id: "raced",
              command: "Serial",
              payload: "{}",
              caller: "{}",
            })),
          )}`

          // A claim of the oldest row, as the capped claim writes it, held open before it commits.
          const locked = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()

          const claim = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`SELECT 1 FROM actor_outbox
                  WHERE routing_key = 7 AND intent_id = 'oldest' FOR UPDATE`
                yield* sql`UPDATE actor_outbox SET running = true, waiting = false,
                    attempts = 1, due_at_ms = ${leaseEnd}
                  WHERE routing_key = 7 AND intent_id = 'oldest'`
                yield* Deferred.succeed(locked, undefined)
                yield* Deferred.await(release)
              }),
            )
            .pipe(Effect.forkChild)

          yield* Deferred.await(locked)

          const wake = yield* wakeWaiting({ sql, group, at: now }).pipe(Effect.forkChild)

          // The claim commits only once the wake has either passed its row by or read it as
          // waiting and blocked on the claim's row lock: the interleaving that shortened the lease.
          yield* eventually(
            Effect.gen(function* () {
              if (wake.pollUnsafe() !== undefined) return true

              const [blocked] = yield* sql<{ n: number }>`SELECT count(*)::int AS n
                FROM pg_stat_activity
                WHERE wait_event_type = 'Lock' AND query LIKE 'UPDATE actor_outbox SET due_at_ms%'`

              return blocked!.n > 0
            }).pipe(Effect.orDie),
            "10 seconds",
            "the wake to finish or wait on the claim's row lock",
          )
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(claim)
          yield* Fiber.join(wake)

          const rows = yield* sql<{
            id: string
            running: boolean
            waiting: boolean
            due: string
          }>`SELECT intent_id AS id, running, waiting, due_at_ms::text AS due FROM actor_outbox
            WHERE routing_key = 7 ORDER BY intent_id`

          // The claimed attempt keeps its whole lease, so it still counts against the cap;
          // the wake goes to the row still waiting.
          expect(rows).toEqual([
            { id: "next", running: false, waiting: false, due: String(now) },
            { id: "oldest", running: true, waiting: false, due: String(leaseEnd) },
          ])
        }),
      ),
  },
  {
    name: "caps one actor's running attempts across three runners while other actors proceed",
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment, fixture: { effectControl: fixture } }) =>
      withCluster(
        environment,
        fixture,
        3,
        {},
        Effect.gen(function* () {
          fixture.provider = (attempt) => Effect.sleep("100 millis").pipe(Effect.as(attempt.label))
          const labels = Array.from({ length: 12 }, (_, index) => `capped-${index}`)
          yield* on(1, perform("capped", "Capped", labels))
          yield* on(
            2,
            Effect.forEach(
              Array.from({ length: 6 }, (_, index) => `other-${index}`),
              (id) => perform(id, "Capped", [id]),
              { concurrency: 6, discard: true },
            ),
          )
          yield* eventually(
            on(0, stateOf("capped")).pipe(Effect.map((state) => (state.done ?? []).length === 12)),
            "60 seconds",
            "every capped effect",
          )

          expect(maxInFlight(fixture.attempts, "capped", "Capped") <= 2).toBe(true)
          expect(new Set(fixture.attempts.map(({ effectId }) => effectId)).size).toBe(18)
          expect(fixture.attempts.every(({ attempt }) => attempt === 1)).toBe(true)
        }),
      ),
  },
  {
    name: "keeps a killed runner's capped attempt counted until its lease ends, then retries it first",
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment, fixture: { effectControl: fixture } }) =>
      withCluster(
        environment,
        fixture,
        3,
        // Long enough that a loaded machine's late renewal cannot lose the lease before the kill.
        { executors: { lease: "9 seconds" } },
        Effect.gen(function* () {
          fixture.provider = (attempt) =>
            attempt.label === "first" && attempt.attempt === 1
              ? Effect.never
              : Effect.succeed(`${attempt.label}@${attempt.attempt}`)
          const { owner, other } = yield* ownerAndOther(yield* refOf("killed"))
          yield* on(other, perform("killed", "Serial", ["first"]))
          yield* eventually(Effect.sync(() => fixture.attempts.length === 1))
          yield* on(other, perform("killed", "Serial", ["second"]))
          const holder = fixture.attempts[0]!.runner
          const cluster = yield* ActorCluster
          yield* cluster.kill(holder)
          const killedAt = yield* Clock.currentTimeMillis
          yield* cluster.ready
          const survivor = [owner, other, (owner + 2) % 3].find((runner) => runner !== holder)!

          yield* eventually(
            on(survivor, stateOf("killed")).pipe(
              Effect.map((state) => (state.done ?? []).length === 2),
            ),
            "60 seconds",
            "both effects",
          )
          const later = fixture.attempts.slice(1)

          // Nothing started on a survivor while the dead attempt's lease still counted.
          expect(later.map(({ label, attempt }) => `${label}@${attempt}`)).toEqual([
            "first@2",
            "second@1",
          ])
          expect(later.every(({ startedAt }) => startedAt >= killedAt)).toBe(true)
          expect(maxInFlight(later, "killed", "Serial")).toBe(1)
          expect((yield* on(survivor, stateOf("killed"))).done).toEqual(["first@2", "second@1"])
        }),
      ),
  },
  {
    name: "frees a capped slot when an attempt loses its lease, interrupting it before the takeover starts",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture: { effectControl: fixture } }) =>
      withCluster(
        environment,
        fixture,
        2,
        { executors: SHORT_LEASE },
        Effect.gen(function* () {
          fixture.provider = (attempt) =>
            attempt.attempt === 1 ? Effect.never : Effect.succeed(attempt.label)
          fixture.hook = (point) =>
            point === "beforeRenew" && fixture.attempts.length === 1
              ? Effect.die(new Error("Database unreachable"))
              : Effect.void
          yield* on(0, perform("lost", "Serial", ["lost"]))
          yield* eventually(
            on(0, stateOf("lost")).pipe(Effect.map((state) => (state.done ?? []).length === 1)),
            "30 seconds",
            "the takeover",
          )
          const [first, second] = fixture.attempts

          expect(first!.interrupted).toBe(true)
          expect(first!.endedAt! <= second!.startedAt).toBe(true)
          expect(maxInFlight(fixture.attempts, "lost", "Serial")).toBe(1)
        }),
      ),
  },
  {
    name: "keeps a newer capped attempt's slot when an attempt that lost its lease settles late",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture: { effectControl: fixture } }) =>
      withCluster(
        environment,
        fixture,
        2,
        { relay: NO_POLL, executors: SHORT_LEASE },
        Effect.gen(function* () {
          const held = yield* Deferred.make<void>()
          const newer = yield* Deferred.make<void>()
          const settling = yield* Deferred.make<void>()
          fixture.provider = (attempt) =>
            attempt.label === "slow" && attempt.attempt === 2
              ? Deferred.await(newer).pipe(Effect.as("slow@2"))
              : Effect.succeed(`${attempt.label}@${attempt.attempt}`)
          // Attempt 1 has succeeded but its settle waits until attempt 2 runs.
          fixture.hook = (point) =>
            point === "afterExecute" && fixture.attempts.length === 1
              ? Deferred.succeed(settling, undefined).pipe(Effect.andThen(Deferred.await(held)))
              : Effect.void
          const { owner, other } = yield* ownerAndOther(yield* refOf("overlap"))

          yield* on(owner, perform("overlap", "Serial", ["slow"]))
          yield* Deferred.await(settling)
          expect(fixture.attempts[0]!.runner).toBe(owner)

          // The other runner sees attempt 1's lease expired and takes attempt 2.
          // Forked: the drain after the jump waits for the attempt it claims.
          yield* advance(other, "4 seconds").pipe(Effect.forkChild)
          yield* eventually(
            Effect.sync(() => fixture.attempts.length === 2),
            "10 seconds",
          )
          expect(fixture.attempts[1]).toMatchObject({ runner: other, attempt: 2 })

          yield* Deferred.succeed(held, undefined)
          yield* Effect.sleep("1 second")
          yield* on(owner, perform("overlap", "Serial", ["next"]))
          yield* Effect.sleep("2 seconds")

          // Attempt 2 still holds the only slot, so the next effect has not started.
          expect(fixture.attempts.map(({ label }) => label)).toEqual(["slow", "slow"])
          expect(
            (yield* query(other, effectRows)).find(
              (row) => row.command === "Serial" && row.running,
            ),
          ).toMatchObject({ attempts: 2 })

          yield* Deferred.succeed(newer, undefined)
          yield* eventually(
            on(other, stateOf("overlap")).pipe(
              Effect.map((state) => (state.done ?? []).length === 2),
            ),
            "20 seconds",
            "both effects",
          )

          expect(maxInFlight(fixture.attempts, "overlap", "Serial")).toBe(1)
          const { done } = yield* on(other, stateOf("overlap"))
          expect(done!.filter((label) => label.startsWith("slow")).length).toBe(1)
          expect(done).toContain("next@1")
        }),
      ),
  },
  {
    name: "reaches a running attempt on another runner within cancelCheck and reports Unknown",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture: { effectControl: fixture } }) =>
      withCluster(
        environment,
        fixture,
        2,
        { relay: NO_POLL, executors: { lease: "3 seconds", cancelCheck: "1 second" } },
        Effect.gen(function* () {
          fixture.provider = () => Effect.never
          const { owner, other } = yield* ownerAndOther(yield* refOf("remote"))
          // Only the other runner's relay claims the effect: the owner's poll never runs.
          yield* on(owner, perform("remote", "Job", ["remote"], { keyed: true, afterMs: 60_000 }))
          yield* advance(other, "1 minute")
          yield* eventually(Effect.sync(() => fixture.attempts.length === 1))
          expect(fixture.attempts[0]!.runner).toBe(other)

          const cancelledAt = yield* Clock.currentTimeMillis
          yield* on(owner, cancel("remote", ["remote"]))
          yield* eventually(
            Effect.sync(() => fixture.attempts[0]!.interrupted),
            "5 seconds",
            "the remote interruption",
          )

          expect(fixture.attempts[0]!.endedAt! - cancelledAt <= 2500).toBe(true)
          yield* eventually(
            on(owner, stateOf("remote")).pipe(
              Effect.map((state) => (state.cancelled ?? []).length === 1),
            ),
          )
          expect((yield* on(owner, stateOf("remote"))).cancelled).toMatchObject([
            { outcome: "Unknown", ambiguous: true },
          ])
          expect(fixture.attempts.length).toBe(1)
        }),
      ),
  },
  {
    name: "routes a success that finishes before the cancellation is seen to onCancelled as Succeeded",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture: { effectControl: fixture } }) =>
      withCluster(
        environment,
        fixture,
        2,
        { relay: NO_POLL },
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>()
          fixture.provider = (attempt) => Deferred.await(gate).pipe(Effect.as(attempt.label))
          const { owner, other } = yield* ownerAndOther(yield* refOf("raced"))
          yield* on(owner, perform("raced", "Job", ["raced"], { keyed: true, afterMs: 60_000 }))
          yield* advance(other, "1 minute").pipe(Effect.forkChild)
          yield* eventually(Effect.sync(() => fixture.attempts.length === 1))

          // The attempt's runner renews every 20 s, so it has not seen the cancellation yet.
          yield* on(owner, cancel("raced", ["raced"]))
          yield* Deferred.succeed(gate, undefined)
          yield* eventually(
            on(owner, stateOf("raced")).pipe(
              Effect.map((state) => (state.cancelled ?? []).length === 1),
            ),
          )
          const state = yield* on(owner, stateOf("raced"))

          expect(state.cancelled).toMatchObject([
            { outcome: "Succeeded", value: "raced", ambiguous: false },
          ])
          expect(state.done ?? []).toEqual([])
        }),
      ),
  },
  {
    name: "routes a capped success that finishes before the cancellation is seen to onCancelled",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture: { effectControl: fixture } }) =>
      withCluster(
        environment,
        fixture,
        2,
        { relay: NO_POLL },
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>()
          fixture.provider = (attempt) => Deferred.await(gate).pipe(Effect.as(attempt.label))
          const { owner, other } = yield* ownerAndOther(yield* refOf("capped-raced"))
          yield* on(
            owner,
            perform("capped-raced", "Capped", ["capped"], { keyed: true, afterMs: 60_000 }),
          )
          yield* advance(other, "1 minute").pipe(Effect.forkChild)
          yield* eventually(Effect.sync(() => fixture.attempts.length === 1))
          yield* on(owner, cancel("capped-raced", ["capped"]))
          yield* Deferred.succeed(gate, undefined)
          yield* eventually(
            on(owner, stateOf("capped-raced")).pipe(
              Effect.map((state) => (state.cancelled ?? []).length === 1),
            ),
          )
          const state = yield* on(owner, stateOf("capped-raced"))

          expect(state.cancelled).toMatchObject([
            { outcome: "Succeeded", value: "capped", ambiguous: false },
          ])
          expect(state.done ?? []).toEqual([])
          expect(yield* query(owner, effectRows)).toEqual([])
        }),
      ),
  },
  {
    name: "routes a cancelled success that onSuccess cannot accept to onCancelled as Succeeded",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture: { effectControl: fixture } }) =>
      withCluster(
        environment,
        fixture,
        2,
        { relay: NO_POLL },
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>()
          fixture.provider = (attempt) => Deferred.await(gate).pipe(Effect.as(attempt.label))
          const { owner, other } = yield* ownerAndOther(yield* refOf("picky"))
          yield* on(
            owner,
            perform("picky", "Picky", ["rejected"], { keyed: true, afterMs: 60_000 }),
          )
          yield* advance(other, "1 minute").pipe(Effect.forkChild)
          yield* eventually(Effect.sync(() => fixture.attempts.length === 1))
          yield* on(owner, cancel("picky", ["rejected"]))
          yield* Deferred.succeed(gate, undefined)
          yield* eventually(
            on(owner, stateOf("picky")).pipe(
              Effect.map((state) => (state.cancelled ?? []).length === 1),
            ),
          )
          const state = yield* on(owner, stateOf("picky"))

          expect(state.cancelled).toMatchObject([
            { outcome: "Succeeded", value: "rejected", ambiguous: false },
          ])
          expect(state.done ?? []).toEqual([])
          expect(yield* query(owner, effectRows)).toEqual([])
          expect(fixture.attempts.length).toBe(1)
        }),
      ),
  },
  {
    name: "records a late success after its cancellation settled as ambiguous and routes it once",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture: { effectControl: fixture } }) =>
      withCluster(
        environment,
        fixture,
        2,
        { relay: NO_POLL, executors: SHORT_LEASE },
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>()
          fixture.provider = (attempt) => Deferred.await(gate).pipe(Effect.as(attempt.label))
          const { owner, other } = yield* ownerAndOther(yield* refOf("late"))

          const renewal = yield* on(
            owner,
            ActorTest.use((test) => test.pauseNext("beforeRenew")),
          )

          yield* on(owner, perform("late", "Job", ["late"], { keyed: true }))
          yield* eventually(Effect.sync(() => fixture.attempts.length === 1))
          expect(fixture.attempts[0]!.runner).toBe(owner)
          yield* renewal.reached
          yield* on(other, cancel("late", ["late"]))

          // The other runner's clock passes the lease and settles the cancellation it finds.
          yield* advance(other, "4 seconds")
          yield* eventually(
            on(other, stateOf("late")).pipe(
              Effect.map((state) => (state.cancelled ?? []).length === 1),
            ),
          )
          yield* Deferred.succeed(gate, undefined)
          yield* eventually(
            query(other, deadLetters).pipe(Effect.map((letters) => letters.length === 1)),
            "10 seconds",
            "the late success's record",
          )
          yield* renewal.release

          expect(yield* query(other, deadLetters)).toMatchObject([
            { ambiguous: true, cause: "Succeeded after it was cancelled" },
          ])
          const state = yield* on(other, stateOf("late"))
          expect(state.cancelled).toMatchObject([{ outcome: "Unknown", ambiguous: true }])
          expect(state.done ?? []).toEqual([])
        }),
      ),
  },
  {
    name: "records a late success onSuccess cannot accept after its cancellation settled",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture: { effectControl: fixture } }) =>
      withCluster(
        environment,
        fixture,
        2,
        { relay: NO_POLL, executors: SHORT_LEASE },
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>()
          fixture.provider = (attempt) => Deferred.await(gate).pipe(Effect.as(attempt.label))
          const { owner, other } = yield* ownerAndOther(yield* refOf("late-picky"))

          const renewal = yield* on(
            owner,
            ActorTest.use((test) => test.pauseNext("beforeRenew")),
          )

          yield* on(owner, perform("late-picky", "Picky", ["rejected"], { keyed: true }))
          yield* eventually(Effect.sync(() => fixture.attempts.length === 1))
          expect(fixture.attempts[0]!.runner).toBe(owner)
          yield* renewal.reached
          yield* on(other, cancel("late-picky", ["rejected"]))

          // The other runner's clock passes the lease and settles the cancellation it finds.
          yield* advance(other, "4 seconds")
          yield* eventually(
            on(other, stateOf("late-picky")).pipe(
              Effect.map((state) => (state.cancelled ?? []).length === 1),
            ),
          )
          yield* Deferred.succeed(gate, undefined)
          yield* eventually(
            query(other, deadLetters).pipe(Effect.map((letters) => letters.length === 1)),
            "10 seconds",
            "the late success's record",
          )
          yield* renewal.release

          expect(yield* query(other, deadLetters)).toMatchObject([
            { ambiguous: true, cause: "Succeeded after it was cancelled" },
          ])
          const state = yield* on(other, stateOf("late-picky"))
          expect(state.cancelled).toMatchObject([{ outcome: "Unknown", ambiguous: true }])
          expect(state.done ?? []).toEqual([])
        }),
      ),
  },
  {
    name: "gives each effect exactly one fate when cancellation races its claim",
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment, fixture: { effectControl: fixture } }) =>
      withCluster(
        environment,
        fixture,
        3,
        {},
        Effect.gen(function* () {
          fixture.provider = (attempt) => Effect.sleep("5 millis").pipe(Effect.as(attempt.label))
          const ids = Array.from({ length: 40 }, (_, index) => `race-${index}`)
          yield* Effect.forEach(
            ids,
            (id, index) =>
              on(
                index % 3,
                perform(id, "Job", [id], { keyed: true }).pipe(Effect.andThen(cancel(id, [id]))),
              ),
            { concurrency: 8, discard: true },
          )
          yield* eventually(
            query(0, (sql) =>
              sql<{ n: number }>`SELECT count(*)::int AS n FROM actor_outbox
                WHERE actor_type = 'Controlled'`.pipe(Effect.map((rows) => rows[0]!.n === 0)),
            ),
            "30 seconds",
            "the outbox to settle",
          )

          for (const id of ids) {
            const state = yield* on(0, stateOf(id))
            const ran = fixture.attempts.filter(({ actor }) => actor === id)
            const fates = (state.done ?? []).length + (state.cancelled ?? []).length

            expect(ran.length <= 1).toBe(true)
            expect(fates).toBe(ran.length === 0 ? 0 : 1)
            expect((state.cancelled ?? []).every(({ outcome }) => outcome !== "Failed")).toBe(true)
          }
        }),
      ),
  },
  {
    name: "settles a cancelled effect whose runner was killed as ambiguous without running it",
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment, fixture: { effectControl: fixture } }) =>
      withCluster(
        environment,
        fixture,
        3,
        { executors: { lease: "9 seconds" } },
        Effect.gen(function* () {
          fixture.provider = () => Effect.never
          const { owner, other } = yield* ownerAndOther(yield* refOf("orphan"))
          yield* on(other, perform("orphan", "Job", ["orphan"], { keyed: true }))
          yield* eventually(Effect.sync(() => fixture.attempts.length === 1))
          const holder = fixture.attempts[0]!.runner
          const cluster = yield* ActorCluster
          yield* cluster.kill(holder)
          yield* cluster.ready
          const survivor = [owner, other, (owner + 2) % 3].find((runner) => runner !== holder)!
          yield* on(survivor, cancel("orphan", ["orphan"]))
          yield* eventually(
            on(survivor, stateOf("orphan")).pipe(
              Effect.map((state) => (state.cancelled ?? []).length === 1),
            ),
            "60 seconds",
            "the orphan's cancellation report",
          )

          expect(fixture.attempts.length).toBe(1)
          expect((yield* on(survivor, stateOf("orphan"))).cancelled).toMatchObject([
            { outcome: "Unknown", ambiguous: true },
          ])
          // The relay deletes the delivered route's row after its receiver commits.
          yield* eventually(
            query(survivor, effectRows).pipe(Effect.map((rows) => rows.length === 0)),
            "20 seconds",
            "the delivered route's row to be deleted",
          )
        }),
      ),
  },
]
