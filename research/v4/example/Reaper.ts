// Contract file: a singleton — one long-lived `run` that exists exactly once cluster-wide.
import { Actor } from "../framework/Actor.ts"

export const Reaper = Actor.singleton("Reaper", {
  description: "Purges expired receipts and events cluster-wide and logs dead letters. Runs exactly once per cluster.",
  shardGroup: "default" // placement: the runners that opted into this group can host it
})
