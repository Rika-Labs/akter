import { Duration, Effect, Schema, type Scope } from "effect"
import { ActorError, ActorUnavailable } from "../errors/actor.ts"

/**
 * The cause of an `ActorUnavailable` that refused a command before it reached
 * any queue: the runner could not admit it within its admission wait, or the
 * actor's activation already held its limit of waiting commands. Nothing of
 * the command ran.
 */
export const overloaded = (queue: "runner" | "activation") =>
  ActorError.make({
    reason: ActorUnavailable.make({
      overloaded: true,
      cause: new Error(
        queue === "runner"
          ? "The runner holds its limit of commands in flight"
          : "The activation holds its limit of waiting commands",
      ),
    }),
  })

/** Whether `error` is a refusal for overload, which a delivery never retries in place. */
export const isOverloaded = (error: ActorError) =>
  Schema.is(ActorUnavailable)(error.reason) && error.reason.overloaded === true

interface Waiter {
  granted: boolean
  readonly resume: () => void
}

/**
 * Admits at most `limit` effects at once. The next `limit` callers wait for a
 * slot in arrival order, each for at most `wait`; a caller past them, or one
 * whose wait runs out, is refused with `ActorUnavailable`. Work past what the
 * runner can serve therefore waits in its callers' retries instead of in the
 * runner's mailboxes and pool queues, while a burst shorter than `wait` is
 * absorbed rather than refused. A refusal happens before the effect starts, so
 * a refused command never reaches admission, a mailbox, or a turn.
 *
 * A slot freed while callers wait goes straight to the oldest, never back to
 * the free count, so a newcomer cannot overtake a waiter. A waiter whose wait
 * ends after it was handed a slot passes the slot on, so a slot is never lost.
 */
export const admissionLimit = ({
  limit,
  wait,
}: {
  readonly limit: number
  readonly wait: Duration.Duration
}) => {
  let free = limit
  const waiters = new Set<Waiter>()

  const release = Effect.sync(() => {
    const next = waiters.values().next()

    if (next.done === true) {
      free += 1
      return
    }

    waiters.delete(next.value)
    next.value.granted = true
    next.value.resume()
  })

  const enter = (restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>) =>
    Effect.suspend((): Effect.Effect<void, ActorError> => {
      if (free > 0) {
        free -= 1
        return Effect.void
      }

      if (Duration.isZero(wait) || waiters.size >= limit) return Effect.fail(overloaded("runner"))

      let waiter: Waiter | undefined

      return restore(
        Effect.callback<void>((resume) => {
          const queued: Waiter = { granted: false, resume: () => resume(Effect.void) }
          waiter = queued
          waiters.add(queued)

          return Effect.sync(() => {
            waiters.delete(queued)
          })
        }).pipe(
          Effect.onInterrupt(() => (waiter?.granted === true ? release : Effect.void)),
          Effect.timeoutOrElse({
            duration: wait,
            orElse: () => Effect.fail(overloaded("runner")),
          }),
        ),
      )
    })

  return {
    /** Whether the next caller would be refused without waiting. */
    full: () => free === 0 && (Duration.isZero(wait) || waiters.size >= limit),
    /** Holds a slot until its scope closes, including after the acquiring fiber stops waiting. */
    take: Effect.uninterruptibleMask((restore) =>
      Effect.andThen(
        enter(restore),
        Effect.addFinalizer(() => release),
      ),
    ) satisfies Effect.Effect<void, ActorError, Scope.Scope>,
    admit: <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | ActorError, R> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.andThen(enter(restore), restore(effect).pipe(Effect.ensuring(release))),
      ),
  }
}
