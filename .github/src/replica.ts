// Starts a physical streaming replica of the Postgres server at
// TEST_DATABASE_URL and prints its connection string, for the read-your-writes
// conformance cases. It runs from `check:ci`, because the evidence gate refuses
// a pull request that changes the verification workflow. Without
// TEST_DATABASE_URL or Docker it prints nothing, so the replica cases are
// skipped; in CI that is an error instead.
import { Effect } from "effect"

const CONTAINER = "durable-replica"

const PORT = "5433"

const run = Effect.fn("run")(function* (command: ReadonlyArray<string>) {
  const child = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" })
  const stdout = yield* Effect.promise(() => new Response(child.stdout).text())
  const stderr = yield* Effect.promise(() => new Response(child.stderr).text())
  const code = yield* Effect.promise(() => child.exited)

  return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() }
})

const must = Effect.fn("must")(function* (command: ReadonlyArray<string>) {
  const result = yield* run(command)

  if (!result.ok)
    return yield* Effect.die(new Error(`${command.slice(0, 2).join(" ")} failed: ${result.stderr}`))

  return result.stdout
})

const unavailable = (reason: string) =>
  Bun.env["CI"] === undefined
    ? Effect.void
    : Effect.die(new Error(`CI needs a streaming replica: ${reason}`))

const program = Effect.gen(function* () {
  const primary = Bun.env["TEST_DATABASE_URL"]

  if (primary === undefined || primary === "") return yield* unavailable("TEST_DATABASE_URL unset")

  if (!(yield* run(["docker", "version"])).ok) return yield* unavailable("Docker unavailable")

  const url = new URL(primary)
  const port = url.port === "" ? "5432" : url.port
  const user = decodeURIComponent(url.username)

  // The server behind TEST_DATABASE_URL is the container publishing its port.
  const [container] = (yield* must(["docker", "ps", "--filter", `publish=${port}`, "-q"]))
    .split("\n")
    .filter((id) => id !== "")

  if (container === undefined) return yield* unavailable(`no container publishes port ${port}`)

  const image = yield* must(["docker", "inspect", "-f", "{{.Config.Image}}", container])

  // The official image admits replication connections only over loopback.
  yield* must([
    "docker",
    "exec",
    container,
    "bash",
    "-c",
    `grep -q '^host replication all all' "$PGDATA/pg_hba.conf" || echo 'host replication all all scram-sha-256' >> "$PGDATA/pg_hba.conf"`,
  ])
  yield* must([
    "docker",
    "exec",
    container,
    "psql",
    "-U",
    user,
    "-d",
    "postgres",
    "-c",
    "SELECT pg_reload_conf()",
  ])

  yield* run(["docker", "rm", "-f", CONTAINER])
  yield* must([
    "docker",
    "run",
    "-d",
    "--name",
    CONTAINER,
    "--network",
    "host",
    "--user",
    "postgres",
    "-e",
    `PGPASSWORD=${decodeURIComponent(url.password)}`,
    image,
    "bash",
    "-c",
    `pg_basebackup -h 127.0.0.1 -p ${port} -U ${user} -D /tmp/replica -R -X stream && chmod 700 /tmp/replica && exec postgres -D /tmp/replica -p ${PORT} -c listen_addresses=127.0.0.1`,
  ])

  for (let attempt = 0; attempt < 60; attempt++) {
    const ready = yield* run([
      "docker",
      "exec",
      CONTAINER,
      "pg_isready",
      "-h",
      "127.0.0.1",
      "-p",
      PORT,
    ])

    if (ready.ok) {
      const replica = new URL(url.href)
      replica.port = PORT
      process.stdout.write(replica.href)

      return
    }

    yield* Effect.sleep("1 second")
  }

  const logs = yield* run(["docker", "logs", CONTAINER])

  return yield* Effect.die(new Error(`The replica did not start: ${logs.stdout} ${logs.stderr}`))
})

await Effect.runPromise(program)
