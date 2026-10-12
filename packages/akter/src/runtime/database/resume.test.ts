import { connect } from "node:net"
import { NodeFileSystem } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { cryptoLayer } from "../../../../../tooling/conformance/src/conformance/platform.ts"
import {
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Result,
  Schedule,
} from "effect"
import {
  MessageStorage,
  RunnerAddress,
  RunnerHealth,
  Runners,
  Runner,
  RunnerStorage,
  Sharding,
  ShardId,
  ShardingConfig,
  SqlRunnerStorage,
} from "effect/cluster"
import { SqlClient } from "effect/sql"
import { afterAll, expect, it } from "vitest"
import { ClockReadings, clockReading } from "../clock.ts"
import { Database } from "../layer.ts"
import { TurnConnections } from "../turn/pipeline.ts"
import { Coordination } from "./coordination.ts"
import { QueryPool, ReadReplica } from "./replica.ts"
import { ResumeEpoch } from "./resume.ts"
import { disposableDatabase } from "../../testing/database.ts"
import { recoveringRunnerStorage } from "../topology/locks.ts"

const runtime = ManagedRuntime.make(Layer.merge(cryptoLayer, NodeFileSystem.layer))
afterAll(() => runtime.dispose())

/** A closed pre-epoch reservation must fail promptly, rather than waiting for the lock refresh deadline. */
it.each(["supplied", "default"])(
  "resets every runtime pool with a %s factory, fails held sessions promptly and leaves warm statements unchanged",
  (factory) =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const database = yield* disposableDatabase({
            url: yield* Config.Redacted("TEST_DATABASE_URL"),
          })
          const ca = Option.getOrUndefined(
            yield* Config.option(Config.String("RESUME_TEST_TLS_CA")),
          )
          const fs = yield* FileSystem.FileSystem
          const ssl =
            ca === undefined
              ? undefined
              : { ca: yield* fs.readFileString(ca), rejectUnauthorized: true }
          const address = new URL(Redacted.value(database))
          const configured = new URL(address)
          if (factory === "default") {
            configured.searchParams.set("host", address.hostname)
            configured.searchParams.set("port", address.port || "5432")
            configured.hostname = "127.0.0.2"
            configured.port = "1"
          }
          if (ssl !== undefined) configured.searchParams.set("sslmode", "verify-full")
          const url = Redacted.make(configured.href)
          let sockets = 0
          const openedSockets: Array<ReturnType<typeof connect>> = []
          let wallOffset = 0
          const stream = () => {
            sockets++
            const socket = connect({
              host: address.hostname,
              port: Number(address.port || 5432),
              noDelay: true,
            })
            openedSockets.push(socket)
            return socket
          }
          const options = {
            url,
            ssl,
            stream: factory === "supplied" ? stream : undefined,
            maxConnections: 2,
          }
          const context = yield* Layer.build(
            Database.postgres({
              ...options,
              offTurnConnections: 2,
              queryConnections: 2,
              replica: options,
              coordination: options,
            }).pipe(
              Layer.provide(
                Layer.succeed(ClockReadings, (clock) => {
                  const reading = clockReading(clock)
                  return { ...reading, wall: reading.wall + wallOffset }
                }),
              ),
            ),
          )
          const epoch = Context.get(context, ResumeEpoch)
          const clients = [
            Context.get(context, SqlClient.SqlClient),
            Context.get(context, QueryPool)!,
            Context.get(context, ReadReplica)!,
            Context.get(context, Coordination)!,
          ]
          const turns = Context.get(context, TurnConnections)
          const reservations = yield* Effect.forEach(clients, (sql) => sql.reserve)
          const turn = yield* turns.lease
          const backendQuery = "SELECT pg_backend_pid()::integer AS pid"
          const pids = [
            ...(yield* Effect.forEach(reservations, (connection) =>
              connection.executeValues(backendQuery, []),
            )),
            yield* turn.queryValues(backendQuery),
          ].map((rows) => Number(rows[0]![0]))
          expect(new Set(pids).size).toBe(5)
          if (ssl !== undefined) {
            const encrypted = yield* Effect.forEach(reservations, (connection) =>
              connection.executeValues(
                "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
                [],
              ),
            )
            expect(encrypted.every((rows) => rows[0]![0] === true)).toBe(true)
            expect(
              (yield* turn.queryValues(
                "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
              ))[0]![0],
            ).toBe(true)
          }
          let recovered = false
          let recoveryChecks = 0
          yield* epoch.recover(
            Effect.sync(() => {
              recoveryChecks++
              return recovered
            }),
          )
          const first = epoch.check()
          const retained = Array.from(openedSockets)
          wallOffset += 300_000
          const aliveStarted = performance.now()
          epoch.check()
          yield* epoch.settled
          expect(epoch.ready()).toBe(true)
          expect(epoch.check()).toBe(first)
          expect(recoveryChecks).toBe(0)
          expect(retained.every((socket) => !socket.destroyed)).toBe(true)
          expect(performance.now() - aliveStarted < 500).toBe(true)
          const control = Context.get(
            yield* Layer.build(PgClient.layer({ url, ssl })),
            SqlClient.SqlClient,
          )
          yield* control`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = ANY(${pids})`
          wallOffset += 300_000
          const started = performance.now()
          expect(epoch.ready()).toBe(false)
          yield* epoch.settled
          expect(epoch.check()).toBe(first + 1)
          const results = yield* Effect.forEach(reservations, (connection) =>
            Effect.result(connection.executeValues(backendQuery, [])),
          )
          expect(results.every(Result.isFailure)).toBe(true)
          expect(Result.isFailure(yield* Effect.result(turn.queryValues(backendQuery)))).toBe(true)
          expect(performance.now() - started < 500).toBe(true)
          const replacements = yield* Effect.forEach(
            clients,
            (sql) => sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`,
          )
          expect(replacements.every(([row]) => !pids.includes(row!.pid))).toBe(true)
          const beforeRefusal = sockets
          expect(Result.isFailure(yield* Effect.result(Effect.scoped(turns.lease)))).toBe(true)
          expect(sockets).toBe(beforeRefusal)
          wallOffset += 300_000
          epoch.check()
          yield* epoch.settled
          expect(epoch.check()).toBe(first + 1)
          expect(epoch.ready()).toBe(false)
          recovered = true
          yield* Effect.sync(epoch.ready).pipe(
            Effect.repeat({ schedule: Schedule.spaced("10 millis"), until: Boolean }),
            Effect.timeout("2 seconds"),
          )
          const newTurn = yield* turns.lease
          expect(pids.includes(Number((yield* newTurn.queryValues(backendQuery))[0]![0]))).toBe(
            false,
          )
          const primary = clients[0]!
          yield* primary`SELECT 31 AS akter_resume_warm_probe`
          let statements:
            | {
                readonly counts: Effect.Effect<
                  ReadonlyArray<{ calls: number }>,
                  import("effect/sql/SqlError").SqlError
                >
                readonly before: number
              }
            | undefined
          if (yield* Config.Boolean("RESUME_TEST_STATEMENTS").pipe(Config.withDefault(false))) {
            const control = Context.get(
              yield* Layer.build(PgClient.layer({ url, ssl })),
              SqlClient.SqlClient,
            )
            yield* control`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`
            const counts = control<{
              calls: number
            }>`SELECT COALESCE(SUM(calls), 0)::float8 AS calls
        FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())`
            statements = { counts, before: (yield* counts)[0]!.calls }
          }
          const opened = sockets
          for (let index = 0; index < 20; index++) {
            expect(
              (yield* primary<{
                akter_resume_warm_probe: number
              }>`SELECT 31 AS akter_resume_warm_probe`)[0]!.akter_resume_warm_probe,
            ).toBe(31)
            expect(epoch.ready()).toBe(true)
          }
          if (statements !== undefined)
            expect((yield* statements.counts)[0]!.calls - statements.before).toBe(21)
          expect(
            (yield* primary<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`)[0]!.pid,
          ).toBe(replacements[0]![0]!.pid)
          expect(sockets).toBe(opened)
          expect(epoch.check()).toBe(first + 1)
        }),
      ),
    ),
)

