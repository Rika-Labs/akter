import { Actor } from "@durable-actors/core"
import { Effect, Schema } from "effect"

/** Kills every sandbox older than `olderThanHours`; it talks to the provider, so it runs after the turn. */
export class SweepSandboxes extends Actor.effect<SweepSandboxes>()("SweepSandboxes", {
  input: { olderThanHours: Schema.Int },
}) {}

/** Runs every hour on the hour from cron; safe to send by hand. */
export const Sweep = Actor.command("Sweep")

export const Swept = Actor.command("Swept")

/**
 * Hourly, kills sandboxes that outlived their agent, such as one whose agent crashed
 * before `SandboxReady`, so the provider does not bill for orphans.
 */
export const SandboxReaper = Actor.make("SandboxReaper", {
  key: Actor.singleton,
  state: Actor.state({
    sweeps: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  effects: [SweepSandboxes],
  api: { Sweep },
  internal: { Swept },
  // A tick missed while every runner was down is dropped rather than replayed late.
  policy: {
    effects: { SweepSandboxes: { onSuccess: Swept } },
    cron: { "0 * * * *": Sweep },
    cronSkipIfOlderThan: "1 hour",
  },
})
