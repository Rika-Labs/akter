import { Effect, ManagedRuntime, Redacted, Schema } from "effect"
import { loadSecrets, secretsLayer } from "./secrets.ts"

const [project, environment, path, separator, ...command] = process.argv.slice(2)

const input = await Effect.runPromise(
  Schema.decodeUnknownEffect(
    Schema.Struct({
      project: Schema.NonEmptyString,
      environment: Schema.NonEmptyString,
      path: Schema.NonEmptyString,
      separator: Schema.Literal("--"),
      command: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
    }),
  )({ project, environment, path, separator, command }),
)

if (input.environment === "prod" || input.environment === "production")
  throw new Error("Do not inject production secrets into development processes")

const runtime = ManagedRuntime.make(secretsLayer)

const secrets = await runtime.runPromise(loadSecrets(input.project, input.environment, input.path))

const child = Bun.spawn([...input.command], {
  env: {
    ...process.env,
    ...Object.fromEntries(
      Object.entries(secrets).map(([key, value]) => [key, Redacted.value(value)]),
    ),
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})

try {
  process.exitCode = await child.exited
} finally {
  await runtime.dispose()
}
