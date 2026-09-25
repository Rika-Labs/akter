import { Cause, Effect, Exit, Option, Ref, Schema } from "effect"

/** Latency distribution in milliseconds. */
export interface Summary {
  readonly count: number
  readonly mean: number
  readonly min: number
  readonly p50: number
  readonly p90: number
  readonly p95: number
  readonly p99: number
  readonly max: number
}

const round = (value: number) => Math.round(value * 1000) / 1000

/** Nearest-rank percentiles, so every reported value is an observed sample. */
export const summarize = (samples: ReadonlyArray<number>): Summary => {
  if (samples.length === 0)
    return { count: 0, mean: 0, min: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0 }

  const sorted = Float64Array.from(samples).sort()

  const rank = (percentile: number) =>
    round(sorted[Math.min(sorted.length - 1, Math.ceil((percentile / 100) * sorted.length) - 1)]!)

  let total = 0

  for (const sample of sorted) total += sample

  return {
    count: sorted.length,
    mean: round(total / sorted.length),
    min: round(sorted[0]!),
    p50: rank(50),
    p90: rank(90),
    p95: rank(95),
    p99: rank(99),
    max: round(sorted[sorted.length - 1]!),
  }
}

export const now = Effect.sync(() => performance.now())

const Tagged = Schema.Struct({
  _tag: Schema.String,
  reason: Schema.optional(Schema.Struct({ _tag: Schema.String })),
})

/** `ActorError/Timeout`-style label for a failure, so a result says why operations failed. */
export const errorKind = <E>(cause: Cause.Cause<E>) => {
  const error = Cause.squash(cause)
  const tagged = Schema.decodeUnknownOption(Tagged)(error)

  if (Option.isNone(tagged)) return error instanceof Error ? error.name : "unknown"

  const { _tag, reason } = tagged.value

  return reason === undefined ? _tag : `${_tag}/${reason._tag}`
}

export interface LoadResult {
  readonly samples: ReadonlyArray<number>
  readonly elapsedMs: number
  readonly errors: number
  /** Failed operations by error tag and, for an `ActorError`, its reason. */
  readonly errorKinds: Readonly<Record<string, number>>
}

/**
 * Runs `workers` concurrent loops. Each loop claims the next operation index
 * until `operations` are claimed or `durationMs` passes, and times every
 * operation. Failures are counted, not retried, so they stay visible.
 */
export const load = <E, R>(options: {
  readonly workers: number
  readonly operations?: number
  readonly durationMs?: number
  readonly operation: (index: number) => Effect.Effect<unknown, E, R>
}) =>
  Effect.gen(function* () {
    const samples: Array<number> = []
    const next = yield* Ref.make(0)

    const failures = new Map<string, number>()

    const started = yield* now
    const deadline = options.durationMs === undefined ? Infinity : started + options.durationMs
    const limit = options.operations ?? Infinity

    const worker = Effect.gen(function* () {
      while (true) {
        const index = yield* Ref.getAndUpdate(next, (value) => value + 1)

        if (index >= limit || (yield* now) >= deadline) return
        const before = yield* now
        const exit = yield* Effect.exit(options.operation(index))
        const after = yield* now

        if (Exit.isSuccess(exit)) samples.push(after - before)
        else {
          const kind = errorKind(exit.cause)
          failures.set(kind, (failures.get(kind) ?? 0) + 1)
        }
      }
    })

    yield* Effect.forEach(Array.from({ length: options.workers }), () => worker, {
      concurrency: "unbounded",
      discard: true,
    })
    const elapsedMs = (yield* now) - started
    let errors = 0

    for (const count of failures.values()) errors += count

    return {
      samples,
      elapsedMs,
      errors,
      errorKinds: Object.fromEntries(failures),
    } satisfies LoadResult
  })

/** Operations per second over the measured wall-clock window. */
export const throughput = (result: LoadResult) =>
  Math.round((result.samples.length / result.elapsedMs) * 1000 * 10) / 10

/** A deterministic shuffle so first-touch order does not follow key order. */
export const shuffled = (length: number): Array<number> => {
  const order = Array.from({ length }, (_, index) => index)
  let state = length >>> 0

  for (let index = length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    const other = state % (index + 1)
    const swap = order[index]!
    order[index] = order[other]!
    order[other] = swap
  }

  return order
}
