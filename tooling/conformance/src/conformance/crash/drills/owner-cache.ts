import { Config, Effect } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { freePort, open, until } from "./failover.ts"

/** Fresh transaction and MultiXact counters keep the alias probe bounded independently of shared CI traffic. */
export const freshPrimary = Effect.fnUntraced(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const image = yield* Config.String("FAILOVER_POSTGRES_IMAGE").pipe(
    Config.withDefault("postgres:18.6"),
  )
  const port = yield* freePort
  const docker = (args: ReadonlyArray<string>) =>
    spawner.string(ChildProcess.make("docker", args), { includeStderr: true })
  yield* Effect.acquireRelease(
    docker([
      "run",
      "--detach",
      "--publish",
      `127.0.0.1:${port}:5432`,
      "--env",
      "POSTGRES_USER=project",
      "--env",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      image,
      "-c",
      "wal_level=logical",
    ]).pipe(
      Effect.flatMap((output) => {
        const id = output.trim().split("\n").at(-1)!
        return /^[0-9a-f]{64}$/.test(id)
          ? Effect.succeed(id)
          : Effect.die(new Error(`docker run failed: ${output}`))
      }),
    ),
    (id) => Effect.ignore(docker(["rm", "--force", "--volumes", id])),
  )
  const admin = yield* open(port, "postgres")
  yield* until(
    Effect.tryPromise(() => admin.query("SELECT 1")).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    ),
    "the owner-cache probe server",
    "60 seconds",
  )
  return `postgres://project@127.0.0.1:${port}/postgres`
})
