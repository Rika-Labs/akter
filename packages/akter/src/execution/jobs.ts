import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Latch,
  Option,
  Predicate,
  PubSub,
  Result,
  Schema,
  Semaphore,
} from "effect"
import { Workflow, WorkflowEngine } from "effect/workflow"
import { System } from "../contract/caller.ts"
import { ActorError, InvalidInput } from "../contract/errors.ts"
import { Client, Handles } from "../contract/handle.ts"
import type { Reply, Transport } from "../contract/handle.ts"
import { JobFailure } from "../contract/members.ts"
import type { Action, Event, Job, MemberSchema } from "../contract/members.ts"
import { CommandIds } from "./command-ids.ts"
import { Durable } from "./durable.ts"
import type { ActorRecord, JobRecord } from "./durable.ts"
import type { Command, Engine } from "./engine.ts"
import { Entry, Origin } from "./entries.ts"
import type { Outcome } from "./entries.ts"
import { Layouts } from "./layout.ts"
import type { Decoded } from "./layout.ts"
import { Transports } from "./transport.ts"
import { Metrics, count } from "../runtime/telemetry/metrics.ts"
import { SpanNames } from "../runtime/telemetry/spans.ts"
import { DurableClock } from "./sleep.ts"
import * as ShardWorkflowEngine from "./workflow.ts"

/** The scope a job call is made in: a step's name, or `body`, with its call ordinal. */
interface Scope {
  readonly name: string
  next: number
  active: boolean
}

/** The enclosing step of a job call. */
class JobScope extends Context.Service<JobScope, Scope>()(
  "@rikalabs/akter/execution/jobs/JobScope",
) {}

/** A job's journal and calls cannot escape the owner generation that started its fiber. */
class JobOwner extends Context.Service<
  JobOwner,
  { readonly shard: number; readonly generation: number }
>()("@rikalabs/akter/execution/jobs/JobOwner") {}

const ReplyJson = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("Success"), value: Schema.Json }),
  Schema.Struct({ kind: Schema.Literal("Failure"), error: Schema.Json }),
])

const decodeReply = Schema.decodeUnknownEffect(ReplyJson)

/**
 * A job's failure or requirement as the runner sees it: whatever the application's Effect failed
 * with or needed. The runner only tells failures from defects and timeouts, so the value is opaque.
 */
interface Opaque {
  readonly "~opaque"?: never
}

/** Why the last attempt of a job ended, as `Actor.JobFailure` reports it. */
type JobCause = typeof JobFailure.fields.cause.Type

/** Runner routing keeps job calls and their stream retirement on the receiver's current owner. */
export interface JobRouting {
  readonly execute: (command: Command) => Effect.Effect<Outcome, ActorError>
  readonly retire: (jobId: string) => Effect.Effect<void, ActorError>
}

const bodyCall = (scope: string, attempt: number, ordinal: number): string =>
  `\u0000call\u0000${scope}\u0000${attempt}\u0000${ordinal}`

const stepValue = (value: Schema.Json | undefined): Schema.Json =>
  value === undefined ? { void: true } : { value }

const fromStepValue = (journaled: Schema.Json): Decoded =>
  Predicate.hasProperty(journaled, "value") ? journaled.value : undefined

/**
 * Runs durable jobs on their actor's shard. A job starts once its start is durable, and again from
 * its journal after a crash: the same attempt resumes, finished steps return their journaled values,
 * and calls carry ids derived from the job, scope, attempt and ordinal, so a replayed call gets the
 * receiver's stored outcome. Spent attempts reach `onFailure` exactly once.
 */
