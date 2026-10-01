import { Actor } from "@durable-actors/core"
import { Effect, Schema } from "effect"

/** Kills every sandbox older than `olderThanHours`; it talks to the provider, so it runs after the turn. */
export const SweepSandboxes = Actor.job("SweepSandboxes", {
  payload: { olderThanHours: Schema.Int },
})

/** Runs every hour on the hour from cron; safe to send by hand. */
export const Sweep = Actor.command("Sweep")

/** Records a finished sweep. */
export const Swept = Actor.command("Swept")

/**
 * Hourly, kills sandboxes that outlived their agent, such as one whose agent crashed
 * before `SandboxReady`, so the provider does not bill for orphans. A tick missed while every runner was down is dropped rather than replayed
 * late.
 */
export const SandboxReaper = Actor.make("SandboxReaper", {
  key: Actor.singleton,
  state: Actor.state({
    sweeps: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  jobs: { SweepSandboxes: { job: SweepSandboxes, onSuccess: Swept } },
  api: { Sweep },
  internal: { Swept },
  schedules: { "0 * * * *": Sweep },
  policy: { maxScheduleLag: "1 hour" },
})
