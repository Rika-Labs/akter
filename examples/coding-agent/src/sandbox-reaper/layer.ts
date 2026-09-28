import { DateTime, Effect, Layer } from "effect"
import { Sandboxes } from "../coding-agent/sandbox.ts"
import { SandboxReaper, SweepSandboxes } from "./contract.ts"

export const SandboxReaperCommands = SandboxReaper.toLayer(
  Effect.succeed({
    Sweep: Effect.fnUntraced(function* () {
      yield* (yield* SandboxReaper.Turn).perform(SweepSandboxes.make({ olderThanHours: 24 }))
    }),
    Swept: Effect.fnUntraced(function* () {
      const turn = yield* SandboxReaper.Turn
      yield* turn.state.set({ sweeps: turn.state.sweeps + 1 })
    }),
  }),
)

/** At least once: killing a sandbox that is already gone does nothing, so a rerun is safe. */
export const SandboxReaperEffects = SandboxReaper.toEffectLayer(
  Effect.gen(function* () {
    const sandboxes = yield* Sandboxes

    return {
      SweepSandboxes: Effect.fnUntraced(function* ({ olderThanHours }) {
        const cutoff = DateTime.toEpochMillis(yield* DateTime.now) - olderThanHours * 3_600_000
        const old = (yield* sandboxes.list).filter(({ startedAt }) => startedAt < cutoff)
        yield* Effect.forEach(old, ({ sandboxId }) => sandboxes.kill(sandboxId), { discard: true })
        yield* Effect.logInfo(`Killed ${old.length} sandboxes`)
      }),
    }
  }),
)

export const SandboxReaperLive = Layer.mergeAll(SandboxReaperCommands, SandboxReaperEffects)
