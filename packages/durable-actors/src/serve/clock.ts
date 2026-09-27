import { Effect } from "effect"
import { InternalActors } from "../handles/actors.ts"

const SAMPLE_EVERY = "10 seconds"

// A sample older than this is replaced even if its round trip was shorter.
const STALE_MS = 60_000

interface Sample {
  readonly offset: number
  readonly rtt: number
  readonly at: number
}

/**
 * The database clock without a database read per request: an offset from the
 * monotonic clock, resampled every 10 seconds, keeping the sample with the
 * shortest round trip, so the estimate is off by at most that round trip.
 */
export const databaseClock = Effect.gen(function* () {
  const actors = yield* InternalActors

  const sample = Effect.gen(function* () {
    const sent = performance.now()
    const database = yield* actors.databaseNow
    const received = performance.now()

    return { offset: database - (sent + received) / 2, rtt: received - sent, at: received }
  })

  let best: Sample = yield* sample.pipe(Effect.orDie)

  yield* sample.pipe(
    Effect.delay(SAMPLE_EVERY),
    Effect.tap((next) =>
      Effect.sync(() => {
        if (next.rtt <= best.rtt || next.at - best.at >= STALE_MS) best = next
      }),
    ),
    Effect.ignore,
    Effect.forever,
    Effect.forkScoped,
  )

  return { now: () => Math.round(performance.now() + best.offset) }
})
