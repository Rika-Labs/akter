#!/usr/bin/env bun
import { BunServices } from "@effect/platform-bun"
import { Console, Effect, ManagedRuntime, Schema } from "effect"
import { scaffold, Template, templates, UnknownTemplate } from "./scaffold.ts"

const usage = `Usage: bun create @durable-actors [directory] [--template ${templates.join("|")}]`

const program = Effect.gen(function* () {
  const args = process.argv.slice(2)
  const flag = args.indexOf("--template")

  const positional = args.filter(
    (arg, index) => !arg.startsWith("--") && (flag === -1 || index !== flag + 1),
  )

  if (args.includes("--help")) return yield* Console.log(usage)

  const requested = flag === -1 ? "counter" : (args[flag + 1] ?? "")

  const template = yield* Schema.decodeUnknownEffect(Template)(requested).pipe(
    Effect.mapError(() => UnknownTemplate.make({ template: requested })),
  )

  const directory = positional[0] ?? "durable-actors-app"

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
