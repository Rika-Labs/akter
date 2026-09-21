// Contract file: a singleton — an ordinary actor that exists exactly once cluster-wide (decision 157, 170).
import { Effect, Schema } from "effect"
import { Actor } from "../framework/Actor.ts"

export const Pause = Actor.command("Pause", {
  description: "Stop sweeping dead letters until Resume. The run loop keeps polling but takes no action."
})
export const Resume = Actor.command("Resume", {
  description: "Resume sweeping dead letters."
})

export const Reaper = Actor.make("Reaper", {
  description: "Retries young dead letters and logs old ones, cluster-wide, once a minute. One instance per cluster.",
  singleton: true, // `Reaper.get()` takes no id; the framework keeps a boot activation resident
  commands: [Pause, Resume],
  // a singleton still has keyed state: `paused` survives runner restarts like any other actor's state
  state: { paused: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))) }
})
