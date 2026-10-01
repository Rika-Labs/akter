import { Cause, type Context, Effect, Exit, Option, Result, Schema } from "effect"
import type { ExecutorContext } from "../contexts/job.ts"
import { Tenant } from "../identity/caller.ts"
import type { AnyCommand } from "../members/command.ts"
import { type AnyJob, CancelledOutcome, type ProgressJob, type ProgressOf } from "../members/job.ts"
import { MAX_PROGRESS_BYTES } from "../runtime/jobs/progress.ts"
import type { JobRoute, RegisteredJob } from "../runtime/members.ts"
import type { Decoded, Handler } from "./codecs.ts"
import type { CompiledJob, Descriptor } from "./descriptor.ts"

const utf8 = new TextEncoder()

/** What the relay knows of a cancelled job whose provider call succeeded. */
interface CancelledSuccess {
  readonly jobId: string
  readonly attempts: number
  readonly outcome: { readonly _tag: "Succeeded"; readonly value: Decoded }
  readonly ambiguous: boolean
}

/** Encodes a value as a route command's payload. */
const routeCodec = (command: AnyCommand) => {
  const encode = Schema.encodeEffect(
    Schema.fromJsonString(Schema.toCodecJson(Schema.Struct({ value: command.payload }))),
  )

  return (value: Decoded) =>
    encode({ value }).pipe(Effect.map((payload): JobRoute => ({ command: command.tag, payload })))
}

/**
 * One job's registration. Only a typed failure proves the provider did not
 * apply the call; a defect, timeout, or interruption leaves the attempt's
 * outcome unknown. A result `onSuccess` cannot accept is dead-lettered rather
 * than executed again, since the provider already applied it, and a
 * cancelled job's result goes to `onCancelled`, as an unknown outcome when
 * that route cannot accept it. A stored payload that no longer decodes never
 * reaches the executor.
 */
