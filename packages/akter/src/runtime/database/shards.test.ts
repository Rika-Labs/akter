import { BunCrypto } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import {
  Config,
  type Crypto,
  Deferred,
  Effect,
  Fiber,
  Layer,
  ManagedRuntime,
  Predicate,
  Schema,
  type Scope,
} from "effect"
import { SqlClient, Statement } from "effect/sql"
import { connect } from "node:net"
import { afterAll, describe, expect, it } from "vitest"
import { Actor, Intent } from "../../index.ts"
import { ActorTest } from "../../testing/actor-test.ts"
import { System } from "../../identity/caller.ts"
import { disposableDatabase } from "../../testing/database.ts"
import { statementLog } from "../../testing/conformance/statements.ts"
import { Database } from "../layer.ts"
import { Outcome, type Request } from "../request.ts"
import { CallerJson } from "../turn/outbox.ts"
import { claimIntents, outboxRelay, type RelaySettings } from "../turn/relay.ts"
import { TurnHooks } from "../turn/hooks.ts"
import { migrate } from "./migrations.ts"
import { ShardMap, shardClients } from "./shards.ts"
import { routingKey } from "../storage/codec.ts"
import { connectionHolder, type HeldActorType } from "../connections/holder.ts"
import { FrameworkClock } from "../turn/admission.ts"

const runtime = ManagedRuntime.make(BunCrypto.layer)
afterAll(() => runtime.dispose())

const database = <A, E>(
  body: Effect.Effect<A, E, SqlClient.SqlClient | PgClient.PgClient | Scope.Scope | Crypto.Crypto>,
  stream?: PgClient.PgPoolConfig["stream"],
) =>
  runtime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const url = yield* disposableDatabase({ url: yield* Config.Redacted("TEST_DATABASE_URL") })
        const client = yield* Layer.build(Database.postgres({ url, stream, offTurnConnections: 2 }))
        yield* migrate.pipe(Effect.provideContext(client))

        return yield* body.pipe(Effect.provideContext(client))
      }),
    ),
  )

