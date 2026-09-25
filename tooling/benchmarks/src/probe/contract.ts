import { Actor } from "durable-actors"
import { Effect, Schema } from "effect"

export const Add = Actor.command("Add", { input: Schema.Int, output: Schema.Int })

export const Fill = Actor.command("Fill", { input: Schema.String, output: Schema.Int })

export const Peek = Actor.query("Peek", { output: Schema.Int })

const state = Actor.state({
  count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  blob: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
})

/** The measured actor, with every policy at its default. */
export const Probe = Actor.make("Probe", {
  key: Schema.NonEmptyString,
  state,
  api: { Add, Fill, Peek },
})

/** Hibernates quickly so a later turn measures a cold activation. */
export const SleepyProbe = Actor.make("SleepyProbe", {
  key: Schema.NonEmptyString,
  state,
  api: { Add, Fill, Peek },
  policy: { hibernateAfter: "250 millis" },
})
