#!/usr/bin/env bun
import { BunServices } from "@effect/platform-bun"
import { Console, Effect, ManagedRuntime } from "effect"
import { parseArguments, scaffold, usage } from "./scaffold.ts"

const program = Effect.gen(function* () {
  const parsed = yield* parseArguments(process.argv.slice(2))

  if (parsed.help) return yield* Console.log(usage)

  const { template, directory } = parsed

  yield* scaffold(template, directory)
  yield* Console.log(`Created ${directory} from the ${template} template.

  cd ${directory}
  bun install
  bun start     # PGlite in ./.data; set DATABASE_URL to use Postgres
  bun test`)
})

const runtime = ManagedRuntime.make(BunServices.layer)

const reported = program.pipe(
  Effect.catch((error) =>
    Console.error(error.message).pipe(Effect.andThen(Effect.sync(() => (process.exitCode = 1)))),
  ),
)

try {
  await runtime.runPromise(reported)
} finally {
  await runtime.dispose()
}
