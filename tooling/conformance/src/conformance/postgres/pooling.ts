import { Clock, Config, Crypto, Effect, FileSystem, Redacted, Schedule } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Pool } from "pg"
import { freePort } from "../crash/drills/failover.ts"

/** The tested proxy version is independent of locally cached or latest images. */
export const POOLER_IMAGE =
  "edoburu/pgbouncer:v1.25.1-p0@sha256:4a8371e79d6627e74f553d0aaa8e4c5ace20e30034fb296e569b71c89c99e108"

/** Every operation targets this fixture's own container, network or disposable database. */
export const transactionPooler = Effect.fnUntraced(function* () {
  const base = new URL(Redacted.value(yield* Config.Redacted("TEST_DATABASE_URL")))
  const uuid = yield* (yield* Crypto.Crypto).randomUUIDv4()
  const name = `s10pooler_${yield* Clock.currentTimeMillis}_${uuid.replaceAll("-", "")}`
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fs = yield* FileSystem.FileSystem
  const docker = (args: ReadonlyArray<string>) =>
    spawner.string(ChildProcess.make("docker", args)).pipe(Effect.map((output) => output.trim()))
  const admin = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: base.href, max: 1 })),
    (pool) => Effect.promise(() => pool.end()),
  )
  yield* Effect.acquireRelease(
    Effect.tryPromise(() => admin.query(`CREATE DATABASE "${name}"`)),
    () => Effect.promise(() => admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)),
  )
  base.pathname = `/${name}`
  const direct = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: base.href, max: 2 })),
    (pool) => Effect.promise(() => pool.end()),
  )
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "akter-pgbouncer-" })
  const user = decodeURIComponent(base.username)
  const password = decodeURIComponent(base.password)
  const quoted = (value: string) => `"${value.replaceAll('"', '""')}"`
  const host = ["localhost", "127.0.0.1", "::1"].includes(base.hostname)
    ? "host.docker.internal"
    : base.hostname
  yield* Effect.all([
    fs.writeFileString(
      `${directory}/pgbouncer.ini`,
      `[databases]
${name} = host=${host} port=${base.port || "5432"} dbname=${name}
[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 5432
auth_type = plain
auth_file = /etc/pgbouncer/userlist.txt
admin_users = ${user}
pool_mode = transaction
default_pool_size = 3
reserve_pool_size = 0
max_client_conn = 100
max_db_connections = 3
max_prepared_statements = 0
server_round_robin = 1
server_reset_query_always = 1
server_reset_query = DISCARD ALL
server_connect_timeout = 3
query_wait_timeout = 10
tcp_keepalive = 1
tcp_keepidle = 5
tcp_keepintvl = 2
tcp_keepcnt = 3
unix_socket_dir =
pidfile =
`,
    ),
    fs.writeFileString(`${directory}/userlist.txt`, `${quoted(user)} ${quoted(password)}\n`),
  ])
  yield* Effect.acquireRelease(docker(["network", "create", name]), () =>
    docker(["network", "rm", name]).pipe(Effect.orDie),
  )
  const port = yield* freePort
  const id = yield* Effect.acquireRelease(
    docker([
      "run",
      "--detach",
      "--name",
      name,
      "--network",
      name,
      ...(process.platform === "linux" ? ["--add-host=host.docker.internal:host-gateway"] : []),
      "--publish",
      `127.0.0.1:${port}:5432`,
      "--volume",
      `${directory}/pgbouncer.ini:/etc/pgbouncer/pgbouncer.ini:ro`,
      "--volume",
      `${directory}/userlist.txt:/etc/pgbouncer/userlist.txt:ro`,
      POOLER_IMAGE,
    ]),
    (container) => docker(["rm", "--force", "--volumes", container]).pipe(Effect.orDie),
  )
  const pooled = new URL(base.href)
  pooled.hostname = "127.0.0.1"
  pooled.port = String(port)
  const proxyAdminUrl = new URL(pooled.href)
  proxyAdminUrl.pathname = "/pgbouncer"
  const proxyErrors: Error[] = []
  const proxy = yield* Effect.acquireRelease(
    Effect.sync(() =>
      new Pool({ connectionString: proxyAdminUrl.href, max: 1, idleTimeoutMillis: 0 }).on(
        "error",
        (error) => proxyErrors.push(error),
      ),
    ),
    (pool) => Effect.promise(() => pool.end()),
  )
  yield* Effect.tryPromise(() => proxy.query("SHOW VERSION")).pipe(
    Effect.retry({ times: 50, schedule: Schedule.spaced("100 millis") }),
  )
  return {
    url: Redacted.make(pooled.href),
    direct,
    proxy,
    proxyErrors,
    name,
    id,
    port,
    docker,
    directUrl: Redacted.make(base.href),
  }
})
