import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Socket, connect } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import {
  Clock,
  Config,
  Console,
  type Duration,
  Effect,
  ManagedRuntime,
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
 * The one address runners know, standing in for the virtual IP or DNS name a
 * hosted database moves on failover. `hold` delays every reply without
 * dropping it, as a partition between the database and its clients would;
 * `sever` drops every connection and refuses new ones until `route` names the
 * next server.
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
  readonly index: number
  readonly started: number
  readonly latency: number
  readonly ids: ReadonlyArray<string>
}

interface Process {
  readonly done: Array<Done>
  readonly acked: Set<string>
  ready: boolean
  finished: boolean
}

describe("Postgres primary failover under load with separate runner processes", () => {
  const runtime = ManagedRuntime.make(BunServices.layer)
  afterAll(() => runtime.dispose())

  it(
    "resolves commit-unknown turns through receipts after the primary fails over",
    () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const bin = yield* Config.String("POSTGRES_BIN").pipe(
            Config.withDefault("/usr/lib/postgresql/18/bin"),
          )
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "failover-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          )

          const run = Effect.fnUntraced(function* (tool: string, args: ReadonlyArray<string>) {
            const code = yield* spawner.exitCode(
              ChildProcess.make(join(bin, tool), args, { stdout: "ignore", stderr: "inherit" }),
            )
            expect(code, `${tool} exit code`).toBe(0)
          })

          // Both servers get their settings on the command line, so the
          // replica's copied configuration never makes it wait for a standby
          // of its own once promoted.
          const serve = Effect.fnUntraced(function* (
            data: string,
            port: number,
            settings: ReadonlyArray<string>,
          ) {
            const child = yield* spawner.spawn(
              ChildProcess.make(
                join(bin, "postgres"),
                [
                  "-D",
                  data,
                  "-p",
                  String(port),
                  "-h",
                  "127.0.0.1",
                  "-k",
                  directory,
                  "-c",
                  "max_connections=300",
                  ...settings.flatMap((setting) => ["-c", setting]),
                ],
                // SIGTERM would wait for every runner to disconnect first.
                { stdout: "ignore", stderr: "ignore", killSignal: "SIGQUIT" },
              ),
            )
            const url = `postgres://project@127.0.0.1:${port}/postgres`
            yield* Effect.tryPromise(async () => {
              const probe = new Pool({ connectionString: url, max: 1 })
              try {
                await probe.query("SELECT 1")
              } finally {
                await probe.end()
              }
            }).pipe(Effect.retry({ times: 100, schedule: Schedule.spaced("100 millis") }))
            return child
          })

          const primaryPort = yield* freePort
          const replicaPort = yield* freePort
          const primaryData = join(directory, "primary")
          const replicaData = join(directory, "replica")

          yield* run("initdb", ["-D", primaryData, "-U", "project", "--auth=trust", "--no-sync"])

          // Every commit waits until the standby has flushed it, so any commit
          // a client could have been told about survives the promotion.
          const primary = yield* serve(primaryData, primaryPort, [
            "wal_level=replica",
            "synchronous_standby_names=*",
            "synchronous_commit=on",
          ])

          yield* run("pg_basebackup", [
            "-h",
            "127.0.0.1",
            "-p",
            String(primaryPort),
            "-U",
            "project",
            "-D",
            replicaData,
            "-R",
            "-X",
            "stream",
            "-c",
            "fast",
          ])
          yield* serve(replicaData, replicaPort, [])

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

          const primaryAdmin = yield* open(primaryPort, "postgres")
          yield* until(
            query<{ state: string }>(
              primaryAdmin,
              "SELECT sync_state AS state FROM pg_stat_replication",
            ).pipe(Effect.map((rows) => rows.some(({ state }) => state === "sync"))),
            "a synchronous standby",
            "30 seconds",
          )
          yield* query(primaryAdmin, "CREATE DATABASE drill")

          const endpointPort = yield* freePort
          const database = yield* endpoint(endpointPort, primaryPort)

          const spawn = Effect.fnUntraced(function* () {
            const process: Process = { done: [], acked: new Set(), ready: false, finished: false }

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
                  const [tag, index, started, latency, incrementId, sendId] = line.split(" ")

                  if (tag === "READY") process.ready = true

                  if (tag === "FINISHED") process.finished = true

                  if (tag === "ACKED") process.acked.add(index!)

                  if (tag === "DONE")
                    process.done.push({
                      index: Number(index),
                      started: Number(started),
                      latency: Number(latency),
                      ids: [incrementId!, sendId!],
                    })
                }),
              ),
              Effect.forkScoped,
            )

            yield* child.exitCode.pipe(
              Effect.exit,
              Effect.flatMap((e) => Console.error(`CHILD-EXIT ${child.pid} ${JSON.stringify(e)}`)),
              Effect.forkScoped,
            )
            yield* Console.error(`CHILD ${child.pid}`)

            const start = Stream.run(Stream.make(new TextEncoder().encode("GO\n")), child.stdin)

            return { child, process, start }
          })

          // Concurrent first migrations race on a fresh database, so one runner migrates first.
          const first = yield* spawn()
          yield* until(Effect.sync(() => first.process.ready), "the migrating runner", "30 seconds")
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
            if (found._tag === "Some") return found.value
            yield* database.release
            yield* Effect.sleep("200 millis")
            return yield* Effect.fail("none in flight")
          }).pipe(Effect.retry({ times: 50 }), Effect.orDie)

          // Every commit the primary made visible, taken while replies are held.
          const beforeKill = new Set(yield* committed)

          const killedAt = yield* Clock.currentTimeMillis
          expect(runners.some(({ process }) => process.finished)).toBe(false)
          yield* primary.kill({ killSignal: "SIGKILL" })
          yield* database.sever

          const replicaAdmin = yield* open(replicaPort, "postgres")
          const [promotion] = yield* query<{ promoted: boolean }>(
            replicaAdmin,
            "SELECT pg_promote(true, 60) AS promoted",
          )
          expect(promotion!.promoted).toBe(true)
          const promotedAt = yield* Clock.currentTimeMillis
          yield* database.route(replicaPort)

          yield* Effect.gen(function* () {
            while (true) {
              yield* Effect.sleep("3 seconds")
              yield* Console.error(
                `DEBUG killedAt=${killedAt} +${(yield* Clock.currentTimeMillis) - killedAt}ms`,
                runners.map(({ process }) => [process.done.length, process.acked.size]),
                JSON.stringify(unknown.map((id) => [id, acked().has(id)])),
              )
              const debugPool = new Pool({
                connectionString: `postgres://project@127.0.0.1:${replicaPort}/drill`,
              })
              const r = yield* Effect.promise(() =>
                debugPool.query(
                  `SELECT command, command_id FROM actor_receipts WHERE command_id = ANY($1)`,
                  [unknown],
                ),
              )
              const a = yield* Effect.promise(() =>
                debugPool.query(
                  `SELECT state, wait_event, left(query, 80) q, now() - state_change AS age FROM pg_stat_activity WHERE datname = 'drill' AND state <> 'idle'`,
                ),
              )
              yield* Console.error(JSON.stringify(r.rows), JSON.stringify(a.rows))
              yield* Console.error(
                "PS",
                yield* spawner.string(ChildProcess.make("ps", ["-o", "pid,stat,pcpu,etime,cmd", "--ppid", String(process.pid)])),
              )
              yield* Effect.promise(() => debugPool.end())
            }
          }).pipe(Effect.forkScoped)
          yield* until(
            Effect.sync(() => runners.every(({ process }) => process.finished)),
            "runners to finish",
            "120 seconds",
          )

          const promoted = yield* open(replicaPort, "drill")

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

          // No acknowledged command and no commit the old primary showed is missing.
          const lost = [...new Set([...acked(), ...beforeKill])].filter((id) => !ids.has(id))
          expect(lost).toEqual([])
          expect(runners.map(({ process }) => process.done.length)).toEqual([
            OPERATIONS,
            OPERATIONS,
            OPERATIONS,
          ])

          // The commit-unknown commands' callers retried under the same ids and
          // were answered from their receipts.
          const heard = acked()
          expect(unknown.filter((id) => !heard.has(id))).toEqual([])

          // A duplicated transition would leave state ahead of its receipts.
          expect(yield* total("DrillCounter")).toBe(of("Increment"))
          expect(of("Add")).toBe(of("Send"))
          expect(yield* total("DrillReceiver")).toBe(of("Send"))
          expect(of("Increment")).toBe(3 * OPERATIONS)
          expect(of("Send")).toBe(3 * OPERATIONS)

          // Each runner's command in flight at the kill waited out the
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