/** Asymmetric buckets at each owned edge and immediately outside the range set. */
const buckets = [-128, -9, -8, 3, 4, 127]
const ranges = [
  { first: -128, last: -9 },
  { first: -8, last: 3 },
]

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const caller = yield* Schema.encodeEffect(CallerJson)(System.make({ source: "actor" }))

  for (const bucket of buckets) {
    const key = BigInt(bucket) << 56n
    yield* sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id)
      VALUES (${key}, 't', 'Sender', ${String(bucket)})`
    yield* sql`INSERT INTO actor_outbox (routing_key, intent_id, bucket, due_at_ms, scheduled_at_ms,
      tenant_id, actor_type, actor_id, target_type, target_id, command, payload, caller)
      VALUES (${key}, ${String(bucket)}, ${bucket}, 0, 0, 't', 'Sender', ${String(bucket)},
        'Sink', 'sink', 'Deliver', '{}', ${caller})`
  }
})

const settings: RelaySettings = {
  pollMs: 1000,
  passLimit: 256,
  deliveryConcurrency: 2,
  claimLeaseMs: () => 37_000,
  maxBackoffMs: 256_000,
  executorConcurrency: 2,
  executorLeaseMs: 60_000,
  retryWindowMs: 86_400_000,
}

const Stage = Actor.command("Stage")
const Record = Actor.command("Record", { payload: Schema.String })
const Beat = Actor.command("Beat")
const Job = Actor.job("Job", { payload: {}, success: Schema.String })
const Capped = Actor.job("Capped", { payload: {}, success: Schema.String })
const RangeActor = Actor.make("RangeActor", {
  key: Schema.String,
  placement: "actor",
  state: Actor.state({
    seen: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
  api: { Stage },
  internal: { Record, Beat },
  schedules: { "@every 1 minute": Beat },
  jobs: {
    Job: { job: Job, onSuccess: Record },
    Capped: { job: Capped, concurrency: { perActor: 1 }, onSuccess: Record },
  },
})

const record = (value: string) =>
  Effect.gen(function* () {
    const turn = yield* RangeActor.Turn
    yield* turn.state.set({ seen: [...turn.state.seen, value] })
  })

const actors = Layer.mergeAll(
  RangeActor.toLayer(
    Effect.succeed({
      Stage: () =>
        Effect.gen(function* () {
          const turn = yield* RangeActor.Turn
          const intents = yield* RangeActor.intents(turn.id)
          yield* intents.Record("intent")
          yield* intents.Record("timer").pipe(Intent.after("1 second"))
          yield* turn.enqueue(Job.make({}))
          yield* turn.enqueue(Capped.make({}))
        }),
      Record: record,
      Beat: () => record("cron"),
    }),
  ),
  RangeActor.toJobLayer(
    Effect.succeed({
      Job: () => Effect.succeed("job"),
      Capped: () => Effect.succeed("capped"),
    }),
  ),
)

describe("data shard bucket ranges with Postgres", () => {
  it("checks holder liveness once per range and closes only a connection whose row disappeared", () =>
    database(
      Effect.gen(function* () {
        yield* seed
        const sql = yield* SqlClient.SqlClient
        let offset = 0
        let measuring = false
        const probes: Array<ReadonlyArray<unknown>> = []
        const owner = { generation: "1", owner: "owner", ownerEpoch: "epoch" }
        const type: HeldActorType = {
          deliveryMs: 1000,
          takeoverMs: 5000,
          reauthorizeMs: 60_000,
          retryWindowMs: 60_000,
          placement: "actor",
          hasResync: () => false,
          hasMember: () => true,
          routingKey: (ref) => BigInt(ref.id) << 56n,
          channel: {
            open: (request) =>
              sql`INSERT INTO actor_connections (
              routing_key, connection_id, bucket, tenant_id, actor_type, actor_id, member,
              holder, holder_epoch, caller, session, opened_at_ms, opened_through)
            VALUES (${BigInt(request.ref.id) << 56n}, ${request.connectionId}, ${Number(request.ref.id)},
              't', 'Sender', ${request.ref.id}, 'Live', ${request.holder}, ${request.holderEpoch},
              '{}', NULL, 0, 0)`.pipe(
                Effect.orDie,
                Effect.as({ _tag: "Opened" as const, ...owner, baseline: "0" }),
              ),
            close: () => Effect.void,
            frame: () => Effect.succeed({ _tag: "Acked" as const, ...owner }),
            resync: () => Effect.never,
          },
        }
        const holder = yield* connectionHolder({
          transport: () => ({
            holder: "holder",
            epoch: "holder-epoch",
            ping: () => Effect.succeed(true),
            deliver: () => Effect.succeed({ wrongEpoch: false, unknown: [] }),
          }),
          actorType: () => type,
          authorize: () => Effect.succeed(true),
        }).pipe(
          Effect.provideService(ShardMap, ranges),
          Effect.provideService(FrameworkClock, { offsetMillis: () => offset }),
          Effect.provideService(Statement.CurrentTransformer, (statement) =>
            Effect.sync(() => {
              const [text, params] = statement.compile()
              const match = /generate_series\(\$(\d+)::int, \$(\d+)::int\)/.exec(text)
              if (measuring && match !== null)
                probes.push([params[Number(match[1]) - 1], params[Number(match[2]) - 1]])
              return statement
            }),
          ),
        )
        const held = yield* Effect.forEach([-128, -9, -8, 3], (bucket) =>
          holder.open({
            ref: { tenant: "t", actor: "Sender", id: String(bucket) },
            member: "Live",
            caller: System.make({ source: "process" }),
            params: "{}",
          }),
        )
        yield* Effect.sleep("300 millis")
        yield* sql`DELETE FROM actor_connections WHERE routing_key = ${-8n << 56n}
        AND connection_id = ${held[2]!.connectionId}`
        measuring = true
        offset = 11_000
        yield* Effect.sleep("500 millis")
        measuring = false
        expect(probes).toEqual([
          [-128, -9],
          [-8, 3],
        ])
        expect(yield* Effect.forEach(held, (connection) => connection.authorized)).toEqual([
          true,
          true,
          false,
          true,
        ])
      }),
    ))

  it.each([
    {
      name: "delivers intents, timers, capped and uncapped jobs, and cron through the public API on both ranges",
      ticks: 1,
    },
    {
      name: "crossing a minute before advancing delivers two distinct cron tick ids, and replay applies neither twice",
      ticks: 2,
    },
  ])("$name", ({ ticks: expectedTicks }) =>
    database(
      Effect.gen(function* () {
        const postgres = yield* PgClient.PgClient
        const probes: Array<ReadonlyArray<unknown>> = []
        const context = yield* Layer.build(
          actors.pipe(
            Layer.provideMerge(
              ActorTest.layer({
                database: postgres.config.url!,
                relay: { deliveryConcurrency: 2 },
                executors: { concurrency: 2 },
              }),
            ),
            Layer.provide(
              Layer.succeed(ShardMap, [
                { first: -128, last: -1 },
                { first: 0, last: 127 },
              ]),
            ),
            Layer.provide(
              Layer.succeed(Statement.CurrentTransformer, (statement) =>
                Effect.sync(() => {
                  const [text, params] = statement.compile()
                  const match = /generate_series\(\$(\d+)::int, \$(\d+)::int\)/.exec(text)
                  if (match !== null)
                    probes.push([params[Number(match[1]) - 1], params[Number(match[2]) - 1]])
                  return statement
                }),
              ),
            ),
          ),
        )

        yield* Effect.gen(function* () {
          const test = yield* ActorTest
          const now = (yield* test.now).epochMilliseconds
          yield* test.advance((Math.floor(now / 60_000) + 1) * 60_000 + 1000 - now)
          const handles = []
          for (const negative of [true, false]) {
            let id = 0
            while (
              routingKey({
                ref: { tenant: test.tenant, actor: "RangeActor", id: String(id) },
                placement: "actor",
              }) <
                0n !==
              negative
            )
              id++
            const handle = yield* RangeActor.get(String(id))
            handles.push(handle)
            yield* handle.Stage()
          }
          const sql = yield* SqlClient.SqlClient
          const ticks = yield* sql<{
            routing_key: string
            intent_id: string
            scheduled: string
          }>`SELECT routing_key::text, intent_id, scheduled_at_ms::text AS scheduled
            FROM actor_outbox WHERE timer_key = '$cron:@every 60000ms'
            ORDER BY routing_key`
          expect(ticks).toHaveLength(2)
          if (expectedTicks === 2)
            yield* test.advance(
              Math.max(...ticks.map((tick) => Number(tick.scheduled))) +
                10 -
                (yield* test.now).epochMilliseconds,
            )
          yield* test.advance("1 minute")
          yield* test.advance(0)
          const receipts = yield* sql<{ command_id: string }>`SELECT command_id FROM actor_receipts
            WHERE command = 'Beat' ORDER BY routing_key`
          expect(receipts).toHaveLength(2 * expectedTicks)
          expect(new Set(receipts.map((receipt) => receipt.command_id)).size).toBe(
            2 * expectedTicks,
          )
          expect(receipts).toEqual(
            expect.arrayContaining(ticks.map((tick) => ({ command_id: tick.intent_id }))),
          )
          for (const tick of ticks)
            yield* sql`UPDATE actor_outbox SET intent_id = ${tick.intent_id},
                due_at_ms = 0, scheduled_at_ms = ${BigInt(tick.scheduled)}
              WHERE routing_key = ${BigInt(tick.routing_key)} AND timer_key = '$cron:@every 60000ms'`
          yield* test.advance(0)
          for (const handle of handles) {
            const state = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ seen: Schema.Array(Schema.String) }),
            )((yield* test.inspect(handle.ref)).state)
            expect([...state.seen].sort()).toEqual([
              "capped",
              ...Array.from({ length: expectedTicks }, () => "cron"),
              "intent",
              "job",
              "timer",
            ])
            expect(yield* test.receiptsFor(handle.ref, "Record")).toBe(4)
            expect(yield* test.receiptsFor(handle.ref, "Beat")).toBe(expectedTicks)
          }
          expect(probes).toContainEqual([-128, -1])
          expect(probes).toContainEqual([0, 127])
          expect(
            probes.every(
              ([first, last]) => (first === -128 && last === -1) || (first === 0 && last === 127),
            ),
          ).toBe(true)
          expect(yield* sql`SELECT kind, attempts FROM actor_outbox ORDER BY routing_key`).toEqual([
            { kind: "intent", attempts: 0 },
            { kind: "intent", attempts: 0 },
          ])
        }).pipe(Effect.provideContext(context))
      }),
    ),
  )

  it("keeps the default map at one statement and one network round trip, without session setup", () => {
    const address = new URL(Effect.runSync(Config.String("TEST_DATABASE_URL")))
    let flights = 0
    let answered = true
    let measuring = false
    const stream = () => {
      const socket = connect({ host: address.hostname, port: Number(address.port) })
      socket.on("data", () => {
        answered = true
      })
      const write = socket.write.bind(socket)
      socket.write = (
        chunk: Uint8Array | string,
        encoding?: BufferEncoding | ((error?: Error | null) => void),
        callback?: (error?: Error | null) => void,
      ) => {
        if (measuring && answered) flights++
        answered = false
        return Predicate.isFunction(encoding)
          ? write(chunk, encoding)
          : write(chunk, encoding, callback)
      }
      return socket
    }

    return database(
      Effect.gen(function* () {
        yield* seed
        const sql = yield* SqlClient.SqlClient
        const log = statementLog()
        log.recording = true
        let executions = 0
        measuring = true
        const rows = yield* Effect.gen(function* () {
          const clients = yield* shardClients
          expect(clients).toEqual([{ sql, range: { first: -128, last: 127 } }])
          return yield* claimIntents({
            sql: clients[0]!.sql,
            range: clients[0]!.range,
            now: 1000,
            limit: 10,
            leaseMs: 5000,
            maxBackoffMs: 5000,
          })
        }).pipe(
          Effect.provideService(Statement.CurrentTransformer, (statement) =>
            Effect.sync(() => {
              log.observe(statement)
              executions++
              return statement
            }),
          ),
        )
        measuring = false
        expect(rows.filter((row) => row.kind === "intent")).toHaveLength(6)
        expect(flights).toBe(1)
        expect(executions).toBe(1)
        expect(log.seen.size).toBe(1)
        expect([...log.seen.keys()][0]).toMatch(/^WITH intent_candidates AS/)
      }),
      stream,
    )
  })

  it("claims only owned boundaries, skips a locked row, and leaves leased rows out of the next claim", () =>
    database(
      Effect.gen(function* () {
        yield* seed
        const sql = yield* SqlClient.SqlClient
        const clients = yield* shardClients.pipe(Effect.provideService(ShardMap, ranges))
        const locked = Deferred.makeUnsafe<void>()
        const release = Deferred.makeUnsafe<void>()
        const holding = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT 1 FROM actor_outbox WHERE routing_key = ${-9n << 56n} AND intent_id = '-9' FOR UPDATE`
              yield* Deferred.succeed(locked, undefined)
              yield* Deferred.await(release)
            }),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(locked)
        const claim = ({ sql, range }: (typeof clients)[number]) =>
          claimIntents({ sql, range, now: 1000, limit: 10, leaseMs: 5000, maxBackoffMs: 5000 })
        const rows = (yield* Effect.forEach(clients, claim, { concurrency: "unbounded" })).flat()
        expect(
          rows
            .filter((row) => row.kind === "intent")
            .map((row) => row.intent_id)
            .sort(),
        ).toEqual(["-128", "-8", "3"])
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(holding)
        expect((yield* claim(clients[0]!)).map((row) => row.intent_id)).toEqual(["-9"])
        expect((yield* Effect.forEach(clients, claim)).flat()).toEqual([])
        expect(yield* sql`SELECT intent_id, attempts FROM actor_outbox ORDER BY bucket`).toEqual([
          { intent_id: "-128", attempts: 1 },
          { intent_id: "-9", attempts: 1 },
          { intent_id: "-8", attempts: 1 },
          { intent_id: "3", attempts: 1 },
          { intent_id: "4", attempts: 0 },
          { intent_id: "127", attempts: 0 },
        ])
      }),
    ))

  it("drains each owned range exactly once without claiming outside it or redelivering a failed settle", () =>
    database(
      Effect.gen(function* () {
        yield* seed
        const delivered: Array<Request> = []
        const relay = yield* outboxRelay(
          (request) =>
            Effect.sync(() => {
              delivered.push(request)
              return Outcome.cases.Success.make({ value: "{}" })
            }),
          () => [],
          settings,
        ).pipe(
          Effect.provideService(ShardMap, ranges),
          Effect.provideService(TurnHooks, {
            at: (point) =>
              point === "beforeOutboxDelete"
                ? Effect.die(new Error("Injected settle failure"))
                : Effect.void,
          }),
        )
        yield* relay.drain
        expect(delivered.map((row) => row.commandId).sort()).toEqual(["-128", "-8", "-9", "3"])
        const sql = yield* SqlClient.SqlClient
        expect(yield* sql`SELECT bucket, attempts FROM actor_outbox ORDER BY bucket`).toEqual([
          { bucket: -128, attempts: 1 },
          { bucket: -9, attempts: 1 },
          { bucket: -8, attempts: 1 },
          { bucket: 3, attempts: 1 },
          { bucket: 4, attempts: 0 },
          { bucket: 127, attempts: 0 },
        ])
      }),
    ))

  it("pins each targeted range to its own session and never sets the shared pool's target", () =>
    database(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const clients = yield* shardClients.pipe(
          Effect.provideService(ShardMap, [
            { first: -128, last: -1, shard: "shard-a" },
            { first: 0, last: 127, shard: "shard-'b" },
          ]),
        )
        const read = (client: SqlClient.SqlClient) => client<{
          target: string | null
          pid: number
        }>`
        SELECT current_setting('__neki.shard', true) AS target, pg_backend_pid() AS pid`
        const first = yield* read(clients[0]!.sql)
        const second = yield* read(clients[1]!.sql)
        expect(first[0]!.target).toBe("shard-a")
        expect(second[0]!.target).toBe("shard-'b")
        expect(first[0]!.pid).not.toBe(second[0]!.pid)
        expect(yield* read(clients[0]!.sql)).toEqual(first)
        expect((yield* read(sql))[0]!.target).toBeNull()
      }),
    ))

  it("rejects overlapping and out-of-bounds maps before any claim", () =>
    database(
      Effect.gen(function* () {
        for (const map of [
          [{ first: -129, last: 0 }],
          [{ first: 0, last: 128 }],
          [{ first: 2, last: 1 }],
          [
            { first: -128, last: 0 },
            { first: 0, last: 127 },
          ],
        ])
          expect(
            (yield* shardClients.pipe(Effect.provideService(ShardMap, map), Effect.exit))._tag,
          ).toBe("Failure")
      }),
    ))
})
