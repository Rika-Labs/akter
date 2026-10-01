import { PgClient } from "@effect/sql-pg"
import { PgliteClient } from "@effect/sql-pglite"
import { Cause, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Actor, Caller, System } from "../../index.ts"
import type { ExecutorContext } from "../../contexts/job.ts"
import { CommandId } from "../../identity/command.ts"
import { ActorTest } from "../actor-test.ts"
import type { ConformanceCase, ConformanceSuite } from "../conformance.ts"

/** What the fake provider does on one call; calls past the plan succeed. */
type ProviderStep = "ok" | "fail" | "die"

export interface EffectsFixture {
  /** Provider calls keyed by idempotency key, the effect id. */
  readonly calls: Map<string, number>
  readonly attempts: Array<ExecutorContext>
  plan: Array<ProviderStep>
  /** Whether any executor attempt could reach a SQL client. */
  sawDatabase: boolean
  escaped: Effect.Effect<void>
}

/** Creates the state effect cases observe; each case starts from a fresh one. */
export const effectsFixture = (): EffectsFixture => ({
  calls: new Map(),
  attempts: [],
  plan: [],
  sawDatabase: false,
  escaped: Effect.void,
})

class ProviderDown extends Schema.TaggedError<ProviderDown>()("ProviderDown", {}) {}

class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}

const Verdict = Schema.Struct({ id: Schema.String, flagged: Schema.Boolean })

const Moderate = Actor.job("Moderate", {
  payload: { id: Schema.String, body: Schema.String },
  success: Verdict,
})

const Measure = Actor.job("Measure", {
  payload: { value: Schema.Finite },
  success: Schema.Finite,
})

const Notify = Actor.job("Notify", { payload: { body: Schema.String } })

const Routed = Schema.Struct({
  id: Schema.String,
  flagged: Schema.Boolean,
  commandId: Schema.String,
  caller: Caller,
})

const Dead = Schema.Struct({
  effectId: Schema.String,
  id: Schema.String,
  attempts: Schema.Int,
  cause: Schema.String,
  ambiguous: Schema.Boolean,
  commandId: Schema.String,
})

const Post = Actor.command("Post", { payload: Schema.String })

const PostThenRefuse = Actor.command("PostThenRefuse", { payload: Schema.String, error: Refused })

const PostThenDie = Actor.command("PostThenDie", { payload: Schema.String })

const Ping = Actor.command("Ping", { payload: Schema.String })

const Escape = Actor.command("Escape")

const Gauge = Actor.command("Gauge", { payload: Schema.Finite })

const Measured = Actor.command("Measured", { payload: Schema.Int })

const Steal = Actor.command("Steal")

const Moderated = Actor.command("Moderated", { payload: Verdict })

const ModerationFailed = Actor.command("ModerationFailed", { payload: Actor.DeadLetter(Moderate) })

