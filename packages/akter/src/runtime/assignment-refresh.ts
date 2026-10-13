import { Clock, Duration, Effect, Latch } from "effect"

/**
 * Paces membership reads at their public storage boundary because Cluster has
 * no assignment-refresh method. A peer wake remains open until consumed, so a
 * release arriving between a bucket read and its next wait cannot be lost.
 */
export const assignmentRefresh = (interval: Duration.Input) => {
  const millis = Duration.toMillis(Duration.fromInputUnsafe(interval))
  let next: number | undefined
  let changed = Latch.makeUnsafe(false)
  return {
    wake: Effect.asVoid(Effect.suspend(() => changed.open)),
    wait: Effect.gen(function* () {
      const at = Number((yield* Clock.monotonicTimeNanos) / 1_000_000n)
      if (next === undefined) {
        next = at + millis
        return
      }
      const pending = changed
      yield* Effect.raceFirst(Effect.sleep(Duration.millis(Math.max(0, next - at))), pending.await)
      if (changed === pending) changed = Latch.makeUnsafe(false)
      next = Number((yield* Clock.monotonicTimeNanos) / 1_000_000n) + millis
    }),
  }
}
