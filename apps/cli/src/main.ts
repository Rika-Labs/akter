#!/usr/bin/env bun
import { Database } from "@durable-actors/core/runtime"
import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Layer, Redacted } from "effect"

import {
  USAGE,
  UsageError,
  actorsOf,
  check,
  loadEntry,
  parseCheck,
} from "./commands/workflows/check.ts"

const fail = (message: string) =>
  Console.error(message).pipe(
    Effect.andThen(
      Effect.sync(() => {
        process.exitCode = 2
      }),
    ),
  )

// `durable login`, `durable dev` and `durable deploy` join `workflows check` under commands/.
const program = Effect.gen(function* () {
  const [group, command, ...args] = process.argv.slice(2)

  if (group !== "workflows" || command !== "check")
    return yield* UsageError.make({ message: `Unknown command: ${[group, command].join(" ")}` })

  const options = yield* parseCheck(args)
  const module = yield* loadEntry(options.entry)
  const actors = yield* actorsOf({ module, entry: options.entry })

  const services = yield* Layer.build(
    Database.postgres({ url: Redacted.make(options.databaseUrl) }).pipe(
      Layer.provideMerge(BunCrypto.layer),
    ),
  )

  const { output, exitCode } = yield* check({ actors, json: options.json }).pipe(
    Effect.provideContext(services),
  )

  yield* Console.log(output)
  yield* Effect.sync(() => {
    process.exitCode = exitCode
  })
}).pipe(
  Effect.scoped,
  Effect.catchTags({
    SqlError: (error) => fail(`Cannot read workflow state: ${error.message}`),
    UsageError: (error) => fail(`${error.message}\n${USAGE}`),
  }),
)

BunRuntime.runMain(program)
