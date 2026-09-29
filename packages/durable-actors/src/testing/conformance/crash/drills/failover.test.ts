import { connect, createServer, type Socket } from "node:net"
import { BunServices } from "@effect/platform-bun"
import {
  Clock,
  Config,
  Console,
  type Duration,
  Effect,
  ManagedRuntime,
  Option,
  Schedule,
  Schema,
  Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { decompress } from "../../../../runtime/storage/codec.ts"

const OPERATIONS = 120

const isBound = Schema.is(Schema.Struct({ port: Schema.Int }))

/** A port the OS just handed out, so each server and runner can listen on its own. */
const freePort = Effect.callback<number>((resume) => {
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
const endpoint = Effect.fnUntraced(function* (port: number, initial: number) {
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

interface Done {
  readonly started: number
  readonly latency: number
}

interface Process {
  readonly done: Array<Done>
  readonly acked: Set<string>
  ready: boolean
  finished: boolean
  exited: boolean
}

describe("Postgres primary failover under load with separate runner processes", () => {
  const runtime = ManagedRuntime.make(BunServices.layer)
  afterAll(() => runtime.dispose())

  it(
    "resolves commit-unknown turns through receipts after the primary fails over",
    () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

          // The primary and its standby run in containers of their own, the
          // image CI's database service uses, so killing one kills every
          // backend and the WAL sender with it, as losing a host would.
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

          const open = (port: number, database: string) =>
            Effect.acquireRelease(
              Effect.sync(() =>
                // A pool on the killed primary sees its idle connections die.
                new Pool({
                  connectionString: `postgres://project@127.0.0.1:${port}/${database}`,
                }).on("error", () => {}),
              ),
              (pool) => Effect.promise(() => pool.end()),
            )

          const query = <A>(pool: Pool, text: string) =>
            Effect.promise(() => pool.query(text)).pipe(
              Effect.map((result) => result.rows as Array<A>),
            )

          const until = (condition: Effect.Effect<boolean>, what: string, within: Duration.Input) =>
            Effect.gen(function* () {
              while (!(yield* condition)) yield* Effect.sleep("50 millis")
            }).pipe(
              Effect.timeoutOrElse({
                duration: within,
                orElse: () => Effect.die(new Error(`timed out waiting for ${what}`)),
              }),
            )

          const ready = Effect.fnUntraced(function* (port: number) {
            const admin = yield* open(port, "postgres")

            yield* Effect.tryPromise(() => admin.query("SELECT 1")).pipe(
              Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 600 }),
              Effect.orDie,
            )

            return admin
          })

          const primaryPort = yield* freePort
          const standbyPort = yield* freePort

          const settings = (port: number) =>
            [`port=${port}`, "listen_addresses=127.0.0.1", "max_connections=300"].flatMap(
              (setting) => ["-c", setting],
            )

          const primaryId = yield* container(
            [
              "--env",
              "POSTGRES_USER=project",
              "--env",
              "POSTGRES_HOST_AUTH_METHOD=trust",
              image,
            ].concat(settings(primaryPort)),
          )

          const primary = yield* ready(primaryPort)

          // The standby copies the primary before it is asked to wait for one,
          // so once promoted it never waits for a standby of its own.
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

          // Every commit waits until the standby has flushed it, so no commit
          // a client could have been told about is missing after promotion.
          yield* query(primary, "ALTER SYSTEM SET synchronous_standby_names = '*'")
          yield* query(primary, "SELECT pg_reload_conf()")
          yield* until(
            query<{ state: string }>(
              primary,
              "SELECT sync_state AS state FROM pg_stat_replication",
            ).pipe(Effect.map((rows) => rows.some(({ state }) => state === "sync"))),
            "a synchronous standby",
            "30 seconds",
          )
          yield* query(primary, "CREATE DATABASE drill")

          const endpointPort = yield* freePort
          const database = yield* endpoint(endpointPort, primaryPort)

          const spawn = Effect.fnUntraced(function* () {
            const process: Process = {
              done: [],
              acked: new Set(),
              ready: false,
              finished: false,
              exited: false,
            }

            const child = yield* spawner.spawn(
              ChildProcess.make("bun", [new URL("./runner.ts", import.meta.url).pathname], {
                env: {
                  DRILL_DATABASE_URL: `postgres://project@127.0.0.1:${endpointPort}/drill`,
                  DRILL_PORT: String(yield* freePort),
                  DRILL_OPERATIONS: String(OPERATIONS),
                },
                extendEnv: true,
                stderr: "inherit",
              }),
            )

            yield* child.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.runForEach((line) =>
                Effect.sync(() => {
                  const [tag, first, started, latency] = line.split(" ")

                  if (tag === "READY") process.ready = true

                  if (tag === "FINISHED") process.finished = true

                  if (tag === "ACKED") process.acked.add(first!)

                  if (tag === "DONE")
                    process.done.push({ started: Number(started), latency: Number(latency) })
                }),
              ),
              Effect.forkScoped,
            )

            yield* child.exitCode.pipe(
              Effect.ignore,
              Effect.andThen(
                Effect.sync(() => {
                  process.exited = true
                }),
              ),
              Effect.forkScoped,
            )

            const start = Stream.run(Stream.make(new TextEncoder().encode("GO\n")), child.stdin)

            return { process, start }
          })

          // Concurrent first migrations race on a fresh database, so one runner migrates first.
          const first = yield* spawn()
          yield* until(
            Effect.sync(() => first.process.ready),
            "the migrating runner",
            "30 seconds",
          )
          const runners = [first, yield* spawn(), yield* spawn()]
          yield* until(
            Effect.sync(() => runners.every(({ process }) => process.ready)),
            "three runners",
            "30 seconds",
          )
          yield* Effect.forEach(runners, ({ start }) => start, { discard: true })

          yield* until(
            Effect.sync(() => runners.every(({ process }) => process.done.length >= 30)),
            "load on every runner",
            "60 seconds",
          )

          const acked = () => new Set(runners.flatMap(({ process }) => [...process.acked]))

          const drill = yield* open(primaryPort, "drill")

          // Read on the primary directly, past the held endpoint.
          const committed = query<{ command_id: string }>(
            drill,
            "SELECT command_id FROM actor_receipts WHERE command IN ('Increment', 'Send')",
          ).pipe(Effect.map((rows) => rows.map(({ command_id }) => command_id)))

          // Held replies leave commits the primary made that no caller has
          // heard of. Hold until at least one exists, then kill the primary
          // with those replies still in flight: each is commit-unknown.
          const unknown = yield* Effect.gen(function* () {
            yield* database.hold

            const found = yield* Effect.gen(function* () {
              while (true) {
                const heard = acked()
                const pending = (yield* committed).filter((id) => !heard.has(id))

                if (pending.length > 0) return pending

                yield* Effect.sleep("20 millis")
              }
            }).pipe(Effect.timeoutOption("400 millis"))

            if (Option.isSome(found)) return found.value

            yield* database.release
            yield* Effect.sleep("200 millis")

            return yield* Effect.fail("no commit in flight")
          }).pipe(Effect.retry({ times: 50 }), Effect.orDie)

          // Every commit the primary made visible, taken while replies are held.
          const visible = yield* committed

          expect(runners.some(({ process }) => process.finished)).toBe(false)
          const killedAt = yield* Clock.currentTimeMillis
          yield* docker(["kill", "--signal", "KILL", primaryId])
          yield* database.sever

          // Promotion follows at once: failure detection, which a real
          // failover manager adds, is not part of this measure.
          const [promotion] = yield* query<{ promoted: boolean }>(
            standby,
            "SELECT pg_promote(true, 60) AS promoted",
          )

          expect(promotion!.promoted).toBe(true)

          const promotedAt = yield* Clock.currentTimeMillis
          yield* database.route(standbyPort)

          yield* until(
            Effect.suspend(() =>
              runners.some(({ process }) => process.exited && !process.finished)
                ? Effect.die(new Error("a runner exited before finishing its operations"))
                : Effect.succeed(runners.every(({ process }) => process.finished)),
            ),
            "runners to finish",
            "120 seconds",
          )

          const promoted = yield* open(standbyPort, "drill")

          yield* until(
            query<{ count: number }>(
              promoted,
              "SELECT count(*)::int AS count FROM actor_outbox",
            ).pipe(Effect.map((rows) => rows[0]!.count === 0)),
            "the outbox to drain",
            "60 seconds",
          )

          const receipts = yield* query<{ command: string; command_id: string }>(
            promoted,
            "SELECT command, command_id FROM actor_receipts WHERE command IN ('Increment', 'Send', 'Add')",
          )

          const ids = new Set(receipts.map((receipt) => receipt.command_id))

          const total = (actorType: string) =>
            query<{ value: Uint8Array }>(
              promoted,
              `SELECT value FROM actor_state WHERE actor_type = '${actorType}' AND key = 'count'`,
            ).pipe(
              Effect.map((rows) =>
                rows.reduce((sum, row) => sum + Number(decompress(row.value)), 0),
              ),
            )

          const of = (command: string) =>
            receipts.filter((receipt) => receipt.command === command).length

          // Nothing a caller heard of, and nothing the old primary showed, is missing.
          const heard = acked()
          const lost = [...new Set([...heard, ...visible])].filter((id) => !ids.has(id))
          expect(lost).toEqual([])

          // Each commit-unknown caller retried under the same id and was
          // answered from its receipt.
          expect(unknown.filter((id) => !heard.has(id))).toEqual([])

          // Every operation committed once: a duplicated transition would
          // leave state ahead of its receipts.
          expect(runners.map(({ process }) => process.done.length)).toEqual([
            OPERATIONS,
            OPERATIONS,
            OPERATIONS,
          ])
          expect(of("Increment")).toBe(3 * OPERATIONS)
          expect(of("Send")).toBe(3 * OPERATIONS)
          expect(of("Add")).toBe(3 * OPERATIONS)
          expect(yield* total("DrillCounter")).toBe(of("Increment"))
          expect(yield* total("DrillReceiver")).toBe(of("Add"))

          // Each runner's operation in flight at the kill waited out the
          // failover; the last of them to commit marks every runner serving.
          const resumed = runners.map(({ process }) =>
            Math.min(
              ...process.done
                .map(({ started, latency }) => started + latency)
                .filter((at) => at >= killedAt),
            ),
          )

          const recovery = Math.max(...resumed) - killedAt

          const worst = Math.max(
            ...runners.flatMap(({ process }) => process.done.map(({ latency }) => latency)),
          )

          // Tagged so a drill run's recovery can be read from the test output.
          yield* Console.error(
            `FAILOVER increments=${of("Increment")} sends=${of("Send")} adds=${of("Add")} commitUnknown=${unknown.length} lost=${lost.length} promoteMs=${promotedAt - killedAt} recoveryMs=${recovery} worstCommandMs=${worst}`,
          )
        }).pipe(Effect.scoped, Effect.timeout("5 minutes")),
      ),
    330_000,
  )
})
