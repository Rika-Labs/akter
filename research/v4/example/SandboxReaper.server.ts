// The cron tick is a turn (caller System("cron")); the E2B calls are the effect's executor, after COMMIT.
import { Effect } from "effect"
import { SandboxReaper, SweepSandboxes } from "./SandboxReaper.ts"
import { Sandboxes } from "./services.ts"

export const SandboxReaperLive = SandboxReaper.toLayer(
  Effect.gen(function*() {
    const sandboxes = yield* Sandboxes

    return SandboxReaper.of({
      Sweep: (ctx) =>
        Effect.andThen(
          ctx.state.set({ sweeps: ctx.state.sweeps + 1 }),
          ctx.perform(new SweepSandboxes({ olderThanHours: 24 }))
        )
    }, {
      effects: {
        // at least once: killing an already-dead sandbox is a no-op, so a retry after a crash is safe
        SweepSandboxes: (_ctx, effect) =>
          Effect.gen(function*() {
            const cutoff = Date.now() - effect.olderThanHours * 60 * 60 * 1000
            const all = yield* sandboxes.list
            const old = all.filter((s) => s.startedAt.getTime() < cutoff)
            yield* Effect.forEach(old, (s) => sandboxes.kill(s.id), { discard: true })
            yield* Effect.logInfo(`killed ${old.length} of ${all.length} sandboxes`)
          })
      }
    })
  })
)
