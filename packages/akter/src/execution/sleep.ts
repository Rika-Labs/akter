import { DurableClock as Clock } from "effect/workflow"

/** Job sleeps always journal their deadline, including sleeps shorter than a minute. */
export const DurableClock = {
  sleep: (options: Omit<Parameters<typeof Clock.sleep>[0], "inMemoryThreshold">) =>
    Clock.sleep({ ...options, inMemoryThreshold: 0 }),
}