const Author = Actor.make("Author", {
  key: Schema.String,
  state: Actor.state({
    routed: Schema.Array(Routed).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    dead: Schema.Array(Dead).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
  jobs: {
    Moderate: {
      job: Moderate,
      retry: { times: 1 },
      onSuccess: Moderated,
      onDeadLetter: ModerationFailed,
    },
    Notify: { job: Notify, retry: { times: 0 } },
    Measure: { job: Measure, retry: { times: 2 }, onSuccess: Measured },
  },
  api: { Post, PostThenRefuse, PostThenDie, Ping, Escape, Steal, Gauge },
  internal: { Moderated, ModerationFailed, Measured },
})

const AuthorState = Schema.Struct({
  routed: Schema.optional(Schema.Array(Routed)),
  dead: Schema.optional(Schema.Array(Dead)),
})

/** Handlers for the effect actors; `fixture` supplies the fake provider and the counters cases assert on. */
export const effectsLayer = (fixture: EffectsFixture) =>
  Layer.mergeAll(
    Author.toLayer(
      Effect.succeed({
        Post: Effect.fnUntraced(function* (body: string) {
          const turn = yield* Author.Turn
          yield* turn.enqueue(Moderate.make({ id: turn.commandId, body }))
        }),
        PostThenRefuse: Effect.fnUntraced(function* (body: string) {
          const turn = yield* Author.Turn
          yield* turn.enqueue(Moderate.make({ id: turn.commandId, body }))

          return yield* Refused.make({})
        }),
        PostThenDie: Effect.fnUntraced(function* (body: string) {
          const turn = yield* Author.Turn
          yield* turn.enqueue(Moderate.make({ id: turn.commandId, body }))

          return yield* Effect.die(new Error("Author defect after performing"))
        }),
        Ping: Effect.fnUntraced(function* (body: string) {
          yield* (yield* Author.Turn).enqueue(Notify.make({ body }))
        }),
        Escape: Effect.fnUntraced(function* () {
          const turn = yield* Author.Turn
          fixture.escaped = turn.enqueue(Notify.make({ body: "escaped" }))
        }),
        Steal: () => Effect.suspend(() => fixture.escaped),
        Gauge: Effect.fnUntraced(function* (value: number) {
          yield* (yield* Author.Turn).enqueue(Measure.make({ value }))
        }),
        Measured: () => Effect.void,
        Moderated: Effect.fnUntraced(function* (verdict) {
          const turn = yield* Author.Turn
          yield* turn.state.set({
            routed: [
              ...turn.state.routed,
              { ...verdict, commandId: turn.commandId, caller: turn.caller },
            ],
          })
        }),
        ModerationFailed: Effect.fnUntraced(function* (letter) {
          const turn = yield* Author.Turn
          yield* turn.state.set({
            dead: [
              ...turn.state.dead,
              {
                effectId: letter.jobId,
                id: letter.job.id,
                attempts: letter.attempts,
                cause: letter.cause,
                ambiguous: letter.ambiguous,
                commandId: turn.commandId,
              },
            ],
          })
        }),
      }),
    ),
    Author.toJobLayer(
      Effect.succeed({
        Moderate: Effect.fnUntraced(function* ({ id, body }) {
          const exec = yield* Author.Executor
          fixture.attempts.push(exec)
          fixture.sawDatabase ||=
            Option.isSome(yield* Effect.serviceOption(SqlClient.SqlClient)) ||
            Option.isSome(yield* Effect.serviceOption(PgClient.PgClient)) ||
            Option.isSome(yield* Effect.serviceOption(PgliteClient.PgliteClient))
          const step = fixture.plan.shift() ?? "ok"

          if (step === "fail") return yield* ProviderDown.make({})
          fixture.calls.set(exec.jobId, (fixture.calls.get(exec.jobId) ?? 0) + 1)

          if (step === "die") return yield* Effect.die(new Error("Provider reply lost"))

          return { id, flagged: body.includes("spam") }
        }),
        Measure: Effect.fnUntraced(function* ({ value }) {
          const exec = yield* Author.Executor
          fixture.attempts.push(exec)
          fixture.calls.set(exec.jobId, (fixture.calls.get(exec.jobId) ?? 0) + 1)

          return value
        }),
        Notify: Effect.fnUntraced(function* () {
          const exec = yield* Author.Executor
          fixture.attempts.push(exec)
          fixture.calls.set(exec.jobId, (fixture.calls.get(exec.jobId) ?? 0) + 1)

          if (fixture.plan.shift() === "die")
            return yield* Effect.die(new Error("Provider reply lost"))
        }),
      }),
    ),
  )

const authorState = Effect.fnUntraced(function* (id: string) {
  const author = yield* Author.get(id)
  const { state } = yield* (yield* ActorTest).inspect(author.ref)
  const decoded = yield* Schema.decodeUnknownEffect(AuthorState)(state).pipe(Effect.orDie)

  return { routed: decoded.routed ?? [], dead: decoded.dead ?? [] }
})

const deadLetters = Effect.fnUntraced(function* (actorId: string) {
  const sql = yield* SqlClient.SqlClient
  const test = yield* ActorTest

  return yield* sql<{
    job: string
    attempts: number
    ambiguous: boolean
  }>`SELECT job, attempts, ambiguous FROM actor_dead_letters
    WHERE tenant_id = ${test.tenant} AND actor_type = 'Author' AND actor_id = ${actorId}
    ORDER BY job`
})

const attemptsOf = (fixture: EffectsFixture, id: string) =>
  fixture.attempts.filter((attempt) => attempt.ref.id === id)

/** Effect cases: executors run only after the turn commits, results route to `onSuccess` once under the effect id, and declared failures, defects, and rolled-back commits discard performed effects. */
export const effectsConformance: ReadonlyArray<ConformanceCase<EffectsFixture>> = [
  {
    name: "routes an executor's result to onSuccess once with the effect id as its command id",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const author = yield* Author.get("route")
          yield* author.Post("hello spam")
          yield* test.advance(0)
          const [attempt] = attemptsOf(fixture, "route")
          const { routed } = yield* authorState("route")

          expect(attemptsOf(fixture, "route").length).toBe(1)
          expect(Schema.is(CommandId)(attempt?.jobId)).toBe(true)
          expect(attempt).toMatchObject({ attempt: 1, ref: author.ref })
          expect(attempt && Option.getOrUndefined(attempt.principal)).toEqual({ subject: "alice" })
          expect(fixture.sawDatabase).toBe(false)
          expect(routed).toMatchObject([
            {
              flagged: true,
              commandId: attempt?.jobId,
              caller: System.make({
                source: "job",
                ref: author.ref,
                onBehalfOf: { subject: "alice" },
              }),
            },
          ])
          expect(yield* test.receiptsFor(author.ref, "Moderated")).toBe(1)
          expect(yield* test.inspect(author.ref)).toMatchObject({
            receipts: 2,
            outbox: 0,
            jobs: 0,
          })
          yield* test.advance("1 hour")
          expect((yield* authorState("route")).routed.length).toBe(1)
        }),
      ),
  },
  {
    name: "never runs an executor before its turn commits",
    requiresIndependentConnections: true,
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const author = yield* Author.get("visibility")
          const pause = yield* test.pauseNext("beforeCommit")
          const waiter = yield* author.Post("later").pipe(Effect.forkChild)
          yield* pause.reached
          yield* test.advance(0)
          expect(attemptsOf(fixture, "visibility")).toEqual([])
          expect(yield* test.inspect(author.ref)).toMatchObject({ receipts: 0, jobs: 0 })
          yield* pause.release
          yield* Fiber.join(waiter)
          yield* test.advance(0)
          expect(attemptsOf(fixture, "visibility").length).toBe(1)
          expect((yield* authorState("visibility")).routed.length).toBe(1)
        }),
      ),
  },
  {
    name: "discards performed effects on a declared failure, a defect, and a rolled-back commit",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const author = yield* Author.get("rollback")
          expect(yield* author.PostThenRefuse("refused").pipe(Effect.flip)).toBeInstanceOf(Refused)
          const died = yield* author.PostThenDie("died").pipe(Effect.exit)
          expect(Exit.isFailure(died) && Cause.pretty(died.cause)).toContain("Author defect")
          expect(yield* test.inspect(author.ref)).toMatchObject({
            receipts: 1,
            jobs: 0,
            outbox: 0,
          })
          yield* test.crashNext("beforeCommit")
          yield* author.Post("retried")
          yield* test.advance(0)
          expect(attemptsOf(fixture, "rollback").length).toBe(1)
          expect((yield* authorState("rollback")).routed.length).toBe(1)
          expect(yield* test.inspect(author.ref)).toMatchObject({
            receipts: 3,
            jobs: 0,
            outbox: 0,
          })
        }),
      ),
  },
  {
    name: "routes a moderation result once, even if the executor succeeds twice",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const author = yield* Author.get("twice")
          yield* test.crashNext("afterExecute")
          yield* author.Post("twice")
          yield* test.advance(0)
          expect(yield* test.inspect(author.ref)).toMatchObject({ jobs: 1, outbox: 0 })
          expect((yield* authorState("twice")).routed).toEqual([])
          yield* test.advance("1 minute")
          const attempts = attemptsOf(fixture, "twice")
          const effectId = attempts[0]!.jobId

          expect(attempts.map(({ attempt, jobId }) => [attempt, jobId])).toEqual([
            [1, effectId],
            [2, effectId],
          ])
          expect(fixture.calls.get(effectId)).toBe(2)
          expect((yield* authorState("twice")).routed.map(({ commandId }) => commandId)).toEqual([
            effectId,
          ])
          expect(yield* test.receiptsFor(author.ref, "Moderated")).toBe(1)
          expect(yield* test.inspect(author.ref)).toMatchObject({ jobs: 0, outbox: 0 })
        }),
      ),
  },
  {
    name: "delivers onSuccess once across route crashes after the executor's result is recorded",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const author = yield* Author.get("route-crash")
          const pause = yield* test.pauseNext("beforeExecute")
          yield* author.Post("once")
          const draining = yield* test.advance(0).pipe(Effect.forkChild)
          yield* pause.reached
          yield* test.crashNext("afterCommit")
          yield* test.crashNext("beforeOutboxDelete")
          yield* pause.release
          yield* Fiber.join(draining)
          yield* test.advance("1 minute")

          expect(attemptsOf(fixture, "route-crash").length).toBe(1)
          expect((yield* authorState("route-crash")).routed.length).toBe(1)
          expect(yield* test.receiptsFor(author.ref, "Moderated")).toBe(1)
          expect(yield* test.inspect(author.ref)).toMatchObject({ jobs: 0, outbox: 0 })
        }),
      ),
  },
  {
    name: "retries after a crash before the executor runs and routes the result once",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const author = yield* Author.get("before-execute")
          yield* test.crashNext("beforeExecute")
          yield* author.Post("claimed")
          yield* test.advance(0)
          expect(attemptsOf(fixture, "before-execute")).toEqual([])
          expect(yield* test.inspect(author.ref)).toMatchObject({ jobs: 1 })
          yield* test.advance("1 minute")
          expect(attemptsOf(fixture, "before-execute").map(({ attempt }) => attempt)).toEqual([2])
          expect((yield* authorState("before-execute")).routed.length).toBe(1)
          expect(yield* test.inspect(author.ref)).toMatchObject({ jobs: 0, outbox: 0 })
        }),
      ),
  },
  {
    name: "delivers onDeadLetter once in a new turn after retries run out",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const author = yield* Author.get("exhausted")
          fixture.plan = ["fail", "fail"]
          yield* author.Post("doomed")
          yield* test.advance(0)
          yield* test.advance("1 second")
          const [first] = attemptsOf(fixture, "exhausted")
          const { routed, dead } = yield* authorState("exhausted")

          expect(attemptsOf(fixture, "exhausted").length).toBe(2)
          expect(routed).toEqual([])
          expect(dead).toMatchObject([
            {
              effectId: first?.jobId,
              attempts: 2,
              ambiguous: false,
              commandId: first?.jobId,
            },
          ])
          expect(dead[0]?.cause).toContain("ProviderDown")
          expect(yield* test.receiptsFor(author.ref, "ModerationFailed")).toBe(1)
          expect(yield* deadLetters("exhausted")).toEqual([
            { job: "Moderate", attempts: 2, ambiguous: false },
          ])
          yield* test.advance("1 hour")
          expect((yield* authorState("exhausted")).dead.length).toBe(1)
          expect(yield* test.inspect(author.ref)).toMatchObject({ jobs: 0, outbox: 0 })
        }),
      ),
  },
  {
    name: "keeps a lost provider acknowledgment distinguishable from failure",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const author = yield* Author.get("ambiguous")
          fixture.plan = ["fail"]
          yield* test.crashNext("afterExecute")
          yield* author.Post("unknown")
          yield* test.advance(0)
          yield* test.advance("1 second")
          expect((yield* authorState("ambiguous")).dead).toEqual([])
          yield* test.advance("1 minute")
          const attempts = attemptsOf(fixture, "ambiguous")
          const { dead } = yield* authorState("ambiguous")

          expect(fixture.calls.get(attempts[0]!.jobId)).toBe(1)
          expect(dead).toMatchObject([{ attempts: 2, ambiguous: true }])
          expect(dead[0]?.cause).toContain("without reporting an outcome")

          fixture.plan = ["die"]
          yield* author.Ping("notify")
          yield* test.advance(0)
          expect(yield* deadLetters("ambiguous")).toEqual([
            { job: "Moderate", attempts: 2, ambiguous: true },
            { job: "Notify", attempts: 1, ambiguous: true },
          ])
          expect(yield* test.inspect(author.ref)).toMatchObject({ jobs: 0, outbox: 0 })
        }),
      ),
  },
  {
    name: "dead-letters a result its route cannot accept without calling the provider again",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const author = yield* Author.get("unroutable")
          yield* author.Gauge(1.5)
          yield* test.advance("1 hour")
          const attempts = attemptsOf(fixture, "unroutable")

          expect(attempts.length).toBe(1)
          expect(fixture.calls.get(attempts[0]!.jobId)).toBe(1)
          expect(yield* test.receiptsFor(author.ref, "Measured")).toBe(0)
          expect(yield* deadLetters("unroutable")).toEqual([
            { job: "Measure", attempts: 1, ambiguous: true },
          ])
          expect(yield* test.inspect(author.ref)).toMatchObject({ jobs: 0, outbox: 0 })
        }),
      ),
  },
  {
    name: "retries only the dead letter of a rejected result whose dead-letter commit fails",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const author = yield* Author.get("unroutable-retry")
          yield* test.crashNext("beforeDeadLetterCommit")
          yield* author.Gauge(1.5)
          yield* test.advance(0)
          expect(yield* deadLetters("unroutable-retry")).toEqual([])
          expect(
            yield* (yield* SqlClient.SqlClient)<{ attempts: number; final_failure: boolean }>`
              SELECT attempts, final_failure FROM actor_outbox
              WHERE tenant_id = ${test.tenant} AND actor_id = 'unroutable-retry' AND kind = 'job'`,
          ).toEqual([{ attempts: 1, final_failure: true }])
          yield* test.advance("1 hour")
          const attempts = attemptsOf(fixture, "unroutable-retry")

          expect(attempts.map(({ attempt }) => attempt)).toEqual([1])
          expect(fixture.calls.get(attempts[0]!.jobId)).toBe(1)
          expect(yield* test.receiptsFor(author.ref, "Measured")).toBe(0)
          expect(yield* deadLetters("unroutable-retry")).toEqual([
            { job: "Measure", attempts: 1, ambiguous: true },
          ])
          expect(yield* test.inspect(author.ref)).toMatchObject({ jobs: 0, outbox: 0 })
        }),
      ),
  },
  {
    name: "rejects an escaped perform capability without recording an effect",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const author = yield* Author.get("escape")
          yield* author.Escape()
          const stolen = yield* author.Steal().pipe(Effect.exit)
          expect(Exit.isFailure(stolen) && Cause.pretty(stolen.cause)).toContain(
            "Job capability escaped its turn",
          )
          yield* test.advance(0)
          expect(attemptsOf(fixture, "escape")).toEqual([])
          expect(yield* test.inspect(author.ref)).toMatchObject({ receipts: 1, jobs: 0 })
        }),
      ),
  },
]

/** The effect actors and their executors. */
export const effectsSuite: ConformanceSuite<EffectsFixture> = {
  fixture: effectsFixture,
  layer: effectsLayer,
}
