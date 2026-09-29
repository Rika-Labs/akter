import { Config, Effect, Redacted } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { freePort, open, query, until } from "./failover.ts"

/**
 * A Postgres server that archives its WAL, in a container of its own, with a
 * base backup taken before the drill's database exists. Everything runs
 * through `docker exec` as the image's `postgres` user, with the tools of the
 * server's own version: an online `pg_dump` and `pg_restore`, and point-in-time
 * recovery from the base backup and the archive to a named restore point.
 * Each recovery runs as a second server inside the container on a port of its
 * own, with the connection limit of the server the base backup came from, on a copy of the base backup, and follows the base backup's timeline,
 * so recoveries never see one another's history.
 */
export const archivingPostgres = Effect.fnUntraced(function* () {
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

  const port = yield* freePort

  const archive = "test ! -f /archive/%f && cp %p /archive/%f"

  const started = yield* Effect.acquireRelease(
    docker([
      "run",
      "--detach",
      "--network",
      "host",
      "--env",
      "POSTGRES_USER=project",
      "--env",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "--entrypoint",
      "bash",
      image,
      "-c",
      `mkdir -p /archive /recoveries && chown postgres /archive /recoveries && exec docker-entrypoint.sh postgres -c port=${port} -c listen_addresses=127.0.0.1 -c max_connections=300 -c wal_level=replica -c archive_mode=on -c '${`archive_command=${archive}`}'`,
    ]).pipe(
      Effect.flatMap((output) => {
        const id = output.split("\n").at(-1)!

        return /^[0-9a-f]{64}$/.test(id)
          ? Effect.succeed(id)
          : Effect.die(new Error(`docker run failed: ${output}`))
      }),
    ),
    (id) => Effect.ignore(docker(["rm", "--force", "--volumes", id])),
  )

  /** Runs `script` as the `postgres` user in the container and fails with its output unless it ends in `DONE`. */
  const exec = Effect.fnUntraced(function* (script: string) {
    const output = yield* docker([
      "exec",
      "--user",
      "postgres",
      started,
      "bash",
      "-c",
      `set -e; ${script}; echo DONE`,
    ])

    return output.endsWith("DONE")
      ? output.slice(0, -"DONE".length).trim()
      : yield* Effect.die(new Error(`docker exec failed: ${output}`))
  })

  const address = (at: number) => `-h 127.0.0.1 -p ${at} -U project`

  const admin = yield* open(port, "postgres")

  yield* until(
    Effect.tryPromise(() => admin.query("SELECT 1")).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    ),
    "the archiving server",
    "60 seconds",
  )

  yield* exec(`pg_basebackup ${address(port)} -D /recoveries/base -X stream -c fast`)

  const url = (at: number, database: string) =>
    Redacted.make(`postgres://project@127.0.0.1:${at}/${database}`)

  let counter = 0

  const next = () => {
    counter += 1

    return counter
  }

  return {
    port,
    url: (database: string) => url(port, database),
    createDatabase: (name: string) => query(admin, `CREATE DATABASE ${name}`),
    /** A custom-format dump of `database`, taken while the server and any runtime on it keep committing; returns the dump's path in the container. */
    dump: Effect.fnUntraced(function* (database: string) {
      const path = `/tmp/online-${next()}.dump`
      yield* exec(`pg_dump ${address(port)} --format=custom --file=${path} ${database}`)

      return path
    }),
    /** Restores the dump at `path` with `pg_restore` into a new database, returning its address. */
    restoreDump: Effect.fnUntraced(function* (path: string) {
      const name = `restored_${next()}`
      yield* exec(`createdb ${address(port)} ${name}`)
      yield* exec(`pg_restore ${address(port)} --no-owner --exit-on-error --dbname=${name} ${path}`)

      return url(port, name)
    }),
    /** Names the current WAL position and waits until the archive holds the segment it is in. */
    mark: Effect.fnUntraced(function* (name: string) {
      const [point] = yield* query<{ segment: string }>(
        admin,
        `SELECT pg_walfile_name(pg_create_restore_point('${name}')) AS segment`,
      )

      yield* query(admin, "SELECT pg_switch_wal()")
      yield* until(
        query<{ archived: boolean }>(
          admin,
          `SELECT coalesce(last_archived_wal >= '${point!.segment}', false) AS archived FROM pg_stat_archiver`,
        ).pipe(Effect.map((rows) => rows[0]?.archived === true)),
        "the archive to hold the restore point",
        "60 seconds",
      )
    }),
    /** Recovers a copy of the base backup to the restore point `name`, promotes it, and returns `database` on that server. */
    recoverTo: Effect.fnUntraced(function* (name: string, database: string) {
      const at = yield* freePort
      const directory = `/recoveries/${next()}`

      yield* exec(
        `cp -a /recoveries/base ${directory} && touch ${directory}/recovery.signal && cat >> ${directory}/postgresql.auto.conf <<'EOF'
restore_command = 'cp /archive/%f %p'
recovery_target_name = '${name}'
recovery_target_action = 'promote'
recovery_target_timeline = 'current'
archive_mode = off
EOF
pg_ctl -D ${directory} -t 120 -o "-p ${at} -c listen_addresses=127.0.0.1 -c max_connections=300" -l ${directory}.log -w start || { tail -30 ${directory}.log; exit 1; }`,
      )

      yield* Effect.gen(function* () {
        const recovered = yield* open(at, "postgres")

        yield* until(
          query<{ recovering: boolean }>(
            recovered,
            "SELECT pg_is_in_recovery() AS recovering",
          ).pipe(Effect.map((rows) => rows[0]?.recovering === false)),
          "the recovery to promote",
          "120 seconds",
        )
      }).pipe(Effect.scoped)

      return url(at, database)
    }),
  }
})