const jobOf = (
  Executor: Context.Key<object, object>,
  { job, codec, policy }: CompiledJob,
  execute: Handler,
): RegisteredJob => {
  const onSuccess = policy.onSuccess === undefined ? undefined : routeCodec(policy.onSuccess)

  const onDeadLetter =
    policy.onDeadLetter === undefined ? undefined : routeCodec(policy.onDeadLetter)

  const onCancelled = policy.onCancelled === undefined ? undefined : routeCodec(policy.onCancelled)

  const cancelledRoute = (
    decoded: Decoded,
    letter: Parameters<RegisteredJob["cancelled"]>[2] | CancelledSuccess,
  ): Effect.Effect<JobRoute | undefined, Schema.SchemaError> =>
    onCancelled === undefined
      ? Effect.undefined
      : onCancelled({
          jobId: letter.jobId,
          job: decoded,
          attempts: letter.attempts,
          outcome: letter.outcome,
          ambiguous: letter.ambiguous,
        })

  const encodeProgress =
    job.progress === undefined
      ? undefined
      : Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.toCodecJson(job.progress)))

  return {
    attempts: policy.attempts,
    backoff: policy.backoff,
    progressEveryMs: encodeProgress === undefined ? undefined : policy.progressEveryMs,
    perActor: policy.perActor,
    routesCancelled: onCancelled !== undefined,
    execute: Effect.fnUntraced(function* (payload, version, attempt) {
      const decoded = yield* codec.decode(payload, version).pipe(
        Effect.mapError((error) => ({
          cause: error.message,
          ambiguous: false,
          notStarted: true,
        })),
      )

      const { report, reporting, ...identity } = attempt

      const progress = (target: AnyJob, frame: ProgressOf<ProgressJob>): Effect.Effect<void> =>
        !reporting()
          ? Effect.void
          : target !== job || encodeProgress === undefined
            ? Effect.logWarning("Progress frame does not match the running job")
            : encodeProgress(frame).pipe(
                Effect.map((json) => utf8.encode(json)),
                Effect.matchEffect({
                  onFailure: (error) =>
                    Effect.logWarning("Progress frame did not encode", String(error)),
                  onSuccess: (bytes) =>
                    bytes.length > MAX_PROGRESS_BYTES
                      ? Effect.logWarning("Progress frame exceeds 4 KiB")
                      : report(bytes),
                }),
                Effect.catchDefect((defect) =>
                  Effect.logWarning("Progress frame did not encode", String(defect)),
                ),
              )

      const context: ExecutorContext = {
        jobId: identity.jobId,
        attempt: identity.attempt,
        principal: identity.principal,
        ref: identity.ref,
        progress,
      }

      const exit = yield* execute(decoded).pipe(
        Effect.timeoutOrElse({
          duration: policy.timeoutMs,
          orElse: () => Effect.die(new Error(`Executor timed out after ${policy.timeoutMs} ms`)),
        }),
        Effect.provideService(Executor, context),
        Effect.provideService(Tenant, context.ref.tenant),
        Effect.exit,
      )

      if (Exit.isFailure(exit))
        return yield* Effect.fail({
          cause: Cause.pretty(exit.cause),
          ambiguous:
            !Cause.hasFails(exit.cause) ||
            Cause.hasDies(exit.cause) ||
            Cause.hasInterrupts(exit.cause),
        })

      const cancelled =
        onCancelled === undefined
          ? undefined
          : yield* cancelledRoute(decoded, {
              jobId: context.jobId,
              attempts: context.attempt,
              outcome: CancelledOutcome.cases.Succeeded.make({ value: exit.value }),
              ambiguous: false,
            }).pipe(
              Effect.catch((error) =>
                cancelledRoute(decoded, {
                  jobId: context.jobId,
                  attempts: context.attempt,
                  outcome: CancelledOutcome.cases.Unknown.make({
                    cause: `The onCancelled route cannot accept the result: ${String(error)}`,
                  }),
                  ambiguous: true,
                }),
              ),
              Effect.orDie,
            )

      if (onSuccess === undefined) return { success: undefined, cancelled, rejected: undefined }

      const success = yield* onSuccess(exit.value).pipe(Effect.result)

      if (Result.isFailure(success))
        return {
          success: undefined,
          cancelled,
          rejected: {
            cause: `The onSuccess route cannot accept the result: ${String(success.failure)}`,
            ambiguous: true,
            final: true,
          },
        }

      return { success: success.success, cancelled, rejected: undefined }
    }) as RegisteredJob["execute"],
    cancelled: Effect.fnUntraced(function* (payload, version, letter) {
      const decoded = yield* codec.decode(payload, version).pipe(Effect.option)

      if (Option.isNone(decoded)) return undefined

      return yield* cancelledRoute(decoded.value, letter)
    }, Effect.orDie),
    deadLetter: Effect.fnUntraced(function* (payload, version, letter) {
      const decoded = yield* codec.decode(payload, version).pipe(Effect.option)

      if (onDeadLetter === undefined || Option.isNone(decoded)) return undefined

      return yield* onDeadLetter({
        jobId: letter.jobId,
        job: decoded.value,
        attempts: letter.attempts,
        cause: letter.cause,
        ambiguous: letter.ambiguous,
      })
    }, Effect.orDie),
  }
}

/** Every declared job's registration; a job without an executor is a defect of the layer. */
export const jobsOf = ({
  descriptor,
  Executor,
  executors,
}: {
  readonly descriptor: Descriptor
  readonly Executor: Context.Key<object, object>
  readonly executors: Readonly<Record<string, Handler>>
}) =>
  Effect.gen(function* () {
    const registered = new Map<string, RegisteredJob>()

    for (const compiled of descriptor.jobs.values()) {
      const execute = executors[compiled.job.tag]

      if (execute === undefined)
        return yield* Effect.die(new Error(`Missing executor ${compiled.job.tag}`))

      registered.set(compiled.job.tag, jobOf(Executor, compiled, execute))
    }

    return registered as ReadonlyMap<string, RegisteredJob>
  })
