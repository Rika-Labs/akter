import { Duration } from "effect"
import type { AnyCommand } from "../members/command.ts"
import type { AnyEffect, EffectPolicy } from "../members/effect.ts"

/** Retries after a job's first failed attempt when its binding names none. */
const DEFAULT_RETRIES = 3

/** An attempt that runs longer is abandoned and counts as an unknown outcome. */
const DEFAULT_TIMEOUT_MS = 30_000

const DEFAULT_BACKOFF = { baseMs: 1000, maxMs: 256_000 } as const

const PROGRESS_EVERY_MS = { default: 250, min: 50, max: 60_000 } as const

const TIMER = { min: 1, max: 2_147_483_647, label: "1 millisecond to 2147483647 milliseconds" }

/** A job binding with every default applied and every duration in whole milliseconds. */
export interface JobPolicy {
  /** The first attempt plus its retries. */
  readonly attempts: number
  readonly timeoutMs: number
  readonly backoff: { readonly baseMs: number; readonly maxMs: number }
  readonly progressEveryMs: number
  readonly perActor: number | undefined
  readonly onSuccess: AnyCommand | undefined
  readonly onDeadLetter: AnyCommand | undefined
  readonly onCancelled: AnyCommand | undefined
}

/** Job timings are timer durations: 1 ms to 2^31 − 1 ms unless `bounds` narrows them. */
const millis = (
  path: string,
  duration: Duration.Input,
  bounds: { readonly min: number; readonly max: number; readonly label: string } = TIMER,
) => {
  const value = Duration.toMillis(Duration.fromInputUnsafe(duration))

  if (!Number.isFinite(value) || value < bounds.min || value > bounds.max)
    throw new Error(`${path} must be a duration from ${bounds.label}`)

  return Math.floor(value)
}

/**
 * Resolves one declared job's binding, throwing on a route that is not one of
 * `commands`, a `concurrency.perActor` outside 1..64, `retry.times` outside
 * 0..100, a duration outside its bounds, or a backoff whose max is below its
 * base. `path` names the binding in those messages.
 */
export const resolveJobPolicy = ({
  path,
  declared,
  commands,
}: {
  readonly path: string
  readonly declared: EffectPolicy<AnyEffect, AnyCommand> | undefined
  readonly commands: ReadonlyArray<AnyCommand>
}): JobPolicy => {
  for (const route of [declared?.onSuccess, declared?.onDeadLetter, declared?.onCancelled])
    if (route !== undefined && !commands.includes(route))
      throw new Error(`${path} routes must name a command of this actor`)

  const perActor = declared?.concurrency?.perActor

  if (
    declared?.concurrency !== undefined &&
    (perActor === undefined || !Number.isInteger(perActor) || perActor < 1 || perActor > 64)
  )
    throw new Error(`${path}.concurrency.perActor must be an integer from 1 to 64`)

  const times = declared?.retry?.times ?? DEFAULT_RETRIES

  if (!Number.isInteger(times) || times < 0 || times > 100)
    throw new Error(`${path}.retry.times must be an integer from 0 to 100`)

  const backoff = declared?.retry?.backoff

  const resolved: JobPolicy = {
    attempts: 1 + times,
    timeoutMs:
      declared?.timeout === undefined
        ? DEFAULT_TIMEOUT_MS
        : millis(`${path}.timeout`, declared.timeout),
    backoff:
      backoff === undefined
        ? DEFAULT_BACKOFF
        : {
            baseMs: millis(`${path}.retry.backoff.base`, backoff.base),
            maxMs: millis(`${path}.retry.backoff.max`, backoff.max),
          },
    progressEveryMs:
      declared?.progressEvery === undefined
        ? PROGRESS_EVERY_MS.default
        : millis(`${path}.progressEvery`, declared.progressEvery, {
            min: PROGRESS_EVERY_MS.min,
            max: PROGRESS_EVERY_MS.max,
            label: "50 milliseconds to 1 minute",
          }),
    perActor,
    onSuccess: declared?.onSuccess,
    onDeadLetter: declared?.onDeadLetter,
    onCancelled: declared?.onCancelled,
  }

  if (resolved.backoff.maxMs < resolved.backoff.baseMs)
    throw new Error(`${path}.retry.backoff.max must be at least its base`)

  return Object.freeze(resolved)
}
