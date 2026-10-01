import { Duration, Option } from "effect"
import type { ActorError } from "../errors/actor.ts"

const CAP_MS = 500

/**
 * The wait before retry `attempt` (0 for the first) of a delivery that failed
 * with the given error: its own `retryAfter`, doubling on each attempt, capped at the
 * greater of 500 ms and that first wait.
 */
export const retryDelay =
  (attempt: number) =>
  (error: ActorError): Duration.Duration => {
    const first = Option.getOrElse(error.retryAfter, () => 10)

    return Duration.millis(Math.min(first * 2 ** attempt, Math.max(first, CAP_MS)))
  }
