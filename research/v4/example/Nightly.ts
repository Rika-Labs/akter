// Contract file: a cluster-wide cron is a singleton with a `Cron` policy (decision 170). One tick per schedule, not one per actor.
import { Actor, Cron } from "../framework/Actor.ts"

export const ResetAll = Actor.command("ResetAll", {
  description: "Reset the well-known counters. Runs nightly at 03:00 UTC on its own; safe to call by hand."
})

export const Nightly = Actor.make("Nightly", {
  description: "Nightly maintenance: resets the well-known counters at 03:00 UTC.",
  singleton: true,
  commands: [ResetAll],
  // a tick the cluster slept through (every runner down at 03:00) is dropped after an hour instead of replayed at noon
  lifecycle: [Cron.every("0 3 * * *", ResetAll, { skipIfOlderThan: "1 hour" })]
})
