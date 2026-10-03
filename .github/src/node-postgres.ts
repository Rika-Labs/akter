import { Effect } from "effect"

const container = Bun.env["TEST_NODE_POSTGRES_CONTAINER"] ?? "durable-node-postgres"
const port = Bun.env["TEST_NODE_POSTGRES_PORT"] ?? "5435"

const run = Effect.fn("run")(function* (command: ReadonlyArray<string>) {
  const child = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" })
  const stdout = yield* Effect.promise(() => new Response(child.stdout).text())
  const stderr = yield* Effect.promise(() => new Response(child.stderr).text())

  return {
    code: yield* Effect.promise(() => child.exited),
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  }
})

/** Owns a separate primary for Node so cluster-global logical slots cannot collide with Bun's suite. */
const program = Effect.gen(function* () {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(container) ||
    !/^\d+$/.test(port) ||
    Number(port) < 1 ||
    Number(port) > 65535
  )
    return yield* Effect.die(new Error("Invalid Node Postgres container name or port"))

  if ((yield* run(["docker", "inspect", container])).code === 0)
    return yield* Effect.die(
      new Error(
        `Node Postgres container ${container} already exists; remove only your own container before retrying`,
      ),
    )

  const started = yield* run([
    "docker",
    "run",
    "-d",
    "--name",
    container,
    "-e",
    "POSTGRES_USER=project",
    "-e",
    "POSTGRES_PASSWORD=project",
    "-e",
    "POSTGRES_DB=postgres",
    "-p",
    `127.0.0.1:${port}:5432`,
    "postgres:18.6-bookworm",
    "postgres",
    "-c",
    "wal_level=logical",
    "-c",
    "shared_preload_libraries=pg_stat_statements",
  ])
  if (started.code !== 0)
    return yield* Effect.die(new Error(`Node Postgres did not start: ${started.stderr}`))

  for (let attempt = 0; attempt < 60; attempt++) {
    const ready = yield* run([
      "docker",
      "exec",
      container,
      "pg_isready",
      "-h",
      "127.0.0.1",
      "-U",
      "project",
      "-d",
      "postgres",
    ])
    if (ready.code === 0) {
      process.stdout.write(`postgres://project:project@127.0.0.1:${port}/postgres`)
      return
    }
    yield* Effect.sleep("1 second")
  }
  return yield* Effect.die(new Error("Node Postgres did not become ready"))
})

await Effect.runPromise(program)