const install = (engine: Engine, routing?: JobRouting) => {
  const running = new Map<string, number>()
  const permits = new Map<string, Semaphore.Semaphore>()
  const queues = new Map<string, Latch.Latch>()

  const semaphore = (
    shard: number,
    actor: string,
    job: string,
    concurrency: number,
  ): Semaphore.Semaphore => {
    const key = `${shard}/${actor}/${job}`
    const existing = permits.get(key)
    if (existing !== undefined) return existing
    const created = Semaphore.makeUnsafe(concurrency)
    permits.set(key, created)
    return created
  }

  const journal = (shard: number, entry: Entry) =>
    Effect.flatMap(Effect.serviceOption(JobOwner), (owner) =>
      Effect.suspend(() =>
        Option.isSome(owner) && engine.generation(owner.value.shard) === owner.value.generation
          ? engine.journal(shard, entry)
          : Effect.interrupt,
      ).pipe(Transports.retryWhileUnavailable),
    )

  const retire = (jobId: string): Effect.Effect<void, ActorError> =>
    routing === undefined
      ? Effect.forEach(
          Array.from({ length: engine.catalog.shards }, (_, id) => id),
          (id) =>
            engine.durableImage(id) === undefined ||
            engine.durableImage(id)?.calls.has(jobId) === true
              ? journal(id, Entry.cases.Retired.make({ jobId }))
              : Effect.void,
          { discard: true },
        )
      : routing.retire(jobId).pipe(Transports.retryWhileUnavailable)

  const caller = (record: JobRecord) =>
    System.make({
      source: "job",
      subject: `job:${record.jobId}`,
      ref: record.address,
      onBehalfOf: record.onBehalfOf,
    })

  /** The transport a job attempt's handles use: calls get derived ids, reads go to the engine. */
  const transport = (record: JobRecord, owner: ActorRecord, attempt: number): Transport => {
    const body: Scope = { name: "body", next: 0, active: false }
    const call: Transport["call"] = (request) =>
      Effect.gen(function* () {
        const scope = Option.getOrElse(yield* Effect.serviceOption(JobScope), () => body)
        if (scope.active)
          return yield* Effect.die(new Error("concurrent job calls require distinct steps"))
        scope.active = true
        return yield* Effect.gen(function* () {
          const ownerGeneration = yield* Effect.serviceOption(JobOwner)
          const ordinal = scope.next++
          const key = bodyCall(scope.name, attempt, ordinal)
          const journaled = record.steps.get(key)
          if (journaled !== undefined) return yield* Effect.orDie(decodeReply(journaled))
          const declaration: Action | undefined = request.actor.actions[request.member]
          const own = Durable.addressOf(request.actor.name, request.id) === owner.address
          if (declaration === undefined || (declaration.internal && !own))
            return yield* ActorError.make({
              reason: InvalidInput.make({
                code: "unknown_member",
                issues: [{ path: request.member, message: "not callable from a job" }],
              }),
            })
          const command: Command = {
            origin: Origin.cases.JobCall.make({ jobId: record.jobId }),
            commandId: CommandIds.derive(record.jobId, scope.name, attempt, ordinal),
            actor: request.actor,
            keyJson: request.id,
            member: request.member,
            payload: request.payload,
            caller: caller(record),
            connection: undefined,
          }
          const outcome = yield* Effect.suspend(() =>
            Option.isSome(ownerGeneration) &&
            engine.generation(ownerGeneration.value.shard) === ownerGeneration.value.generation
              ? (routing?.execute ?? engine.execute)(command)
              : Effect.interrupt,
          ).pipe(Transports.retryWhileUnavailable)
          const reply: Reply = yield* Transports.reply(request.actor, request.member, outcome)
          yield* journal(
            engine.shardOf(record.address),
            Entry.cases.Step.make({ jobId: record.jobId, name: key, attempt, value: reply }),
          )
          return reply
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              scope.active = false
            }),
          ),
        )
      })
    return { call, ...Transports.reads(engine, caller(record)) }
  }

  const attemptOnce = (
    shard: number,
    record: JobRecord,
    owner: ActorRecord,
    declaration: Job,
    attempt: number,
    progress: Set<string>,
  ): Effect.Effect<void, Opaque> => {
    const bound = Durable.bound(engine.catalog, owner.actor.name)
    const handler = bound.registered.handlers.get(record.job)
    if (handler === undefined) {
      record.suspended = `missing job handler: ${record.job}`
      return Effect.interrupt
    }
    const jobTransport = transport(record, owner, attempt)
    const ids = new Map<string, number>()
    const visited = new Set<string>()
    const step = (
      name: string,
      first: Decoded,
      second?: Decoded,
    ): Effect.Effect<Decoded, Opaque, Opaque> => {
      const schema: MemberSchema | undefined = second === undefined ? undefined : first
      const effect: Effect.Effect<Decoded, Opaque, Opaque> = second === undefined ? first : second
      return Effect.suspend(() => {
        if (name === "body" || name.length === 0 || name.includes("\u0000") || visited.has(name))
          return Effect.die(new Error("job step names must be unique, nonempty and not reserved"))
        visited.add(name)
        const journaled = record.steps.get(name)
        const codec = schema === undefined ? undefined : Layouts.codec(schema)
        if (journaled !== undefined) {
          const value = fromStepValue(journaled)
          try {
            return Effect.succeed(codec === undefined ? value : codec.decode(value))
          } catch {
            record.suspended = `incompatible step result: ${name}`
            return Effect.interrupt
          }
        }
        progress.add(name)
        return effect.pipe(
          Effect.provideService(JobScope, { name, next: 0, active: false }),
          Effect.tap((value) =>
            journal(
              shard,
              Entry.cases.Step.make({
                jobId: record.jobId,
                name,
                attempt,
                value: stepValue(codec === undefined ? value : codec.encode(value)),
              }),
            ).pipe(
              Effect.orDie,
              Effect.tap(() =>
                Effect.sync(() => {
                  progress.delete(name)
                }),
              ),
            ),
          ),
          Effect.onExit((exit) =>
            Exit.isFailure(exit) && !Cause.hasDies(exit.cause) && !Cause.hasInterrupts(exit.cause)
              ? Effect.sync(() => {
                  progress.delete(name)
                })
              : Effect.void,
          ),
        )
      }).pipe(Effect.withSpan("step"))
    }
    const ctx = {
      self: Handles.derive({ actor: owner.actor, id: owner.keyJson, self: true }, jobTransport),
      id: () => {
        const fiber = Fiber.getCurrent()
        const scope =
          fiber === undefined
            ? "body"
            : Option.getOrElse(
                Option.map(Context.getOption(fiber.context, JobScope), (scope) => scope.name),
                () => "body",
              )
        const ordinal = ids.get(scope) ?? 0
        ids.set(scope, ordinal + 1)
        return CommandIds.derive(record.jobId, scope, "id", ordinal)
      },
      attempt,
      step,
      emit: Object.fromEntries(
        Object.entries<Event>(owner.actor.events).map(([event, schema]) => [
          event,
          (value: Decoded) =>
            Effect.flatMap(engine.channel(owner.address), (channel) =>
              PubSub.publish(channel.events, {
                event,
                value: Layouts.codec(schema.schema).encode(value),
              }),
            ),
        ]),
      ),
    }
    const payload = Layouts.codec(declaration.payload).decode(record.payload)
    const body: Effect.Effect<Decoded, Opaque> = Effect.suspend(
      (): Effect.Effect<Decoded, Opaque> => handler(payload, ctx),
    ).pipe(
      Effect.provideService(Client, jobTransport),
      Effect.provideContext(bound.registered.context),
      Effect.withSpan(SpanNames.job(owner.actor.name, record.job)),
    )
    const limited =
      declaration.timeout === undefined
        ? body
        : Effect.flatMap(Clock.currentTimeMillis, (now) =>
            body.pipe(
              Effect.timeoutOption(
                Math.max(
                  0,
                  record.at +
                    Duration.toMillis(Duration.fromInputUnsafe(declaration.timeout!)) -
                    now,
                ),
              ),
              Effect.flatMap(
                Option.match({ onNone: () => Effect.fail(timedOut), onSome: Effect.succeed }),
              ),
            ),
          )
    return Effect.flatMap(limited, () => {
      const missing = Array.from(record.steps.keys()).filter(
        (name) => !name.startsWith("\u0000") && !visited.has(name),
      )
      if (missing.length === 0) return Effect.void
      record.suspended = `missing completed steps: ${missing.join(", ")}`
      return Effect.interrupt
    })
  }

  const timedOut: Opaque = {}

  const causeOf = (cause: Cause.Cause<Opaque>): JobCause => {
    if (Cause.hasDies(cause)) return "Defect"
    const failure = Cause.findErrorOption(cause)
    if (Option.isSome(failure) && failure.value === timedOut) return "Timeout"
    return "Failed"
  }

  const run = (
    shard: number,
    record: JobRecord,
    previous: Latch.Latch,
    entered: Latch.Latch,
  ): Effect.Effect<void, ActorError> =>
    Effect.suspend(() => {
      let abandon = Effect.void
      return Effect.gen(function* () {
        if (record.done !== undefined) {
          yield* entered.open
          yield* retire(record.jobId)
          yield* journal(shard, Entry.cases.JobRetired.make({ jobId: record.jobId }))
          return
        }
        const owner = engine.durableImage(shard)?.actors.get(record.address)
        if (owner === undefined) return
        const declaration: Job | undefined = owner.actor.jobs[record.job]
        if (declaration === undefined) {
          record.suspended = `missing job declaration: ${record.job}`
          yield* entered.open
          return
        }
        yield* previous.await
        yield* Semaphore.withPermits(
          semaphore(shard, owner.actor.name, record.job, declaration.concurrency),
          1,
        )(
          Effect.gen(function* () {
            if (record.attempt === 0)
              yield* journal(
                shard,
                Entry.cases.Attempt.make({
                  jobId: record.jobId,
                  attempt: 1,
                  at: yield* Clock.currentTimeMillis,
                }),
              )
            yield* entered.open
            const context = yield* ShardWorkflowEngine.make.pipe(
              Effect.provideService(ShardWorkflowEngine.WorkflowJournal, {
                entries: () =>
                  record.workflow.map((entry) =>
                    Result.getOrThrow(
                      Schema.decodeUnknownResult(ShardWorkflowEngine.WorkflowRecord)(entry),
                    ),
                  ),
                append: (value) =>
                  journal(
                    shard,
                    Entry.cases.Workflow.make({
                      jobId: record.jobId,
                      value: ShardWorkflowEngine.workflowJson(value),
                    }),
                  ).pipe(Effect.orDie),
              }),
            )
            const adapter = Context.get(context, WorkflowEngine.WorkflowEngine)
            abandon = Context.get(context, ShardWorkflowEngine.WorkflowControl).crash
            const workflow = Workflow.make("AkterJob", {
              payload: {},
              idempotencyKey: () => record.jobId,
            })
            const body = Effect.gen(function* () {
              while (true) {
                const failed = record.failure
                if (failed !== undefined) {
                  if (failed.attempt >= declaration.retry.attempts) {
                    yield* deliverFailure(
                      record,
                      owner,
                      declaration,
                      failed.attempt,
                      failed.cause,
                      failed.ambiguous,
                    )
                    return
                  }
                  const now = yield* Clock.currentTimeMillis
                  yield* DurableClock.sleep({
                    name: `retry/${failed.attempt}`,
                    duration: Math.max(0, failed.retryAt - now),
                  })
                  yield* journal(
                    shard,
                    Entry.cases.Attempt.make({
                      jobId: record.jobId,
                      attempt: failed.attempt + 1,
                      at: yield* Clock.currentTimeMillis,
                    }),
                  )
                }
                const attempt = record.attempt
                const progress = new Set<string>()
                const exit = yield* Effect.exit(
                  attemptOnce(shard, record, owner, declaration, attempt, progress),
                )
                if (record.suspended !== undefined) return yield* Effect.interrupt
                if (Exit.isSuccess(exit)) {
                  yield* count(Metrics.jobs, { job: record.job, outcome: "success" }, 1)
                  return
                }
                if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt
                yield* journal(
                  shard,
                  Entry.cases.JobFailed.make({
                    jobId: record.jobId,
                    attempt,
                    cause: causeOf(exit.cause),
                    ambiguous: progress.size > 0,
                    retryAt:
                      (yield* Clock.currentTimeMillis) +
                      Duration.toMillis(Duration.fromInputUnsafe(declaration.retry.backoff)),
                  }),
                )
                yield* count(Metrics.jobs, { job: record.job, outcome: "failure" }, 1)
              }
            })
            yield* adapter.register(workflow, () => body.pipe(Effect.orDie))
            yield* adapter
              .execute(workflow, { executionId: record.jobId, payload: {} })
              .pipe(
                Effect.ensuring(Context.get(context, ShardWorkflowEngine.WorkflowControl).crash),
              )
            yield* journal(
              shard,
              Entry.cases.Done.make({
                jobId: record.jobId,
                outcome: record.failure === undefined ? "Succeeded" : "Failed",
              }),
            )
            yield* retire(record.jobId)
            yield* journal(shard, Entry.cases.JobRetired.make({ jobId: record.jobId }))
          }),
        )
      }).pipe(
        Effect.onInterrupt(() => abandon),
        Effect.scoped,
        Effect.provideService(JobOwner, { shard, generation: engine.generation(shard) }),
      )
    })

  const deliverFailure = (
    record: JobRecord,
    owner: ActorRecord,
    declaration: Job,
    attempts: number,
    cause: JobCause,
    ambiguous: boolean,
  ): Effect.Effect<void, ActorError> => {
    const member = declaration.onFailure
    const target: Action | undefined = owner.actor.actions[member]
    if (target === undefined) return Effect.void
    const fields = {
      job: record.jobId,
      declaration: record.job,
      payload: record.payload,
      attempts,
      cause,
      ambiguous,
    }
    const failure =
      record.key === undefined
        ? JobFailure.make(fields)
        : JobFailure.make({ ...fields, key: record.key })
    return (routing?.execute ?? engine.execute)({
      origin: Origin.cases.JobCall.make({ jobId: record.jobId }),
      commandId: CommandIds.derive(record.jobId, "onFailure"),
      actor: owner.actor,
      keyJson: owner.keyJson,
      member,
      payload: Layouts.codec(target.payload).encode(failure),
      caller: caller(record),
      connection: undefined,
    }).pipe(Transports.retryWhileUnavailable, Effect.asVoid)
  }

  const kick = (shard: number): Effect.Effect<void> =>
    Effect.suspend(() => {
      const image = engine.durableImage(shard)
      if (image === undefined) return Effect.void
      const generation = engine.generation(shard)
      const work: Array<Effect.Effect<void>> = []
      for (const record of image.jobs.values()) {
        if (record.suspended !== undefined) continue
        if (running.get(record.jobId) === generation) continue
        running.set(record.jobId, generation)
        const key = `${shard}/${generation}/${record.address.split("/")[0]}/${record.job}`
        const previous = queues.get(key) ?? Latch.makeUnsafe(true)
        const entered = Latch.makeUnsafe(false)
        queues.set(key, entered)
        work.push(
          engine.fork(
            shard,
            run(shard, record, previous, entered).pipe(
              Effect.ignore,
              Effect.ensuring(
                Effect.gen(function* () {
                  if (running.get(record.jobId) === generation) running.delete(record.jobId)
                  if (
                    record.suspended === undefined &&
                    engine.generation(shard) === generation &&
                    engine.durableImage(shard)?.jobs.has(record.jobId) === true
                  )
                    yield* engine.fork(
                      shard,
                      Effect.sleep("10 millis").pipe(Effect.andThen(kick(shard))),
                    )
                }),
              ),
            ),
          ),
        )
      }
      return Effect.all(work, { discard: true })
    })

  engine.afterDurable(kick)

  return {
    active: (): number => {
      let count = 0
      for (const shard of engine.shards())
        for (const job of engine.durableImage(shard.id)?.jobs.values() ?? [])
          if (job.suspended === undefined) count++
      return count
    },
    suspended: () =>
      engine
        .shards()
        .flatMap((shard) =>
          Array.from(engine.durableImage(shard.id)?.jobs.values() ?? []).flatMap((job) =>
            job.suspended === undefined
              ? []
              : [{ jobId: job.jobId, declaration: job.job, reason: job.suspended }],
          ),
        ),
  }
}

/** The job runner. */
export const Jobs = { install }
