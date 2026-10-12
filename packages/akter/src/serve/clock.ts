import { Clock, Effect, Option, Semaphore } from "effect"
import { ActorError, ActorUnavailable } from "../errors/actor.ts"
import { InternalActors } from "../runtime/actors.ts"
import { clockDiscontinuous, ClockReadings } from "../runtime/clock.ts"
import { ResumeEpoch } from "../runtime/database/resume.ts"

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
 * shortest round trip. Wall-clock divergence forces a new database read
 * before exposing time, because suspension can pause or reset the monotonic
 * clock without pausing the database. Sample age only affects the background
 * refresh, so warm requests never wait for a merely old sample.
 */
export const sampledDatabaseClock = Effect.fnUntraced(function* (
  databaseNow: Effect.Effect<number, ActorError>,
) {
  const wallClock = yield* Clock.Clock
  const read = yield* ClockReadings
  const resume = yield* Effect.serviceOption(ResumeEpoch)

  const sample = Effect.gen(function* () {
    if (Option.isSome(resume)) resume.value.check()
    const { at: sent, wall } = read(wallClock)
    const database = yield* databaseNow
    const { at: received, wall: receivedWall } = read(wallClock)
    const rtt = received - sent

    if (
      clockDiscontinuous({
        before: { at: sent, wall },
        after: { at: received, wall: receivedWall },
      })
    )
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

  const discontinuous = () => clockDiscontinuous({ before: best, after: read(wallClock) })

  const refresh = Effect.gen(function* () {
    const next = yield* sample
    if (
      discontinuous() ||
      next.at - best.at >= STALE_MS ||
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
    if (Option.isSome(resume)) resume.value.check()
    if (discontinuous())
      yield* Effect.suspend(() => (discontinuous() ? refresh : Effect.void)).pipe(
        sampling.withPermits(1),
      )
    return Math.round(read(wallClock).at + best.offset)
  })

  return { now }
})

/** Samples the runtime's authoritative database clock for served responses. */
export const databaseClock = Effect.flatMap(InternalActors, (actors) =>
  sampledDatabaseClock(actors.databaseNow),
)