it("reacquires real advisory locks on a new reserved backend before reopening the socket epoch", () =>
  runtime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const url = yield* disposableDatabase({ url: yield* Config.Redacted("TEST_DATABASE_URL") })
        const ca = Option.getOrUndefined(yield* Config.option(Config.String("RESUME_TEST_TLS_CA")))
        const fs = yield* FileSystem.FileSystem
        const ssl =
          ca === undefined
            ? undefined
            : { ca: yield* fs.readFileString(ca), rejectUnauthorized: true }
        let wallOffset = 0
        const context = yield* Layer.build(
          Database.postgres({ url, ssl, offTurnConnections: 2 }).pipe(
            Layer.provide(
              Layer.succeed(ClockReadings, (clock) => {
                const reading = clockReading(clock)
                return { ...reading, wall: reading.wall + wallOffset }
              }),
            ),
          ),
        )
        const sql = Context.get(context, SqlClient.SqlClient)
        const epoch = Context.get(context, ResumeEpoch)
        const address = RunnerAddress.RunnerAddress.make({ host: "resume", port: 1 })
        const config = ShardingConfig.ShardingConfig.of({
          ...ShardingConfig.defaults,
          runnerAddress: Option.some(address),
          shardsPerGroup: 2,
          assignedShardGroups: ["default"],
          shardLockExpiration: "3 seconds",
          shardLockDisableAdvisory: false,
          entityMessagePollInterval: "250 millis",
          refreshAssignmentsInterval: "250 millis",
        })
        const storage = yield* SqlRunnerStorage.make({}).pipe(
          Effect.flatMap(recoveringRunnerStorage),
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(ResumeEpoch, epoch),
          Effect.provideService(ShardingConfig.ShardingConfig, config),
        )
        const shards = [ShardId.make("default", 1), ShardId.make("default", 2)]
        yield* storage.register(
          Runner.Runner.make({ address, groups: ["default"], weight: 1 }),
          true,
        )
        expect((yield* storage.acquire(address, shards)).length).toBe(2)
        const control = Context.get(
          yield* Layer.build(PgClient.layer({ url, ssl })),
          SqlClient.SqlClient,
        )
        const locks = control<{ pid: number; objid: number }>`SELECT pid, objid::integer AS objid
      FROM pg_locks WHERE locktype = 'advisory' AND granted
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) ORDER BY objid`
        const before = yield* locks
        expect(before.map((row) => row.objid)).toEqual([1_000_001, 1_000_002])
        yield* control`UPDATE cluster_runners SET last_heartbeat = NOW() - INTERVAL '300 seconds'`
        wallOffset += 300_000
        epoch.check()
        yield* epoch.settled
        expect(epoch.ready()).toBe(true)
        expect(epoch.check()).toBe(0)
        expect(yield* locks).toEqual(before)
        expect((yield* storage.getRunners).some(([, healthy]) => healthy)).toBe(true)
        yield* control`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = ${before[0]!.pid}`
        wallOffset += 300_000
        expect(epoch.ready()).toBe(false)
        yield* epoch.settled
        yield* Effect.sleep("1.2 seconds")
        expect(yield* locks).toEqual([])
        expect(epoch.ready()).toBe(false)
        const sharding = Context.get(
          yield* Layer.build(
            Sharding.layer.pipe(
              Layer.provide(Runners.layerNoop),
              Layer.provideMerge(MessageStorage.layerNoop),
              Layer.provide([
                RunnerHealth.layerNoop,
                Layer.succeed(RunnerStorage.RunnerStorage, storage),
              ]),
              Layer.provide(Layer.succeed(ShardingConfig.ShardingConfig, config)),
            ),
          ),
          Sharding.Sharding,
        )
        yield* Effect.sync(() => shards.every(sharding.hasShardId)).pipe(
          Effect.repeat({ schedule: Schedule.spaced("10 millis"), until: Boolean }),
          Effect.timeout("2 seconds"),
        )
        yield* Effect.sync(epoch.ready).pipe(
          Effect.repeat({ schedule: Schedule.spaced("10 millis"), until: Boolean }),
          Effect.timeout("5 seconds"),
        )
        const after = yield* locks
        expect(after.map((row) => row.objid)).toEqual([1_000_001, 1_000_002])
        expect(new Set(after.map((row) => row.pid)).size).toBe(1)
        expect(after.every((row) => row.pid !== before[0]!.pid)).toBe(true)
        expect((yield* storage.refresh(address, shards)).length).toBe(2)
      }),
    ),
  ))

