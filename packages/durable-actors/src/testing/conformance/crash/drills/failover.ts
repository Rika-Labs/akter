import { connect, createServer, type Socket } from "node:net"
import { Config, type Duration, Effect, Schedule, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Pool } from "pg"

const isBound = Schema.is(Schema.Struct({ port: Schema.Int }))

/** A port the OS just handed out, so each server and runner can listen on its own. */
export const freePort = Effect.callback<number>((resume) => {
  const server = createServer()
  server.once("error", (error) => resume(Effect.die(error)))
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    server.close(() =>
      resume(
        isBound(address)
          ? Effect.succeed(address.port)
          : Effect.die(new Error("the probe socket has no port")),
      ),
    )
  })
})

/**
 * The one database address the runners know, standing in for the virtual IP
 * or DNS name a hosted database moves on failover. `hold` delays every reply
 * without dropping it, as a partition between the database and its clients
 * would; `sever` drops every connection and refuses new ones until `route`
 * names the next server.
 */
export const endpoint = Effect.fnUntraced(function* (port: number, initial: number) {
  const sockets = new Set<Socket>()
  const held: Array<() => void> = []
  let target: number | undefined = initial
  let holding = false

  const server = createServer((client) => {
    if (target === undefined) return void client.destroy()

    const upstream = connect(target, "127.0.0.1")
    sockets.add(client).add(upstream)

    const close = () => {
      client.destroy()
      upstream.destroy()
      sockets.delete(client)
      sockets.delete(upstream)
    }

    client.on("error", close).on("close", close)
    upstream.on("error", close).on("close", close)
    client.on("data", (bytes) => upstream.write(bytes))
    upstream.on("data", (bytes) =>
      holding ? held.push(() => client.write(bytes)) : client.write(bytes),
    )
  })

  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.listen(port, "127.0.0.1", () => resume(Effect.void))
    }),
    () =>
      Effect.callback<void>((resume) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resume(Effect.void))
      }),
  )

  return {
    hold: Effect.sync(() => {
      holding = true
    }),
    release: Effect.sync(() => {
      holding = false

      for (const write of held.splice(0)) write()
    }),
    sever: Effect.sync(() => {
      target = undefined
      holding = false
      held.length = 0

      for (const socket of sockets) socket.destroy()
    }),
    route: (next: number) =>
      Effect.sync(() => {
        target = next
      }),
  }
})

/** A pool of trusted `project` connections to one server's database. */
export const open = Effect.fnUntraced(function* (port: number, database: string) {
  return yield* Effect.acquireRelease(
    Effect.sync(() =>
      new Pool({
        connectionString: `postgres://project@127.0.0.1:${port}/${database}`,
      }).on("error", () => {}),
    ),
    (pool) => Effect.promise(() => pool.end()),
  )
})

export const query = Effect.fnUntraced(function* <A>(pool: Pool, text: string) {
  const result = yield* Effect.promise(() => pool.query(text))

  return result.rows as Array<A>
})

export const until = Effect.fnUntraced(function* (
  condition: Effect.Effect<boolean>,
  what: string,
  within: Duration.Input,
) {
  yield* Effect.gen(function* () {
    while (!(yield* condition)) yield* Effect.sleep("50 millis")
  }).pipe(
    Effect.timeoutOrElse({
      duration: within,
      orElse: () => Effect.die(new Error(`timed out waiting for ${what}`)),
    }),
  )
})

const ready = Effect.fnUntraced(function* (port: number) {
  const admin = yield* open(port, "postgres")

  yield* Effect.tryPromise(() => admin.query("SELECT 1")).pipe(
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 600 }),
    Effect.orDie,
  )

  return admin
})

/**
 * A Postgres primary that commits only once its streaming standby has
 * flushed, with a `database` on it. Both run in containers of their own, the
 * image CI's database service uses, so killing the primary kills every
 * backend and the WAL sender with it, as losing a host would.
 */
export const synchronousPair = Effect.fnUntraced(function* (database: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const image = yield* Config.String("FAILOVER_POSTGRES_IMAGE").pipe(
    Config.withDefault("postgres:18.6"),
  )

  const docker = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
    const output = yield* spawner.string(ChildProcess.make("docker", args), {
      includeStderr: true,
    })

    return output.trim()
  })

  const container = (args: ReadonlyArray<string>) =>
    Effect.acquireRelease(
      docker(["run", "--detach", "--network", "host", ...args]).pipe(
        Effect.flatMap((output) => {
          const id = output.split("\n").at(-1)!

          return /^[0-9a-f]{64}$/.test(id)
            ? Effect.succeed(id)
            : Effect.die(new Error(`docker run failed: ${output}`))
        }),
      ),
      (id) => Effect.ignore(docker(["rm", "--force", "--volumes", id])),
    )

  const primaryPort = yield* freePort
  const standbyPort = yield* freePort

  const settings = (port: number) =>
    [`port=${port}`, "listen_addresses=127.0.0.1", "max_connections=300"].flatMap((setting) => [
      "-c",
      setting,
    ])

  const primaryId = yield* container(
    ["--env", "POSTGRES_USER=project", "--env", "POSTGRES_HOST_AUTH_METHOD=trust", image].concat(
      settings(primaryPort),
    ),
  )

  const primary = yield* ready(primaryPort)

  yield* container([
    "--user",
    "postgres",
    "--entrypoint",
    "bash",
    image,
    "-c",
    `pg_basebackup -h 127.0.0.1 -p ${primaryPort} -U project -D /tmp/standby -R -X stream -c fast && exec postgres -D /tmp/standby ${settings(standbyPort).join(" ")}`,
  ])

  const standby = yield* ready(standbyPort)

  yield* query(primary, "ALTER SYSTEM SET synchronous_standby_names = '*'")
  yield* query(primary, "SELECT pg_reload_conf()")
  yield* until(
    query<{ state: string }>(primary, "SELECT sync_state AS state FROM pg_stat_replication").pipe(
      Effect.map((rows) => rows.some(({ state }) => state === "sync")),
    ),
    "a synchronous standby",
    "30 seconds",
  )
  yield* query(primary, `CREATE DATABASE ${database}`)

  return {
    primaryPort,
    standbyPort,
    /** SIGKILL to the primary's container. */
    kill: Effect.asVoid(docker(["kill", "--signal", "KILL", primaryId])),
    /** Promotes the standby and waits until it accepts writes. */
    promote: query<{ promoted: boolean }>(standby, "SELECT pg_promote(true, 60) AS promoted").pipe(
      Effect.map((rows) => rows[0]?.promoted === true),
    ),
  }
})
