import { Actor, User } from "@rikalabs/akter"
import { Effect, Schema } from "effect"

const Snapshot = Schema.Struct({
  count: Schema.Int,
  version: Schema.String,
  runner: Schema.String,
})

export const Increment = Actor.command("Increment", {
  payload: Schema.Int,
  success: Schema.Struct({ ...Snapshot.fields, caller: Schema.String }),
})

export const Value = Actor.query("Value", { success: Snapshot })

/**
 * The actor a locally built example runner serves: a counter whose answers
 * also name the image version that served them and the container that ran
 * the turn, so a test can tell a deploy, a rollback and a wake apart.
 */
export const Counter = Actor.make("Counter", {
  key: Schema.NonEmptyString,
  state: Actor.state({ count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Increment, Value },
  access: ({ caller }) => Schema.is(User)(caller),
})

/**
 * Handlers for `Counter`. `version` and `runner` are fixed at startup from the
 * image's build argument and the container's hostname.
 */
export const counterLayers = (identity: { readonly version: string; readonly runner: string }) =>
  [
    Counter.toLayer({
      Increment: Effect.fnUntraced(function* (amount) {
        const turn = yield* Counter.Turn
        yield* turn.state.set({ count: turn.state.count + amount })

        return {
          count: turn.state.count,
          ...identity,
          caller: Schema.is(User)(turn.caller) ? turn.caller.subject : "anonymous",
        }
      }),
    }),
    Counter.toQueryLayer({
      Value: Effect.fnUntraced(function* () {
        const read = yield* Counter.Read

        return { count: read.state.count, ...identity }
      }),
    }),
  ] as const