it("retains live table-lock sessions only while their stored leases remain valid", () =>
  runtime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const url = yield* disposableDatabase({ url: yield* Config.Redacted("TEST_DATABASE_URL") })
        let wallOffset = 0
        const sockets: Array<ReturnType<typeof connect>> = []
        const context = yield* Layer.build(
          Database.postgres({
            url,
            stream: () => {
              const endpoint = new URL(Redacted.value(url))
              const socket = connect({ host: endpoint.hostname, port: Number(endpoint.port) })
              sockets.push(socket)
              return socket
            },
          }).pipe(
            Layer.provide(
              Layer.succeed(ClockReadings, (clock) => {
                const reading = clockReading(clock)
                return { ...reading, wall: reading.wall + wallOffset }
              }),
            ),
          ),
        )
        const sql = Context.get(context, SqlClient.SqlClient)
        const epoch = Context.get(context, ResumeEpoch)
        const address = RunnerAddress.RunnerAddress.make({ host: "table-resume", port: 9 })
        const config = ShardingConfig.ShardingConfig.of({
          ...ShardingConfig.defaults,
          runnerAddress: Option.some(address),
          shardsPerGroup: 2,
          assignedShardGroups: ["default"],
          shardLockDisableAdvisory: true,
          shardLockExpiration: "7 seconds",
        })
        const storage = yield* SqlRunnerStorage.make({}).pipe(
          Effect.flatMap(recoveringRunnerStorage),
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(ResumeEpoch, epoch),
          Effect.provideService(ShardingConfig.ShardingConfig, config),
        )
        const shards = [ShardId.make("default", 1), ShardId.make("default", 2)]
        yield* storage.register(
          Runner.Runner.make({ address, groups: ["default"], weight: 1 }),
          true,
        )
        expect((yield* storage.acquire(address, shards)).length).toBe(2)
        const control = Context.get(
          yield* Layer.build(PgClient.layer({ url })),
          SqlClient.SqlClient,
        )
        const leases = control`SELECT shard_id, address, acquired_at FROM cluster_locks ORDER BY shard_id`
        const original = yield* leases
        const retained = Array.from(sockets)
        yield* control`UPDATE cluster_runners SET last_heartbeat = NOW() - INTERVAL '300 seconds'`
        wallOffset += 300_000
        epoch.check()
        yield* epoch.settled
        expect(epoch.ready()).toBe(true)
        expect(epoch.check()).toBe(0)
        expect(retained.every((socket) => !socket.destroyed)).toBe(true)
        expect(yield* leases).toEqual(original)
        expect((yield* storage.getRunners).some(([, healthy]) => healthy)).toBe(true)
        yield* control`UPDATE cluster_locks SET acquired_at = NOW() - INTERVAL '8 seconds' WHERE shard_id = ${"default:2"}`
        const expired = yield* control<{
          count: number
        }>`SELECT count(*)::integer AS count FROM cluster_locks WHERE acquired_at < NOW() - INTERVAL '7 seconds'`
        expect(expired[0]!.count).toBe(1)
        wallOffset += 300_000
        epoch.check()
        yield* epoch.settled
        expect(epoch.check()).toBe(1)
        expect(epoch.ready()).toBe(false)
        expect(retained.every((socket) => socket.destroyed)).toBe(true)
        expect((yield* leases).length).toBe(2)
      }),
    ),
  ))

