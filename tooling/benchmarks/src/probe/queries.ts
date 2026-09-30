import { Effect } from "effect"
import { EventProbe, Probe, SleepyProbe, Ticked } from "./contract.ts"

/** Query handlers for `Probe`. */
export const ProbeReads = Probe.toQueryLayer({
  Peek: Effect.fnUntraced(function* () {
    return (yield* Probe.Read).state.count
  }),
})

/** Query handlers for `SleepyProbe`. */
export const SleepyProbeReads = SleepyProbe.toQueryLayer({
  Peek: Effect.fnUntraced(function* () {
    return (yield* SleepyProbe.Read).state.count
  }),
})

/** Query handlers for `EventProbe`. */
export const EventProbeReads = EventProbe.toQueryLayer({
  Replay: Effect.fnUntraced(function* (after: string | undefined) {
    const read = yield* EventProbe.Read
    let events = 0
    let last = after ?? "0"

    for (;;) {
      const page = yield* read.events(Ticked, { after: last, limit: 10_000 })
      events += page.length
      last = page.at(-1)?.cursor ?? last

      if (page.length < 10_000) return { events, last }
    }
  }),
  ReplayPage: Effect.fnUntraced(function* ({ after, limit }) {
    return (yield* (yield* EventProbe.Read).events(Ticked, { after, limit })).length
  }),
})
