import { ActorError, type Failure, NotCreated } from "@rikalabs/akter/client"
import { Effect, Schedule, Schema } from "effect"

/** How long a read of an actor no command has created yet waits before asking again. */
const NOT_CREATED_RETRY = "500 millis"

const isNotCreated = (failure: Failure) =>
  Schema.is(ActorError)(failure) && Schema.is(NotCreated)(failure.reason)

/** Succeeds once `signal` aborts, at once when it already has. */
const aborted = (signal: AbortSignal) =>
  Effect.callback<void>((resume) => {
    if (signal.aborted) return resume(Effect.void)

    const onAbort = () => resume(Effect.void)
    signal.addEventListener("abort", onAbort, { once: true })

    return Effect.sync(() => signal.removeEventListener("abort", onAbort))
  })

/**
 * Runs `follow`, a feed or watch iteration, again every 500 ms while it ends
 * with `NotCreated`, so a component can mount before the command that creates
 * its actor. The Promise client itself reports `NotCreated` as final; waiting
 * is this hook package's documented choice. Resolves with the failure that
 * ended it otherwise, or `undefined` when it finished or `signal` aborted,
 * including while waiting, after which `follow` is never started again.
 */
export const followCreated = (
  signal: AbortSignal,
  follow: () => Promise<void>,
): Promise<Failure | undefined> =>
  Effect.runPromise(
    Effect.raceFirst(
      Effect.tryPromise({ try: follow, catch: (thrown) => thrown as Failure }).pipe(
        Effect.retry({ while: isNotCreated, schedule: Schedule.spaced(NOT_CREATED_RETRY) }),
        Effect.as(undefined),
        Effect.catch((failure) => Effect.succeed(failure)),
      ),
      aborted(signal).pipe(Effect.as(undefined)),
    ),
  )
