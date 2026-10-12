import { Clock, Effect, Semaphore } from "effect"
import { ActorError, ActorUnavailable } from "../errors/actor.ts"
import { InternalActors } from "../runtime/actors.ts"

const SAMPLE_EVERY = "10 seconds"

/** A sample older than this is replaced even if its round trip was shorter. */
const STALE_MS = 60_000
const DISCONTINUITY_MS = 250

interface Sample {
  readonly offset: number
  readonly rtt: number
  readonly at: number
  readonly wall: number
}

/**
 * The database clock without a database read per request: an offset from the
 * monotonic clock, resampled every 10 seconds, keeping the sample with the
 * shortest round trip. Wall-clock divergence or an old sample forces a new
 * database read before exposing time, because suspension can pause or reset
 * the monotonic clock without pausing the database.
 */
export const sampledDatabaseClock = Effect.fnUntraced(function* (
  databaseNow: Effect.Effect<number, ActorError>,
) {
  const wallClock = yield* Clock.Clock

  const sample = Effect.gen(function* () {
    const sent = performance.now()
    const wall = wallClock.currentTimeMillisUnsafe()
    const database = yield* databaseNow
    const received = performance.now()
    const receivedWall = wallClock.currentTimeMillisUnsafe()
    const rtt = received - sent

    if (rtt < 0 || Math.abs(receivedWall - wall - rtt) > DISCONTINUITY_MS)
      return yield* ActorError.make({
        reason: ActorUnavailable.make({
          cause: new Error("The clock changed while sampling database time"),
        }),
      })

    return {
      offset: database - (sent + received) / 2,
      rtt,
      at: received,
      wall: receivedWall,
    }
  })

  let best: Sample = yield* sample.pipe(Effect.orDie)
  const sampling = Semaphore.makeUnsafe(1)

  const stale = () => {
    const elapsed = performance.now() - best.at
    return (
      elapsed < 0 ||
      elapsed >= STALE_MS ||
      Math.abs(wallClock.currentTimeMillisUnsafe() - best.wall - elapsed) > DISCONTINUITY_MS
    )
  }

  const refresh = Effect.gen(function* () {
    const next = yield* sample
    if (
      stale() ||
      Math.abs(next.offset - best.offset) > DISCONTINUITY_MS + (next.rtt + best.rtt) / 2 ||
      next.rtt <= best.rtt
    )
      best = next
  })

  yield* refresh.pipe(
    sampling.withPermits(1),
    Effect.delay(SAMPLE_EVERY),
    Effect.ignore,
    Effect.forever,
    Effect.forkScoped,
  )

  const now = Effect.gen(function* () {
    if (stale())
      yield* Effect.suspend(() => (stale() ? refresh : Effect.void)).pipe(sampling.withPermits(1))
    return Math.round(performance.now() + best.offset)
  })

  return { now }
})

/** Samples the runtime's authoritative database clock for served responses. */
export const databaseClock = Effect.flatMap(InternalActors, (actors) =>
  sampledDatabaseClock(actors.databaseNow),
)
