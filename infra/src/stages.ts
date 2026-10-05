import { BunRuntime } from "@effect/platform-bun"
import { State } from "alchemy/State"
import { Console, Context, Effect, Layer } from "effect"
import { stackName } from "./config.ts"
import { state } from "./state.ts"

/** Every stage the stack has state for. */
export const stages = Effect.gen(function* () {
  const store = yield* Context.get(yield* Layer.build(state), State)
  return yield* store.listStages(stackName)
}).pipe(Effect.scoped, Effect.orDie)

if (import.meta.main)
  BunRuntime.runMain(Effect.flatMap(stages, (names) => Console.log(names.join("\n"))))
