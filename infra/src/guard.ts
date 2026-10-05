import { BunRuntime } from "@effect/platform-bun"
import { Config, Effect, Schema } from "effect"
import { assertOperation } from "./config.ts"

const Operation = Schema.Literals(["deploy", "destroy"])

export class GuardRefusal extends Schema.TaggedError<GuardRefusal>()("GuardRefusal", {
  message: Schema.String,
}) {}

/**
 * Refuses a stage or operation that must not reach Alchemy: an unknown stage, or the destruction
 * of `prod` or `preview` from CI. Workflows run it before `alchemy`, which cannot tell a destroy from a
 * deploy while it evaluates the stack.
 */
export const guard = (input: {
  readonly operation: string | undefined
  readonly stage: string | undefined
}) =>
  Effect.gen(function* () {
    const operation = yield* Schema.decodeUnknownEffect(Operation)(input.operation).pipe(
      Effect.mapError(() =>
        GuardRefusal.make({ message: "Usage: guard <deploy|destroy> <stage>" }),
      ),
    )
    const ci = yield* Config.Boolean("GITHUB_ACTIONS").pipe(Config.withDefault(false))
    yield* Effect.try({
      try: () => assertOperation({ operation, stage: input.stage ?? "", ci }),
      catch: (cause) => GuardRefusal.make({ message: String(cause) }),
    })
  })

if (import.meta.main) BunRuntime.runMain(guard({ operation: Bun.argv[2], stage: Bun.argv[3] }))
