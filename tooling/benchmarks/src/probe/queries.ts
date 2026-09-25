import { Effect } from "effect"
import { EventProbe, Probe, SleepyProbe, Ticked } from "./contract.ts"

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

export const EventProbeReads = EventProbe.toQueryLayer(
  Effect.succeed({
    Replay: Effect.fnUntraced(function* (after: string | undefined) {
      const read = yield* EventProbe.Read
      const entries = yield* read.events(Ticked, { after })

      return { events: entries.length, last: entries.at(-1)?.cursor ?? after ?? "0" }
    }),
  }),
)
