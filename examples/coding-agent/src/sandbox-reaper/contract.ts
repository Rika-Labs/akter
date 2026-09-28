import { Actor } from "@durable-actors/core"
import { Effect, Schema } from "effect"

/** Kills every sandbox older than `olderThanHours`; it talks to the provider, so it runs after the turn. */
export class SweepSandboxes extends Actor.effect<SweepSandboxes>()("SweepSandboxes", {
  input: { olderThanHours: Schema.Int },
}) {}

export const Sweep = Actor.command("Sweep")

export const Swept = Actor.command("Swept")

/**
 * Kills sandboxes that outlived their agent, such as one whose agent crashed
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
  policy: { effects: { SweepSandboxes: { onSuccess: Swept } } },
})
