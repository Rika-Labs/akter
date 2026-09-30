import { type Duration, Schema } from "effect"
import type { AnyCommand, PayloadFields, ValueSchema } from "./command.ts"
import { declareChain, type PayloadMigrations } from "./payload.ts"

/**
 * An `Actor.job` value: a schema-backed class of requests for external I/O
 * that a turn stages with `turn.enqueue` and an executor runs after commit.
 * Its instances are the job's payload; `success` types the executor's return
 * value and `progress` its transient frames.
 */
export type JobClass<
  Tag extends string,
  Fields extends PayloadFields,
  Success extends ValueSchema,
  Progress extends ValueSchema | undefined = undefined,
> = Schema.Class<Schema.TaggedStruct<Tag, Fields>["Type"], Schema.TaggedStruct<Tag, Fields>, {}> & {
  readonly tag: Tag
  readonly success: Success
  readonly progress: Progress
}

/** Any job, as a `jobs` binding names it. */
export type AnyJob = ValueSchema & {
  readonly tag: string
  readonly success: ValueSchema
  readonly progress: ValueSchema | undefined
  readonly Type: { readonly _tag: string }
}

/** A job that declares a `progress` schema. */
export type ProgressJob = AnyJob & { readonly progress: ValueSchema }

/** The frame type an executor of `J` reports with `X.Executor.progress`. */
export type ProgressOf<J extends ProgressJob> = J["progress"]["Type"]

/**
 * `Actor.job`: declares a job class. `payload` holds its record fields;
 * `success` is the schema of the executor's return value and defaults to
 * `Schema.Void`. `progress`, when declared, is the schema of the transient
 * frames its executor may report before the result commits; they are never
 * state. `migrations` upcasts payloads stored at older versions before each
 * attempt and before a dead letter's route; `writeVersion` is as for events.
 * The value is itself the class: `Charge.make(...)`, `new Charge(...)`, and
 * `instanceof` all work, and one job may be bound by several actors.
 *
 * @example
 * const Charge = Actor.job("Charge", {
 *   payload: { amount: Schema.Int },
 *   success: Schema.Struct({ providerId: Schema.String }),
 * })
 */
export const job = <
  const Tag extends string,
  const Fields extends PayloadFields = {},
  Success extends ValueSchema = Schema.Void,
  Progress extends ValueSchema | undefined = undefined,
>(
  tag: Tag,
  options?: {
    readonly payload?: Fields
    readonly success?: Success
    readonly progress?: Progress
    readonly migrations?: PayloadMigrations
    readonly writeVersion?: number
  },
): JobClass<Tag, Fields, Success, Progress> => {
  if (tag.length === 0) throw new Error("Actor.job needs a non-empty tag")
  const fields = options?.payload ?? ({} as Fields)
  const declared: Schema.Class<
    Schema.TaggedStruct<Tag, Fields>["Type"],
    Schema.TaggedStruct<Tag, Fields>,
    {}
  > = Schema.TaggedClass<Schema.TaggedStruct<Tag, Fields>["Type"]>()(tag, fields) as never
  declareChain({ schema: declared, label: `Job ${tag}`, fields, options })

  return Object.assign(declared, {
    tag,
    success: (options?.success ?? Schema.Void) as Success,
    progress: options?.progress as Progress,
  })
}

/**
 * The payload of an `onDeadLetter` command. `ambiguous` is true when the last
 * attempt ended without a known outcome (a crash, timeout, interruption, or
 * defect), so the provider may still have applied it.
 */
export const DeadLetter = <J extends AnyJob>(job: J) =>
  Schema.Struct({
    jobId: Schema.String,
    job,
    attempts: Schema.Int,
    cause: Schema.String,
    ambiguous: Schema.Boolean,
  })

/** The decoded payload of an `onDeadLetter` command for job `J`. */
export type DeadLetter<J extends AnyJob> = ReturnType<typeof DeadLetter<J>>["Type"]

/**
 * The payload of an `onCancelled` command: what is known of a cancelled job.
 * `Succeeded` carries the provider's result; `Failed` is reported only when no
 * attempt can have applied the call; every other case is `Unknown`, with
 * `ambiguous` true, because the provider may have acted.
 */
export const Cancelled = <J extends AnyJob>(job: J) =>
  Schema.Struct({
    jobId: Schema.String,
    job,
    attempts: Schema.Int,
    outcome: Schema.TaggedUnion({
      Succeeded: { value: job.success },
      Failed: { cause: Schema.String },
      Unknown: { cause: Schema.String },
    }),
    ambiguous: Schema.Boolean,
  })

/** The decoded payload of an `onCancelled` command for job `J`. */
export type Cancelled<J extends AnyJob> = ReturnType<typeof Cancelled<J>>["Type"]

/** A cancelled job's outcome before its route decodes `value`. */
export const CancelledOutcome = Schema.TaggedUnion({
  Succeeded: { value: Schema.Unknown },
  Failed: { cause: Schema.String },
  Unknown: { cause: Schema.String },
})

/** Commands whose payload accepts `T`. */
type Accepting<Command extends AnyCommand, T> = Command extends AnyCommand
  ? [T] extends [Command["payload"]["Type"]]
    ? Command
    : never
  : never

/**
 * One actor's binding of a job: the job it enqueues and how this actor runs
 * and routes it. Routes name commands of this actor whose payload accepts the
 * executor's return value, the job's dead letter, or its cancellation; two
 * actors may bind one job with different routes and limits.
 */
export interface JobBinding<J extends AnyJob, Command extends AnyCommand> {
  readonly job: J
  /** Bounds one executor attempt, measured on the runner. Default 30 seconds. */
  readonly timeout?: Duration.Input
  /**
   * The least time between two progress frames one attempt sends; frames
   * reported sooner replace the one waiting. Default 250 milliseconds, from
   * 50 milliseconds to 1 minute.
   */
  readonly progressEvery?: Duration.Input
  /**
   * Retries after the first failed attempt (default 3), and the wait after
   * failed attempt `n`: `min(base × 2^(n − 1), max)`. Default base 1 second,
   * max 256 seconds. Retries are persisted, not process-local sleeps.
   */
  readonly retry?: {
    readonly times: number
    readonly backoff?: { readonly base: Duration.Input; readonly max: Duration.Input }
  }
  /** Receives the executor's return value, with the job id as its command id. */
  readonly onSuccess?: Accepting<Command, J["success"]["Type"]>
  /** Receives `Actor.DeadLetter(J)` once when retries are exhausted. */
  readonly onDeadLetter?: Accepting<Command, DeadLetter<J>>
  /**
   * Receives `Actor.Cancelled(J)` once for a job cancelled after an attempt
   * started, with the job id as its command id.
   */
  readonly onCancelled?: Accepting<Command, Cancelled<J>>
  /**
   * Attempts of this job running at once for one actor, across every
   * runner: an integer from 1 to 64. Unlimited when omitted.
   */
  readonly concurrency?: { readonly perActor: number }
}

/** Any job binding, whatever its job and routes. */
export type AnyJobBinding = JobBinding<AnyJob, AnyCommand>
