import type { DateTime, Duration, Effect, Option } from "effect"
import type { ActorRef, Principal } from "../identity/caller.ts"
import type { AnyJob, ProgressJob, ProgressOf } from "../members/job.ts"

/** How `turn.enqueue` names and schedules a job. */
export interface EnqueueOptions {
  /**
   * Names the job within its actor, 1-200 characters. Enqueueing another job
   * with the same key replaces this one when the turn commits, as
   * `turn.cancelJob(key)` would.
   */
  readonly key?: string
  /** Runs no earlier than `after` past the turn's commit. */
  readonly after?: Duration.Input
  /** Runs no earlier than `at`, measured on the database clock. */
  readonly at?: DateTime.DateTime
}

/** The part of a command turn that stages jobs; see `X.Turn`. */
export interface EnqueueContext<J extends AnyJob> {
  /**
   * Stages `job` in this turn. It is executed only after the turn commits,
   * and a declared failure or rollback discards it.
   */
  readonly enqueue: (job: J["Type"], options?: EnqueueOptions) => Effect.Effect<void>
  /**
   * Cancels this actor's job with `key` when the turn commits. One that never
   * started is removed; one that started is never attempted again and reports
   * what is known of it to `onCancelled`.
   */
  readonly cancelJob: (key: string) => Effect.Effect<void>
}

/** The context of one executor attempt, obtained with `yield* X.Executor`. */
export interface ExecutorContext<J extends AnyJob = AnyJob> {
  /** Stable across every attempt; use it as the provider's idempotency key. */
  readonly jobId: string
  /** 1 on the first attempt; a later attempt may follow one whose outcome is unknown. */
  readonly attempt: number
  /** The principal of the turn that enqueued the job. */
  readonly principal: Option.Option<Principal>
  /** The actor that enqueued the job. */
  readonly ref: ActorRef
  /**
   * Reports a transient progress frame of the running job `job`. It never
   * fails or waits and never changes the outcome: a frame that does not
   * encode, exceeds 4 KiB, names another job, or runs after the attempt ended
   * is dropped. Frames are coalesced and may be lost; they are never state,
   * events, or receipts.
   */
  progress<P extends Extract<J, ProgressJob>>(job: P, frame: ProgressOf<P>): Effect.Effect<void>
}
