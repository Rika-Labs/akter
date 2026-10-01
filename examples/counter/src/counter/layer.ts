import { Effect, Layer } from "effect"
import { Compute, Counter, Incremented, Pause, Snapshot } from "./contract.ts"

/** Handlers for `Counter` and `Snapshot`. */
export const CounterLive = Layer.mergeAll(
  Counter.toLayer({
    Increment: Effect.fnUntraced(function* (amount) {
      const turn = yield* Counter.Turn
      yield* turn.state.set({ count: turn.state.count + amount })
      yield* turn.emit(Incremented.make({ amount, count: turn.state.count }))

      return turn.state.count
    }),
    Checkpoint: Effect.fnUntraced(function* () {
      const turn = yield* Counter.Turn
      const id = yield* turn.mint(Snapshot)
      yield* (yield* Snapshot.intents(id)).Record(turn.state.count)

      return id
    }),
    Double: Effect.fnUntraced(function* ({ value }) {
      yield* Pause("1 minute")

      return yield* Compute.run(value, (input) => Effect.succeed(input * 2))
    }),
  }),
  Snapshot.toLayer({
    Record: Effect.fnUntraced(function* (count) {
      yield* (yield* Snapshot.Turn).state.set({ count })
    }),
  }),
  Snapshot.toQueryLayer({
    Recorded: Effect.fnUntraced(function* () {
      return (yield* Snapshot.Read).state.count
    }),
  }),
)
