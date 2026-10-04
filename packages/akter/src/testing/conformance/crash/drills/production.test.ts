import { BunCrypto, BunServices } from "@effect/platform-bun"
import { layerClientProtocol, layerSocketServer } from "@effect/platform-bun/BunClusterSocket"
import { connect, type ConnectionOptions } from "node:tls"
import { Config, Context, DateTime, Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { Actor } from "../../../../index.ts"
import { Actors, Database, Runner, RuntimeControl } from "../../../../runtime/index.ts"
import { migrations } from "../../../../runtime/database/migrations.ts"
import { RunnerAuthority } from "../../../../runtime/peering/authority.ts"
import type { RunnerCredentials } from "../../../../runtime/peering/credentials.ts"
import { decompress } from "../../../../runtime/storage/codec.ts"
import { disposableDatabase } from "../../../database.ts"
import { freePort, until } from "./failover.ts"
import { processTopology, type RunnerProcess } from "./production.ts"

describe("public production runner topology on Postgres", () => {
  const runtime = ManagedRuntime.make(Layer.merge(BunServices.layer, BunCrypto.layer))
  afterAll(() => runtime.dispose())

  it(
    "fails closed on a different shard layout, an embedded join, and PGlite without changing the deployed configuration",
    () =>
      runtime.runPromise(
        Effect.gen(function* () {
          let database = yield* disposableDatabase({
            url: yield* Config.Redacted("TEST_DATABASE_URL"),
          })
          const build = (shards: number, expiration: "3 seconds" | "35 seconds" = "35 seconds") =>
            Effect.gen(function* () {
              const port = yield* freePort
              yield* Layer.build(
                Actors.layer().pipe(
                  Layer.provide(
                    Runner.socket({
                      address: { host: "127.0.0.1", port },
                      transport: Layer.merge(layerSocketServer, layerClientProtocol),
                      shardsPerGroup: shards,
                      shardLockExpiration: expiration,
                    }),
                  ),
                  Layer.provide(Database.postgres({ url: database })),
                ),
              )
            }).pipe(Effect.scoped)
          yield* build(64)
          for (const attempt of [build(32), build(64, "3 seconds")]) {
            const exit = yield* Effect.exit(attempt)
            expect(exit._tag).toBe("Failure")
            expect(String(exit)).toContain("differs from the deployment")
          }
          const embedded = yield* Effect.exit(
            Layer.build(
              Actors.layer().pipe(Layer.provide(Database.postgres({ url: database }))),
            ).pipe(Effect.scoped),
          )
          expect(String(embedded)).toContain("requires Runner.socket")
          const pglite = yield* Effect.exit(
            Layer.build(
              Actors.layer().pipe(
                Layer.provide(
                  Runner.socket({
                    address: { host: "127.0.0.1", port: yield* freePort },
                    transport: Layer.merge(layerSocketServer, layerClientProtocol),
                  }),
                ),
                Layer.provide(Database.pglite()),
              ),
            ).pipe(Effect.scoped),
          )
          expect(String(pglite)).toContain("requires Postgres")
          yield* build(64)
          database = yield* disposableDatabase({ url: yield* Config.Redacted("TEST_DATABASE_URL") })
          const competing = yield* Effect.all([Effect.exit(build(32)), Effect.exit(build(64))], {
            concurrency: 2,
          })
          expect(competing.filter(({ _tag }) => _tag === "Success")).toHaveLength(1)
          expect(competing.filter(({ _tag }) => _tag === "Failure")).toHaveLength(1)
          expect(String(competing.find(({ _tag }) => _tag === "Failure"))).toContain(
            "differs from the deployment",
          )
        }).pipe(Effect.scoped),
      ),
    30_000,
  )

  it(
    "reports readiness as peering once a mutual TLS runner's certificate expires, and ready again after renewal",
    () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const database = yield* disposableDatabase({
            url: yield* Config.Redacted("TEST_DATABASE_URL"),
          })
          const authority = yield* RunnerAuthority.make()
          let credentials = yield* authority.issue({
            deployment: "drill",
            notBefore: yield* DateTime.now,
            validFor: "6 seconds",
          })
          const Probe = Actor.make("PeeringProbe", {
            key: Schema.String,
            api: { Ping: Actor.command("Ping") },
          })
          const context = yield* Layer.build(
            Probe.toLayer(Effect.succeed({ Ping: () => Effect.void })).pipe(
              Layer.provideMerge(
                Actors.layer().pipe(
                  Layer.provide(
                    Runner.socket({
                      address: { host: "127.0.0.1", port: yield* freePort },
                      transport: Runner.mtls({
                        deployment: "drill",
                        credentials: Effect.sync(() => credentials),
                        refreshEvery: "200 millis",
                      }),
                      shardsPerGroup: 16,
                    }),
                  ),
                  Layer.provide(Database.postgres({ url: database })),
                ),
              ),
            ),
          )
          const readiness = Context.get(context, RuntimeControl).readiness
          yield* until(
            Effect.map(readiness, ({ ready }) => ready),
            "the runner to acquire its shards",
            "20 seconds",
          )
          yield* until(
            Effect.map(readiness, (state) => !state.ready && state.reason === "peering"),
            "readiness to report the expired certificate",
            "15 seconds",
          )
          credentials = yield* authority.issue({ deployment: "drill" })
          yield* until(
            Effect.map(readiness, ({ ready }) => ready),
            "readiness after renewal",
            "10 seconds",
          )
        }).pipe(Effect.scoped),
      ),
    60_000,
  )

  for (const authority of ["default", "same", "separate"] as const) {
    it(
      `starts six public socket runners together on a completely empty database with ${authority} coordination`,
      () =>
        runtime.runPromise(
          Effect.gen(function* () {
            const database = yield* disposableDatabase({
              url: yield* Config.Redacted("TEST_DATABASE_URL"),
            })
            const control =
              authority === "separate"
                ? yield* disposableDatabase({ url: yield* Config.Redacted("TEST_DATABASE_URL") })
                : database
            const pool = yield* Effect.acquireRelease(
              Effect.sync(() => new Pool({ connectionString: Redacted.value(database) })),
              (connection) => Effect.promise(() => connection.end()),
            )
            const controlPool = yield* Effect.acquireRelease(
              Effect.sync(() => new Pool({ connectionString: Redacted.value(control) })),
              (connection) => Effect.promise(() => connection.end()),
            )
            const ports = new Set<number>()
            while (ports.size < 6) ports.add(yield* freePort)
            yield* Effect.forEach(
              [...ports],
              (port) =>
                Layer.build(
                  Actors.layer().pipe(
                    Layer.provide(
                      Runner.socket({
                        address: { host: "127.0.0.1", port },
                        transport: Layer.merge(layerSocketServer, layerClientProtocol),
                        shardsPerGroup: 16,
                      }),
                    ),
                    Layer.provide(
                      Database.postgres({
                        url: database,
                        offTurnConnections: 3,
                        maxConnections: 2,
                        coordination:
                          authority === "default" ? undefined : { url: control, maxConnections: 3 },
                      }),
                    ),
                  ),
                ),
              { concurrency: "unbounded", discard: true },
            )
            yield* until(
              Effect.promise(() =>
                controlPool
                  .query("SELECT count(DISTINCT address)::int AS runners FROM cluster_runners")
                  .then(({ rows }) => rows[0].runners === 6),
              ),
              "six registered runners",
              "15 seconds",
            )
            const [runners, ids, deployment] = yield* Effect.promise(() =>
              Promise.all([
                controlPool.query(
                  "SELECT count(DISTINCT address)::int AS runners FROM cluster_runners",
                ),
                pool.query(
                  "SELECT count(*)::int AS ids, max(migration_id)::int AS latest FROM actor_migrations",
                ),
                pool.query(
                  "SELECT runner_shards, runner_lock_expiration_ms::int AS expiration FROM actor_deployment",
                ),
              ]),
            )
            expect(runners.rows).toEqual([{ runners: 6 }])
            expect(ids.rows).toEqual([
              {
                ids: Object.keys(migrations).length,
                latest: Math.max(
                  ...Object.keys(migrations).map((key) => Number(key.split("_")[0])),
                ),
              },
            ])
            expect(deployment.rows).toEqual([{ runner_shards: 16, expiration: 35_000 }])
            if (authority === "separate") {
              const locations = yield* Effect.promise(() =>
                pool.query(
                  "SELECT to_regclass('cluster_runners')::text AS runners, to_regclass('cluster_locks')::text AS locks",
                ),
              )
              expect(locations.rows).toEqual([{ runners: null, locks: null }])
            }
          }).pipe(Effect.scoped),
        ),
      60_000,
    )
  }

  for (const transport of ["plaintext", "mutual TLS"] as const)
    it(
      `moves a singleton and its cron after SIGKILL, drains and rolls three socket-connected processes over ${transport}, and preserves every acknowledged command exactly once`,
      () =>
        runtime.runPromise(
          Effect.gen(function* () {
            const { query, spawn, all } = yield* processTopology(
              transport === "mutual TLS" ? yield* RunnerAuthority.make() : undefined,
            )
            const events = query<{ value: Uint8Array; cursor: string }>(
              "SELECT value, sequence::text AS cursor FROM actor_events WHERE actor_type = 'DrillBeacon' ORDER BY sequence",
            ).pipe(
              Effect.flatMap((rows) =>
                Effect.forEach(rows, ({ value, cursor }) =>
                  Schema.decodeEffect(
                    Schema.fromJsonString(Schema.Struct({ by: Schema.Int, source: Schema.String })),
                  )(decompress(value)).pipe(Effect.map((event) => ({ ...event, cursor }))),
                ),
              ),
              Effect.orDie,
            )
            const owner = events.pipe(Effect.map((rows) => rows.at(-1)?.by))
            const drain = Effect.fnUntraced(function* (runner: RunnerProcess) {
              yield* runner.send("DRAIN")
              yield* until(
                Effect.sync(() => runner.readiness !== undefined),
                "a completed drain",
                "15 seconds",
              )
              expect(
                yield* Schema.decodeEffect(
                  Schema.fromJsonString(
                    Schema.Struct({
                      outcome: Schema.String,
                      interruptedTurns: Schema.Int,
                      interruptedJobs: Schema.Int,
                    }),
                  ),
                )(runner.drained!),
              ).toEqual({
                outcome: "clean",
                interruptedTurns: 0,
                interruptedJobs: 0,
              })
              expect(
                yield* Schema.decodeEffect(
                  Schema.fromJsonString(
                    Schema.Struct({ ready: Schema.Boolean, reason: Schema.String }),
                  ),
                )(runner.readiness!),
              ).toEqual({ ready: false, reason: "drained" })
              yield* runner.send("EXIT")
              yield* runner.child.exitCode.pipe(Effect.ignore)
              expect(
                (yield* query<{ count: number }>(
                  `SELECT count(*)::int AS count FROM cluster_locks WHERE address = '127.0.0.1:${runner.port}'`,
                ))[0]!.count,
              ).toBe(0)
            })
            const first = yield* spawn(45, 1)
            const second = yield* spawn(45, 1)
            const third = yield* spawn(45, 1)
            const initial = [first, second, third]
            yield* Effect.forEach(initial, (runner) => runner.send("GO"), { discard: true })
            yield* until(
              Effect.sync(() => initial.every(({ acked }) => acked.size >= 2)),
              "three callers under load",
              "30 seconds",
            )
            yield* until(
              owner.pipe(Effect.map((port) => port !== undefined)),
              "the resident singleton",
              "15 seconds",
            )
            const deadPort = yield* owner
            const dead = initial.find(({ port }) => port === deadPort)!
            const before = yield* events
            const ticks = yield* query<{ intent_id: string }>(
              "SELECT intent_id FROM actor_outbox WHERE actor_type = 'DrillBeacon' AND timer_key LIKE '$cron:%'",
            )
            expect(ticks).toHaveLength(1)
            const survivors = initial.filter((runner) => runner !== dead)
            yield* dead.child.kill({ killSignal: "SIGKILL" })
            expect(String((yield* dead.child.exitCode.pipe(Effect.flip)).cause)).toContain(
              "SIGKILL",
            )
            yield* until(
              owner.pipe(Effect.map((port) => port !== undefined && port !== deadPort)),
              "singleton failover",
              "20 seconds",
            )
            const replacement = yield* spawn(35)
            survivors.push(replacement)
            yield* Effect.forEach(
              survivors,
              (runner) => runner.send("GO").pipe(Effect.andThen(runner.send("RESUME"))),
              { discard: true },
            )
            yield* until(
              Effect.sync(() => survivors.every(({ finished }) => finished)),
              "all survivor commands",
              "60 seconds",
            )
            const rollingPort = yield* owner
            const rolling = survivors.find(({ port }) => port === rollingPort)!
            const beforeDrain = yield* events
            yield* drain(rolling)
            const afterDrain = yield* events
            survivors.splice(survivors.indexOf(rolling), 1)
            yield* until(
              owner.pipe(Effect.map((port) => port !== undefined && port !== rollingPort)),
              "graceful singleton handoff",
              "20 seconds",
            )
            const restarted = yield* spawn(20)
            survivors.push(restarted)
            yield* restarted.send("GO")
            yield* until(
              Effect.sync(() => restarted.finished),
              "the rolling replacement's commands",
              "30 seconds",
            )
            yield* until(
              events.pipe(
                Effect.map(
                  (rows) =>
                    rows.filter(
                      ({ source, cursor }) =>
                        source === "cron" && BigInt(cursor) > BigInt(beforeDrain.at(-1)!.cursor),
                    ).length >= 3,
                ),
              ),
              "cron ticks after both handoffs",
              "15 seconds",
            )
            yield* until(
              query<{ count: number }>(
                "SELECT count(*)::int AS count FROM actor_outbox WHERE kind = 'intent' AND timer_key IS NULL",
              ).pipe(Effect.map((rows) => rows[0]!.count === 0)),
              "every command intent to settle before stopping all relays",
              "15 seconds",
            )
            for (const runner of survivors) yield* drain(runner)
            const receipts = yield* query<{ command_id: string; command: string }>(
              "SELECT command_id, command FROM actor_receipts",
            )
            const ids = new Set(receipts.map(({ command_id }) => command_id))
            expect(all.flatMap(({ acked }) => [...acked].filter((id) => !ids.has(id)))).toEqual([])
            expect(all.map(({ acked }) => acked.size).sort((left, right) => left - right)).toEqual([
              2, 40, 70, 90, 90,
            ])
            const count = (command: string) =>
              receipts.filter((row) => row.command === command).length
            expect(count("Increment")).toBe(146)
            expect(count("Send")).toBe(146)
            const state = (type: string) =>
              query<{ value: Uint8Array }>(
                `SELECT value FROM actor_state WHERE actor_type = '${type}' AND key = 'count'`,
              ).pipe(
                Effect.map((rows) =>
                  rows.reduce((sum, { value }) => sum + Number(decompress(value)), 0),
                ),
              )
            expect(yield* state("DrillCounter")).toBe(count("Increment"))
            expect(yield* state("DrillReceiver")).toBe(count("Add"))
            const pulses = yield* events
            expect(yield* state("DrillBeacon")).toBe(count("Pulse") + count("Loop"))
            expect(pulses.length).toBe(count("Pulse") + count("Loop"))
            expect(
              new Set(
                receipts
                  .filter(({ command }) => command === "Pulse")
                  .map(({ command_id }) => command_id),
              ).size,
            ).toBe(count("Pulse"))
            expect(
              pulses
                .filter(({ cursor }) => BigInt(cursor) > BigInt(before.at(-1)!.cursor))
                .some(({ by }) => by !== deadPort),
            ).toBe(true)
            expect(
              pulses
                .filter(({ cursor }) => BigInt(cursor) > BigInt(afterDrain.at(-1)!.cursor))
                .every(
                  ({ source }) => source !== `loop:${deadPort}` && source !== `loop:${rollingPort}`,
                ),
            ).toBe(true)
            expect(
              receipts.filter(({ command_id }) => command_id === ticks[0]!.intent_id),
            ).toHaveLength(1)
            expect(
              (yield* query<{ count: number }>(
                `SELECT count(*)::int AS count FROM actor_events WHERE actor_type = 'DrillBeacon' AND command_id = '${ticks[0]!.intent_id}'`,
              ))[0]!.count,
            ).toBe(1)
            expect(count("Pulse")).toBeGreaterThanOrEqual(4)
            const pending = yield* query<{ count: number }>(
              "SELECT count(*)::int AS count FROM actor_outbox WHERE kind = 'intent' AND timer_key IS NULL",
            )
            expect(pending[0]!.count).toBe(0)
            expect(count("Add")).toBe(count("Send"))
          }).pipe(Effect.scoped, Effect.timeout("3 minutes")),
        ),
      200_000,
    )
  it(
    "rotates two runners' authority, certificates and keys in place under load, then admits a runner holding only the new ones, and preserves every acknowledged command",
    () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const outgoing = yield* RunnerAuthority.make()
          const incoming = yield* RunnerAuthority.make()
          const both = `${outgoing.certificate}${incoming.certificate}`
          const { query, spawn, all } = yield* processTopology(outgoing)
          const pair = [yield* spawn(1500), yield* spawn(1500)]
          yield* Effect.forEach(pair, (runner) => runner.send("GO"), { discard: true })
          yield* until(
            Effect.sync(() => pair.every(({ acked }) => acked.size >= 20)),
            "two callers under load",
            "30 seconds",
          )
          const renewed = [
            yield* incoming.issue({ deployment: "drill" }),
            yield* incoming.issue({ deployment: "drill" }),
          ]
          const stages: ReadonlyArray<(index: number) => Effect.Effect<RunnerCredentials>> = [
            () =>
              Effect.map(outgoing.issue({ deployment: "drill" }), (next) => ({
                ...next,
                ca: both,
              })),
            (index) => Effect.succeed({ ...renewed[index]!, ca: both }),
            (index) => Effect.succeed(renewed[index]!),
          ]
          for (const stage of stages) {
            const before = pair.map(({ acked }) => acked.size)
            for (const [index, runner] of pair.entries()) yield* runner.present(yield* stage(index))
            yield* Effect.sleep("1 second")
            expect(pair.every((runner, index) => runner.acked.size > before[index]!)).toBe(true)
          }
          const probe = (port: number, options: ConnectionOptions) =>
            Effect.gen(function* () {
              const socket = yield* Effect.acquireRelease(
                Effect.sync(() =>
                  connect({
                    host: "127.0.0.1",
                    port,
                    servername: "runner.akter.internal",
                    checkServerIdentity: () => undefined,
                    ...options,
                  }).on("error", () => undefined),
                ),
                (opened) => Effect.sync(() => opened.destroy()),
              )
              yield* Effect.callback<void>((resume) => {
                socket.once("secureConnect", () => resume(Effect.void))
                socket.once("close", () => resume(Effect.void))
              })
              yield* Effect.sleep("500 millis")

              return socket.destroyed ? "refused" : "accepted"
            }).pipe(Effect.scoped)
          const presenting = (credentials: RunnerCredentials, ca = credentials.ca) => ({
            ca,
            cert: credentials.certificate,
            key: Redacted.value(credentials.key),
          })
          const stale = yield* outgoing.issue({ deployment: "drill" })
          const fresh = yield* incoming.issue({ deployment: "drill" })
          for (const { port } of pair) {
            expect(yield* probe(port, presenting(stale, both))).toBe("refused")
            expect(yield* probe(port, presenting(fresh, outgoing.certificate))).toBe("refused")
            expect(yield* probe(port, presenting(fresh))).toBe("accepted")
          }
          const joined = yield* spawn(60, 60, false, fresh)
          yield* joined.send("GO")
          yield* until(
            Effect.sync(() => [...pair, joined].every(({ finished }) => finished)),
            "every caller's commands after the rotation",
            "90 seconds",
          )
          yield* until(
            query<{ count: number }>(
              "SELECT count(*)::int AS count FROM actor_outbox WHERE kind = 'intent' AND timer_key IS NULL",
            ).pipe(Effect.map((rows) => rows[0]!.count === 0)),
            "every command intent to settle",
            "15 seconds",
          )
          const receipts = yield* query<{ command_id: string; command: string }>(
            "SELECT command_id, command FROM actor_receipts",
          )
          const ids = new Set(receipts.map(({ command_id }) => command_id))
          expect(all.flatMap(({ acked }) => [...acked].filter((id) => !ids.has(id)))).toEqual([])
          expect(all.map(({ acked }) => acked.size)).toEqual([3000, 3000, 120])
          const count = (command: string) =>
            receipts.filter((row) => row.command === command).length
          expect(count("Increment")).toBe(3060)
          expect(count("Send")).toBe(3060)
          expect(count("Add")).toBe(3060)
          const state = (type: string) =>
            query<{ value: Uint8Array }>(
              `SELECT value FROM actor_state WHERE actor_type = '${type}' AND key = 'count'`,
            ).pipe(
              Effect.map((rows) =>
                rows.reduce((sum, { value }) => sum + Number(decompress(value)), 0),
              ),
            )
          expect(yield* state("DrillCounter")).toBe(3060)
          expect(yield* state("DrillReceiver")).toBe(3060)
        }).pipe(Effect.scoped, Effect.timeout("3 minutes")),
      ),
    200_000,
  )
  it(
    "replays a cron tick committed before a relay SIGKILL without repeating its state transition on three processes",
    () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const { query, spawn } = yield* processTopology()
          const first = yield* spawn(0, 0, true)
          yield* until(
            Effect.sync(() => first.committedCron !== undefined),
            "the cron receipt before rewrite",
            "15 seconds",
          )
          const id = first.committedCron!
          const count = query<{ receipts: number; events: number }>(`SELECT
        (SELECT count(*)::int FROM actor_receipts WHERE command_id = '${id}') AS receipts,
        (SELECT count(*)::int FROM actor_events WHERE command_id = '${id}') AS events`)
          expect(yield* count).toEqual([{ receipts: 1, events: 1 }])
          const second = yield* spawn(0)
          const third = yield* spawn(0)
          expect([first, second, third].every(({ ready }) => ready)).toBe(true)
          yield* first.child.kill({ killSignal: "SIGKILL" })
          expect(String((yield* first.child.exitCode.pipe(Effect.flip)).cause)).toContain("SIGKILL")
          yield* until(
            query<{ count: number }>(
              `SELECT count(*)::int AS count FROM actor_outbox WHERE intent_id = '${id}'`,
            ).pipe(Effect.map((rows) => rows[0]!.count === 0)),
            "a surviving relay to replay and rewrite the same tick",
            "20 seconds",
          )
          expect(yield* count).toEqual([{ receipts: 1, events: 1 }])
          expect(
            (yield* query<{ count: number }>(
              "SELECT count(*)::int AS count FROM actor_outbox WHERE actor_type = 'DrillBeacon' AND timer_key LIKE '$cron:%'",
            ))[0]!.count,
          ).toBe(1)
        }).pipe(Effect.scoped, Effect.timeout("60 seconds")),
      ),
    70_000,
  )
})
