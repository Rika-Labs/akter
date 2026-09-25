import { Effect, Layer } from "effect"
import { EventProbe, Probe, SleepyProbe, Ticked } from "./contract.ts"
import { EventProbeReads, ProbeReads, SleepyProbeReads } from "./queries.ts"

const ProbeCommands = Probe.toLayer(
  Effect.succeed({
    Add: Effect.fnUntraced(function* (amount: number) {
      const turn = yield* Probe.Turn
      yield* turn.state.set({ count: turn.state.count + amount })

      return turn.state.count
    }),
    Fill: Effect.fnUntraced(function* (blob: string) {
      const turn = yield* Probe.Turn
      yield* turn.state.set({ blob, count: turn.state.count + 1 })

      return blob.length
    }),
  }),
)

const SleepyProbeCommands = SleepyProbe.toLayer(
  Effect.succeed({
    Add: Effect.fnUntraced(function* (amount: number) {
      const turn = yield* SleepyProbe.Turn
      yield* turn.state.set({ count: turn.state.count + amount })

      return turn.state.count
    }),
    Fill: Effect.fnUntraced(function* (blob: string) {
      const turn = yield* SleepyProbe.Turn
      yield* turn.state.set({ blob, count: turn.state.count + 1 })

      return blob.length
    }),
  }),
)

const EventProbeCommands = EventProbe.toLayer(
  Effect.succeed({
    Emit: Effect.fnUntraced(function* (count: number) {
      const turn = yield* EventProbe.Turn

      for (let n = 0; n < count; n++) yield* turn.emit(Ticked.make({ n }))

      return count
    }),
  }),
)

/**
 * SleepyProbe registers first: Cluster's entity reaper fixes its first sweep
 * interval from the first registration (at most 30 seconds), and a short
 * `hibernateAfter` only shortens later sweeps.
 */
export const ProbeLive = Layer.mergeAll(
  SleepyProbeCommands,
  SleepyProbeReads,
  ProbeCommands,
  ProbeReads,
  EventProbeCommands,
  EventProbeReads,
)
