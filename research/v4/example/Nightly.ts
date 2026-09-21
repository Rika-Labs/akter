// A cluster-wide cron job: one run per schedule, not one per actor.
import { Actor } from "../framework/Actor.ts"

export const Nightly = Actor.cron("nightly-reset", {
  description: "Resets the well-known counters every night at 03:00 UTC.",
  cron: "0 3 * * *"
})
