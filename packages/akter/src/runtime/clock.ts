import { Context, type Clock } from "effect"

export interface ClockReading {
  readonly at: number
  readonly wall: number
}

/** Wall time detects a resumed monotonic epoch; it never grants database authority. */
export const clockDiscontinuous = ({
  before,
  after,
}: {
  readonly before: ClockReading
  readonly after: ClockReading
}) => {
  const elapsed = after.at - before.at
  return elapsed < 0 || Math.abs(after.wall - before.wall - elapsed) > 250
}

/** Reads both local clocks together without probing storage. */
export const clockReading = (clock: Clock.Clock): ClockReading => ({
  at: performance.now(),
  wall: clock.currentTimeMillisUnsafe(),
})

/** The runtime's local clock pair, replaceable for per-runner suspension fault injection. */
export const ClockReadings = Context.Reference<(clock: Clock.Clock) => ClockReading>(
  "akter/runtime/ClockReadings",
  { defaultValue: () => clockReading },
)
