import { DateTime, Effect, Layer } from "effect"
import { Actor } from "@durable-actors/core"
import { AgentId, CodingAgent } from "../coding-agent/contract.ts"
import { type SandboxInfo, Sandboxes } from "../coding-agent/sandbox.ts"
import { SandboxReaper, SweepSandboxes } from "./contract.ts"

/** Handlers for `SandboxReaper`; `Sweep` performs a sweep of sandboxes older than 24 hours. */
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

/**
 * At least once: killing a sandbox that is already gone does nothing, so a
 * rerun is safe. Age alone is not proof of abandonment, so an old sandbox is
 * killed only when its owning agent no longer names it as its sandbox, for
 * example because the agent crashed before `SandboxReady` or replaced it.
 *
 * An agent that cannot be asked keeps its sandbox until a later sweep.
 */
export const SandboxReaperEffects = SandboxReaper.toEffectLayer(
  Effect.gen(function* () {
    const sandboxes = yield* Sandboxes

    const orphaned = ({ sandboxId, owner }: SandboxInfo) =>
      CodingAgent.get(AgentId.make(owner.agentId)).pipe(
        Effect.flatMap((agent) => agent.Sandbox()),
        Actor.tenant(owner.tenant),
        Effect.map((current) => current !== sandboxId),
        Effect.orElseSucceed(() => false),
      )

    return {
      SweepSandboxes: Effect.fnUntraced(function* ({ olderThanHours }) {
        const cutoff = DateTime.toEpochMillis(yield* DateTime.now) - olderThanHours * 3_600_000
        const old = (yield* sandboxes.list).filter(({ startedAt }) => startedAt < cutoff)
        const orphans = yield* Effect.filter(old, orphaned)
        yield* Effect.forEach(orphans, ({ sandboxId }) => sandboxes.kill(sandboxId), {
          discard: true,
        })
        yield* Effect.logInfo(`Killed ${orphans.length} orphaned sandboxes`)
      }),
    }
  }),
)

/** Every handler and executor of the reaper. */
export const SandboxReaperLive = Layer.mergeAll(SandboxReaperCommands, SandboxReaperEffects)
