import { BunServices } from "@effect/platform-bun"
import { Clock, Config, Console, Effect, FileSystem, ManagedRuntime, Schema } from "effect"
import { deployment, assertDestroy, DeploymentJson } from "./lifecycle.ts"

const flags = process.argv.slice(4)

const program = Effect.gen(function* () {
  const command = yield* Schema.decodeUnknownEffect(Schema.Literals(["plan", "deploy", "destroy"]))(
    process.argv[2],
  )

  const path = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(process.argv[3])
  const fs = yield* FileSystem.FileSystem
  const now = yield* Clock.currentTimeMillis
  const input = yield* Schema.decodeEffect(DeploymentJson)(yield* fs.readFileString(path))

  if (command === "destroy")
    assertDestroy({
      input,
      actor: yield* Config.String("PROJECT_OWNER").pipe(Config.withDefault("")),
      now,
    })
  const spec = command === "destroy" ? input : deployment({ input, now })

  if (command === "plan") {
    yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(spec))

    return 0
  }

  if (!flags.includes("--approve"))
    return yield* Effect.die(new Error("External changes require explicit --approve"))

  const child = Bun.spawn(
    ["bun", "x", "alchemy", command, "infra/alchemy.run.ts", "--stage", input.stage, "--no-input"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PROJECT_OPERATION: command,
        PROJECT_DEPLOYMENT: yield* Schema.encodeEffect(DeploymentJson)(input),
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  )

  return yield* Effect.promise(() => child.exited)
})

const runtime = ManagedRuntime.make(BunServices.layer)

try {
  process.exitCode = await runtime.runPromise(program)
} finally {
  await runtime.dispose()
}
