import { Effect } from "effect"
import { Probe, SleepyProbe } from "./contract.ts"

export const ProbeReads = Probe.toQueryLayer(
  Effect.succeed({
    Peek: Effect.fnUntraced(function* () {
      return (yield* Probe.Read).state.count
    }),
  }),
)

export const SleepyProbeReads = SleepyProbe.toQueryLayer(
  Effect.succeed({
    Peek: Effect.fnUntraced(function* () {
      return (yield* SleepyProbe.Read).state.count
    }),
  }),
)
