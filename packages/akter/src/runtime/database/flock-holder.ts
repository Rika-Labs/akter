import { Config, Console, Effect } from "effect"
import { flockExclusive } from "./flock.ts"

/**
 * Takes the lock on `FLOCK_PATH` and prints `HELD`, then waits to be killed; a pending timer keeps Node alive, which `Effect.never` does not, or
 * prints `BUSY` when the file is already locked. Started by `flock.test.ts`
 * under each runtime.
 */
const program = Effect.gen(function* () {
  const path = yield* Config.String("FLOCK_PATH")

  if (!(yield* flockExclusive(path))) return yield* Console.log("BUSY")

  yield* Console.log("HELD")

  return yield* Effect.forever(Effect.sleep("1 hour"))
}).pipe(Effect.scoped)

await Effect.runPromise(program)
