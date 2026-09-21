// A cluster-wide cron job: one run per schedule, not one per actor.
import { Actor } from "../framework/Actor.ts"

export const Nightly = Actor.cron("nightly-reset", { cron: "0 3 * * *" })
