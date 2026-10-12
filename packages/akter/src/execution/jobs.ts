import {
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  Option,
  Predicate,
  PubSub,
  Schema,
  Semaphore,
} from "effect"
import { System } from "../contract/caller.ts"
import { ActorError, InvalidInput } from "../contract/errors.ts"
import { Client, Handles } from "../contract/handle.ts"
import type { Reply, Transport } from "../contract/handle.ts"
import { JobFailure } from "../contract/members.ts"
import type { Action, Event, Job, MemberSchema } from "../contract/members.ts"
import { CommandIds } from "./command-ids.ts"
import { Durable } from "./durable.ts"
import type { ActorRecord, JobRecord } from "./durable.ts"
import type { Engine } from "./engine.ts"
import { Entry, Origin } from "./entries.ts"
import { Layouts } from "./layout.ts"
import type { Decoded } from "./layout.ts"
import { Transports } from "./transport.ts"

/** The scope a job call is made in: a step's name, or `body`, with its call ordinal. */
interface Scope {
  readonly name: string
  next: number
}

/** The enclosing step of a job call. */
class JobScope extends Context.Service<JobScope, Scope>()(
  "@rikalabs/akter/execution/jobs/JobScope",
) {}

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

const bodyCall = (attempt: number, ordinal: number): string =>
  `\u0000call\u0000${attempt}\u0000${ordinal}`

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
const install = (engine: Engine) => {
  const running = new Map<string, number>()
  const permits = new Map<string, Semaphore.Semaphore>()

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
    engine.journal(shard, entry).pipe(Transports.retryWhileUnavailable)

  const retire = (jobId: string): Effect.Effect<void> =>
    Effect.forEach(
      Array.from({ length: engine.catalog.shards }, (_, id) => id),
      (id) =>
        engine.durableImage(id)?.calls.has(jobId) === true
          ? journal(id, Entry.cases.Retired.make({ jobId })).pipe(Effect.ignore)
          : Effect.void,
      { discard: true },
    )

  const caller = (record: JobRecord) =>
    System.make({
      source: "job",
      subject: `job:${record.jobId}`,
      ref: record.address,
      onBehalfOf: record.onBehalfOf,
    })

  /** The transport a job attempt's handles use: calls get derived ids, reads go to the engine. */
  const transport = (record: JobRecord, owner: ActorRecord, attempt: number): Transport => {
    const body: Scope = { name: "body", next: 0 }
    const call: Transport["call"] = (request) =>
      Effect.gen(function* () {
        const scope = Option.getOrElse(yield* Effect.serviceOption(JobScope), () => body)
        const ordinal = scope.next++
        const key = bodyCall(attempt, ordinal)
        const journaled = scope.name === "body" ? record.steps.get(key) : undefined
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
        const outcome = yield* engine
          .execute({
            origin: Origin.cases.JobCall.make({ jobId: record.jobId }),
            commandId: CommandIds.derive(record.jobId, scope.name, attempt, ordinal),
            actor: request.actor,
            keyJson: request.id,
            member: request.member,
            payload: request.payload,
            caller: caller(record),
            connection: undefined,
          })
          .pipe(Transports.retryWhileUnavailable)
        const reply: Reply = yield* Transports.reply(request.actor, request.member, outcome)
        if (scope.name === "body")
          yield* journal(
            engine.shardOf(record.address),
            Entry.cases.Step.make({ jobId: record.jobId, name: key, attempt, value: reply }),
          )
        return reply
      })
    return { call, ...Transports.reads(engine, caller(record)) }
  }

  const attemptOnce = (
    shard: number,
    record: JobRecord,
    owner: ActorRecord,
    declaration: Job,
    attempt: number,
    progress: { inStep: boolean },
  ): Effect.Effect<void, Opaque> => {
    const bound = Durable.bound(engine.catalog, owner.actor.name)
    const handler = bound.registered.handlers.get(record.job)
    if (handler === undefined) return Effect.die(new Error(`no handler for job ${record.job}`))
    const jobTransport = transport(record, owner, attempt)
    let ids = 0
    const step = (
      name: string,
      first: Decoded,
      second?: Decoded,
    ): Effect.Effect<Decoded, Opaque, Opaque> => {
      const schema: MemberSchema | undefined = second === undefined ? undefined : first
      const effect: Effect.Effect<Decoded, Opaque, Opaque> = second === undefined ? first : second
      return Effect.suspend(() => {
        const journaled = record.steps.get(name)
        const codec = schema === undefined ? undefined : Layouts.codec(schema)
        if (journaled !== undefined) {
          const value = fromStepValue(journaled)
          return Effect.succeed(codec === undefined ? value : codec.decode(value))
        }
        progress.inStep = true
        return effect.pipe(
          Effect.provideService(JobScope, { name, next: 0 }),
          Effect.tap((value) => {
            progress.inStep = false
            return journal(
              shard,
              Entry.cases.Step.make({
                jobId: record.jobId,
                name,
                attempt,
                value: stepValue(codec === undefined ? value : codec.encode(value)),
              }),
            ).pipe(Effect.orDie)
          }),
        )
      })
    }
    const ctx = {
      self: Handles.derive({ actor: owner.actor, id: owner.keyJson, self: true }, jobTransport),
      id: () => CommandIds.derive(record.jobId, "id", ids++),
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
    )
    const limited =
      declaration.timeout === undefined
        ? body
        : body.pipe(
            Effect.timeoutOption(declaration.timeout),
            Effect.flatMap(
              Option.match({ onNone: () => Effect.fail(timedOut), onSome: Effect.succeed }),
            ),
          )
    return Effect.asVoid(limited)
  }

  const timedOut: Opaque = {}

  const causeOf = (cause: Cause.Cause<Opaque>): JobCause => {
    if (Cause.hasDies(cause)) return "Defect"
    const failure = Cause.findErrorOption(cause)
    if (Option.isSome(failure) && failure.value === timedOut) return "Timeout"
    return "Failed"
  }

  const run = (shard: number, record: JobRecord): Effect.Effect<void, ActorError> =>
    Effect.gen(function* () {
      const owner = engine.durableImage(shard)?.actors.get(record.address)
      if (owner === undefined) return
      const declaration: Job | undefined = owner.actor.jobs[record.job]
      if (declaration === undefined) return
      yield* Semaphore.withPermits(
        semaphore(shard, owner.actor.name, record.job, declaration.concurrency),
        1,
      )(
        Effect.gen(function* () {
          let attempt = record.attempt
          if (attempt === 0) {
            attempt = 1
            yield* journal(shard, Entry.cases.Attempt.make({ jobId: record.jobId, attempt }))
          }
          while (true) {
            const progress = { inStep: false }
            const exit = yield* Effect.exit(
              attemptOnce(shard, record, owner, declaration, attempt, progress),
            )
            if (Exit.isSuccess(exit)) {
              yield* journal(
                shard,
                Entry.cases.Done.make({ jobId: record.jobId, outcome: "Succeeded" }),
              )
              yield* retire(record.jobId)
              return
            }
            if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt
            if (attempt < declaration.retry.attempts) {
              yield* Effect.sleep(Duration.fromInputUnsafe(declaration.retry.backoff))
              attempt++
              yield* journal(shard, Entry.cases.Attempt.make({ jobId: record.jobId, attempt }))
              continue
            }
            yield* deliverFailure(
              record,
              owner,
              declaration,
              attempt,
              causeOf(exit.cause),
              progress.inStep,
            )
            yield* journal(shard, Entry.cases.Done.make({ jobId: record.jobId, outcome: "Failed" }))
            yield* retire(record.jobId)
            return
          }
        }),
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
    return engine
      .execute({
        origin: Origin.cases.JobCall.make({ jobId: record.jobId }),
        commandId: CommandIds.derive(record.jobId, "onFailure"),
        actor: owner.actor,
        keyJson: owner.keyJson,
        member,
        payload: Layouts.codec(target.payload).encode(failure),
        caller: caller(record),
        connection: undefined,
      })
      .pipe(Transports.retryWhileUnavailable, Effect.asVoid)
  }

  engine.afterDurable((shard) =>
    Effect.suspend(() => {
      const image = engine.durableImage(shard)
      if (image === undefined) return Effect.void
      const generation = engine.generation(shard)
      const work: Array<Effect.Effect<void>> = []
      for (const record of image.jobs.values()) {
        if (running.get(record.jobId) === generation) continue
        running.set(record.jobId, generation)
        work.push(
          engine.fork(
            shard,
            run(shard, record).pipe(
              Effect.ignore,
              Effect.ensuring(
                Effect.sync(() => {
                  if (running.get(record.jobId) === generation) running.delete(record.jobId)
                }),
              ),
            ),
          ),
        )
      }
      return Effect.all(work, { discard: true })
    }),
  )

  return {
    active: (): number => {
      let count = 0
      for (const [jobId, generation] of running) {
        const shard = engine
          .shards()
          .find(
            (candidate) =>
              candidate.status === "open" && engine.durableImage(candidate.id)?.jobs.has(jobId),
          )
        if (shard !== undefined && shard.generation === generation) count++
      }
      return count
    },
  }
}

/** The job runner. */
export const Jobs = { install }
