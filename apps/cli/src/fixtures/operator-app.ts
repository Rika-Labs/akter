import { Actor } from "@rikalabs/akter"
import { App } from "@rikalabs/akter/server"
import { Effect, Schema } from "effect"

/** A real public app shared by CLI operator and local-dev tests, outside production declarations. */
export const Meter = Actor.make("CliMeter", {
  state: Schema.Struct({
    value: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  actions: { add: Actor.action(Schema.Finite) },
  access: () => true,
})
export const MeterLive = Meter.toLayer({
  add: (state, value) => {
    state.value += value
  },
})
export default App.make({ actors: [Meter], layer: MeterLive })
