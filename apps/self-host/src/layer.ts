import { Config, Console, Effect, Layer } from "effect"
import { Counter } from "./contract.ts"

/** A zero-default delay lets the shutdown drill overlap a real transaction with SIGTERM. */
export const CounterLive = Layer.merge(
  Counter.toLayer(
    Effect.gen(function* () {
      const delay = yield* Config.Int("COMMAND_DELAY_MS").pipe(Config.withDefault(0))

      return {
        Increment: Effect.fn(function* (amount) {
          const turn = yield* Counter.Turn
          yield* Console.log(`COMMAND_STARTED ${turn.commandId}`)
          yield* Effect.sleep(delay)
          yield* turn.state.set({ count: turn.state.count + amount })
          return turn.state.count
        }),
      }
    }),
  ),
  Counter.toQueryLayer({
    GetCount: Effect.fn(function* () {
      return (yield* Counter.Read).state.count
    }),
  }),
)
