/**
 * Starts a physical streaming replica of the Postgres server at
 * TEST_DATABASE_URL and prints its connection string, for the read-your-writes
 * conformance cases. In CI it first sets the primary's `wal_level` to logical
 * and restarts its container, because the fleet cases decode its WAL and the
 * service container takes no server flags; outside CI a lower level is left
 * alone and the fleet cases skip. It runs from `check:ci`. Without
 * TEST_DATABASE_URL or Docker it prints nothing, so the replica cases are
 * skipped; in CI that is an error instead.
 */
import { Effect } from "effect"

const CONTAINER = Bun.env["TEST_REPLICA_CONTAINER"] ?? "durable-replica"

const PORT = Bun.env["TEST_REPLICA_PORT"] ?? "5433"

/**
 * The replica streams through a physical slot, so the primary keeps every WAL
 * segment until the replica has received it. Without one, each `CREATE
 * DATABASE` and `DROP DATABASE` forces a checkpoint that recycles segments a
 * briefly lagging walsender has not sent yet, and the replica then stops for
 * the rest of the run with "requested WAL segment has already been removed".
 */
const SLOT = CONTAINER.replaceAll(/[^a-zA-Z0-9_]/g, "_").toLowerCase()

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

/**
 * The server behind TEST_DATABASE_URL is the container publishing its port, and the official image
 * admits replication connections only over loopback.
 */
const program = Effect.gen(function* () {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(CONTAINER) ||
    !/^\d+$/.test(PORT) ||
    Number(PORT) < 1 ||
    Number(PORT) > 65535
  )
    return yield* Effect.die(new Error("Invalid replica container name or port"))
  const primary = Bun.env["TEST_DATABASE_URL"]

  if (primary === undefined || primary === "") return yield* unavailable("TEST_DATABASE_URL unset")

  if (!(yield* run(["docker", "version"])).ok) return yield* unavailable("Docker unavailable")

  const url = new URL(primary)
  const port = url.port === "" ? "5432" : url.port
  const user = decodeURIComponent(url.username)

  const [container] = (yield* must(["docker", "ps", "--filter", `publish=${port}`, "-q"]))
    .split("\n")
    .filter((id) => id !== "")

  if (container === undefined) return yield* unavailable(`no container publishes port ${port}`)

  const image = yield* must(["docker", "inspect", "-f", "{{.Config.Image}}", container])

  const psql = (statement: string) => [
    "docker",
    "exec",
    container,
    "psql",
    "-U",
    user,
    "-d",
    "postgres",
    "-Atc",
    statement,
  ]

  if ((yield* must(psql("SHOW wal_level"))) !== "logical" && Bun.env["CI"] !== undefined) {
    yield* must(psql("ALTER SYSTEM SET wal_level = logical"))
    yield* must(["docker", "restart", container])

    for (let attempt = 0; ; attempt++) {
      if ((yield* run(psql("SHOW wal_level"))).stdout === "logical") break

      if (attempt === 60)
        return yield* Effect.die(new Error("The primary did not restart with wal_level=logical"))

      yield* Effect.sleep("1 second")
    }
  }

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

  if ((yield* run(["docker", "inspect", CONTAINER])).ok)
    return yield* Effect.die(
      new Error(
        `Replica container ${CONTAINER} already exists; remove only your own container before retrying`,
      ),
    )
  yield* must(
    psql(
      `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = '${SLOT}' AND NOT active`,
    ),
  )
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
    `pg_basebackup -h 127.0.0.1 -p ${port} -U ${user} -D /tmp/replica -R -X stream -C -S ${SLOT} && chmod 700 /tmp/replica && exec postgres -D /tmp/replica -p ${PORT} -c listen_addresses=127.0.0.1`,
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
