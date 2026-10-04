import { Config, Effect, FileSystem, Redacted, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Pool } from "pg"
import type { RunnerAuthority } from "../../../../runtime/peering/authority.ts"
import type { RunnerCredentials } from "../../../../runtime/peering/credentials.ts"
import { disposableDatabase } from "../../../database.ts"
import { freePort, until } from "./failover.ts"

export interface RunnerProcess {
  readonly port: number
  readonly child: ChildProcessSpawner.ChildProcessHandle
  readonly acked: Set<string>
  readonly send: (line: string) => Effect.Effect<void>
  /** Replaces the credentials a mutual TLS runner reloads; a plaintext runner has none to replace. */
  readonly present: (credentials: RunnerCredentials) => Effect.Effect<void>
  ready: boolean
  finished: boolean
  drained: string | undefined
  readiness: string | undefined
  committedCron: string | undefined
}

/**
 * Writes the files a drill runner reloads its peer credentials from, each
 * renamed into place so a reload never reads half a file.
 */
const write = Effect.fnUntraced(function* (directory: string, credentials: RunnerCredentials) {
  const fs = yield* FileSystem.FileSystem

  for (const [name, content] of [
    ["ca.pem", credentials.ca],
    ["certificate.pem", credentials.certificate],
    ["key.pem", Redacted.value(credentials.key)],
  ] as const) {
    yield* fs.writeFileString(`${directory}/.${name}`, content, { mode: 0o600 })
    yield* fs.rename(`${directory}/.${name}`, `${directory}/${name}`)
  }
}, Effect.orDie)

/**
 * Independent Bun processes, public socket wiring, and one disposable real
 * database for each drill. With an `authority`, every runner peers over
 * mutual TLS with its own certificate for the drill's deployment, unless a
 * spawn passes the credentials to start with.
 */
export const processTopology = Effect.fnUntraced(function* (authority?: RunnerAuthority) {
  const database = yield* disposableDatabase({ url: yield* Config.Redacted("TEST_DATABASE_URL") })
  const pool = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: Redacted.value(database) })),
    (db) => Effect.promise(() => db.end()),
  )
  const query = <A>(text: string) =>
    Effect.promise(() => pool.query(text)).pipe(Effect.map(({ rows }) => rows as Array<A>))
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const all: Array<RunnerProcess> = []
  const fs = yield* FileSystem.FileSystem
  const credentials =
    authority === undefined
      ? undefined
      : yield* fs.makeTempDirectoryScoped({ prefix: "akter-drill-peering-" }).pipe(Effect.orDie)
  const spawn = Effect.fnUntraced(function* (
    operations: number,
    holdAt = operations,
    blockCron = false,
    initial?: RunnerCredentials,
  ) {
    const port = yield* freePort
    const directory = credentials === undefined ? undefined : `${credentials}/${port}`
    if (directory !== undefined) {
      yield* fs.makeDirectory(directory).pipe(Effect.orDie)
      yield* write(directory, initial ?? (yield* authority!.issue({ deployment: "drill" })))
    }
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
          DRILL_TLS_DIR: directory ?? "",
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
      present: (next) =>
        directory === undefined
          ? Effect.die(new Error("A plaintext drill runner has no peer credentials"))
          : write(directory, next).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
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