it("bounds concurrent fresh verification blackholes without destroying survivors before the timeout", () =>
  runtime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const url = yield* disposableDatabase({ url: yield* Config.Redacted("TEST_DATABASE_URL") })
        let wallOffset = 0
        let blackhole = false
        const sockets: Array<ReturnType<typeof connect>> = []
        const stream = () => {
          const endpoint = new URL(Redacted.value(url))
          const socket = connect({ host: endpoint.hostname, port: Number(endpoint.port) })
          if (blackhole) socket.pause()
          sockets.push(socket)
          return socket
        }
        const context = yield* Layer.build(
          Database.postgres({
            url,
            stream,
            replica: { url, stream, applicationName: "resume-replica" },
          }).pipe(
            Layer.provide(
              Layer.succeed(ClockReadings, (clock) => {
                const reading = clockReading(clock)
                return { ...reading, wall: reading.wall + wallOffset }
              }),
            ),
          ),
        )
        const sql = Context.get(context, SqlClient.SqlClient)
        const epoch = Context.get(context, ResumeEpoch)
        yield* sql`SELECT 17`
        const replica = Context.get(context, ReadReplica)!
        yield* replica`SELECT 29`
        const retained = Array.from(sockets)
        expect(retained.length).toBe(2)
        blackhole = true
        wallOffset += 300_000
        const started = performance.now()
        epoch.check()
        yield* Effect.sleep("100 millis")
        expect(epoch.check()).toBe(0)
        expect(retained.every((socket) => !socket.destroyed)).toBe(true)
        expect(epoch.ready()).toBe(false)
        yield* epoch.settled
        const elapsed = performance.now() - started
        expect(elapsed).toBeGreaterThanOrEqual(1_400)
        expect(elapsed).toBeLessThan(2_000)
        expect(epoch.check()).toBe(1)
        expect(retained.every((socket) => socket.destroyed)).toBe(true)
      }),
    ),
  ))
