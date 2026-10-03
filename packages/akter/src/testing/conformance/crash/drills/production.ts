import { Config, Effect, Redacted, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Pool } from "pg"
import { disposableDatabase } from "../../../database.ts"
import { freePort, until } from "./failover.ts"

export interface RunnerProcess {
  readonly port: number
  readonly child: ChildProcessSpawner.ChildProcessHandle
  readonly acked: Set<string>
  readonly send: (line: string) => Effect.Effect<void>
  ready: boolean
  finished: boolean
  drained: string | undefined
  readiness: string | undefined
  committedCron: string | undefined
}

/** Independent Bun processes, public socket wiring, and one disposable real database for each drill. */
export const processTopology = Effect.gen(function* () {
  const database = yield* disposableDatabase({ url: yield* Config.Redacted("TEST_DATABASE_URL") })
  const pool = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: Redacted.value(database) })),
    (db) => Effect.promise(() => db.end()),
  )
  const query = <A>(text: string) =>
    Effect.promise(() => pool.query(text)).pipe(Effect.map(({ rows }) => rows as Array<A>))
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const all: Array<RunnerProcess> = []
  const spawn = Effect.fnUntraced(function* (
    operations: number,
    holdAt = operations,
    blockCron = false,
  ) {
    const port = yield* freePort
    const child = yield* spawner.spawn(
      ChildProcess.make("bun", [new URL("./runner.ts", import.meta.url).pathname], {
        env: {
          DRILL_DATABASE_URL: Redacted.value(database),
          DRILL_PORT: String(port),
          DRILL_SHARDS: "256",
          DRILL_OPERATIONS: String(operations),
          DRILL_HOLD_AT: String(holdAt),
          DRILL_BACKGROUND: "true",
          DRILL_BLOCK_CRON: String(blockCron),
        },
        extendEnv: true,
        stdin: { stream: "pipe", endOnDone: false },
        stderr: "inherit",
      }),
    )
    const runner: RunnerProcess = {
      port,
      child,
      acked: new Set(),
      ready: false,
      finished: false,
      drained: undefined,
      readiness: undefined,
      committedCron: undefined,
      send: (line) =>
        Stream.run(Stream.make(new TextEncoder().encode(`${line}\n`)), child.stdin).pipe(
          Effect.orDie,
        ),
    }
    all.push(runner)
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.sync(() => {
          if (line === "READY") runner.ready = true
          if (line === "FINISHED") runner.finished = true
          if (line.startsWith("ACKED ")) runner.acked.add(line.slice(6))
          if (line.startsWith("DRAINED ")) runner.drained = line.slice(8)
          if (line.startsWith("READINESS ")) runner.readiness = line.slice(10)
          if (line.startsWith("CRON_COMMITTED ")) runner.committedCron = line.slice(15)
        }),
      ),
      Effect.forkScoped,
    )
    yield* until(
      Effect.sync(() => runner.ready),
      "a runner to acquire its shards",
      "30 seconds",
    )
    return runner
  })

  return { query, spawn, all }
})
