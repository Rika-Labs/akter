// Contract file: a singleton with a cron and an effect. Kills sandboxes that outlived every agent (crashed before
// SandboxReady, tenant deleted, …) so E2B does not bill for orphans.
import { Effect, Schema } from "effect"
import { Actor, Cron } from "../framework/Actor.ts"

/** The sweep itself is an effect: it talks to E2B, so it runs after the turn, not inside it. */
export class SweepSandboxes extends Schema.TaggedClass<SweepSandboxes>()("SweepSandboxes", { olderThanHours: Schema.Number }) {}

export const Sweep = Actor.command("Sweep", {
  description: "Kill sandboxes older than a day. Runs every ten minutes on its own; safe to call by hand."
})

export const SandboxReaper = Actor.make("SandboxReaper", {
  description: "Kills sandboxes older than a day, cluster-wide, every ten minutes.",
  singleton: true,
  commands: [Sweep],
  effects: [SweepSandboxes],
  state: { sweeps: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))) },
  lifecycle: [Cron.every("*/10 * * * *", Sweep, { skipIfOlderThan: "10 minutes" })]
})
