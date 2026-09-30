import { createServer, connect, type Socket, type AddressInfo } from "node:net"
import { pgTable, text } from "drizzle-orm/pg-core"
import {
  Cause,
  Crypto,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
  Tracer,
} from "effect"
import type { Scope } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor, ActorError, ActorUnavailable, Actors, Intent } from "../../index.ts"
import { Database } from "../../runtime/layer.ts"
import { TurnHooks, type TurnPoint } from "../../runtime/turn/hooks.ts"
import type { Request } from "../../handles/actors.ts"
import { NekiTurnSessions } from "../../runtime/database/neki/session.ts"
import { TurnPoolSettings } from "../../runtime/turn/pipeline.ts"
import { ActorTest, ClusterMember } from "../actor-test.ts"
import { enqueue, holding } from "./batches.ts"
import type { ConformanceCase, ConformanceEnvironment } from "../conformance.ts"

const marks = Actor.table(pgTable("pipeline_marks", { id: text("id").primaryKey() }))

const Add = Actor.command("Add", {
  input: Schema.Finite,
  output: Schema.Finite,
})

const Mark = Actor.command("Mark", {
  input: Schema.String,
  output: Schema.Finite,
})

const Tap = Actor.command("Tap", { output: Schema.Finite })

const Meter = Actor.make("Meter", {
  key: Schema.String,
  state: Actor.state({
    count: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  tables: [marks],
  api: { Add, Mark, Tap },
})

const Defer = Actor.command("Defer", {
  input: Schema.Finite,
  output: Schema.Finite,
})

const Remind = Actor.command("Remind", {})

class Ping extends Actor.effect<Ping>()("Ping", { input: {}, success: Schema.String }) {}

const PingLater = Actor.command("PingLater", { input: Schema.Finite })

const CancelPing = Actor.command("CancelPing", {})

const Plain = Actor.make("Plain", {
  key: Schema.String,
  state: Actor.state({
    count: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  effects: [Ping],
  api: { Add, Defer, PingLater, CancelPing },
  internal: { Remind },
})

const AddPayload = Schema.fromJsonString(Schema.Struct({ value: Schema.Finite }))

/** A runner's turn hooks: an effect at each fault point. */
interface TestHooks {
  readonly at: (point: TurnPoint, request: Request) => Effect.Effect<void>
}

interface Probe {
  /** Client writes sent after the server last answered: one per round trip. */
  flights: number
  /** The client bytes of each flight, in order. */
  readonly sent: Array<Buffer>
  handled: number
}

const add = Effect.fnUntraced(function* (probe: Probe, amount: number) {
  probe.handled += 1
  const turn = yield* Meter.Turn
  yield* turn.state.set({ count: turn.state.count + amount })

  return turn.state.count
})

const actorsLive = (probe: Probe) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS pipeline_marks (
        routing_key bigint, tenant_id text, actor_id text, id text,
        PRIMARY KEY (routing_key, tenant_id, actor_id, id))`)

      return Layer.mergeAll(
        Meter.toLayer(
          Effect.succeed({
            Add: (amount: number) => add(probe, amount),
            Mark: Effect.fnUntraced(function* (id: string) {
              probe.handled += 1
              const turn = yield* Meter.Turn
              yield* turn.rows(marks).insert({ id })

              return yield* turn.rows(marks).count()
            }),
            Tap: Effect.fnUntraced(function* () {
              probe.handled += 1

              return (yield* Meter.Turn).state.count
            }),
          }),
        ),
        Plain.toLayer(
          Effect.succeed({
            Add: Effect.fnUntraced(function* (amount: number) {
              probe.handled += 1
              const turn = yield* Plain.Turn
              yield* turn.state.set({ count: turn.state.count + amount })

              return turn.state.count
            }),
            Defer: Effect.fnUntraced(function* (pauseMs: number) {
              probe.handled += 1
              yield* Effect.sleep(pauseMs)
              const turn = yield* Plain.Turn
              const self = yield* Plain.intents(turn.id)
              yield* self.Remind().pipe(Intent.after("1 hour"))

              return turn.state.count
            }),
            Remind: () => Effect.void,
            PingLater: Effect.fnUntraced(function* (pauseMs: number) {
              probe.handled += 1
              yield* Effect.sleep(pauseMs)
              yield* (yield* Plain.Turn).perform(Ping.make({}), {
                key: "ping",
                after: Duration.hours(1),
              })
            }),
            CancelPing: Effect.fnUntraced(function* () {
              probe.handled += 1
              yield* (yield* Plain.Turn).cancelEffect("ping")
            }),
          }),
        ),
        Plain.toEffectLayer(Effect.succeed({ Ping: () => Effect.succeed("pong") })),
      )
    }).pipe(Effect.orDie),
  )

interface Relay {
  readonly port: number
  readonly close: () => void
  /** Drops every connection and refuses new ones, as an unreachable database would. */
  readonly cut: () => void
  readonly restore: () => void
}

/**
 * A TCP relay in front of Postgres, for the turn pool unless a case routes
 * every pool through it. The relay counts a flight each time the client
 * writes after the server has answered, which is one network round trip no
 * matter how the kernel splits the bytes.
 */
const relay = (url: URL, probe: Probe) =>
  Effect.acquireRelease(
    Effect.callback<Relay>((resume) => {
      const sockets = new Set<Socket>()
      let refusing = false

      const server = createServer((client) => {
        if (refusing) return void client.destroy()

        const upstream = connect({
          host: url.hostname,
          port: Number(url.port || 5432),
        })

        let answered = true

        sockets.add(client)
        sockets.add(upstream)
        client.setNoDelay(true)
        upstream.setNoDelay(true)
        client.on("data", (chunk: Buffer) => {
          if (answered) {
            probe.flights += 1
            probe.sent.push(chunk)
          } else probe.sent[probe.sent.length - 1] = Buffer.concat([probe.sent.at(-1)!, chunk])

          answered = false
          upstream.write(chunk)
        })
        upstream.on("data", (chunk: Buffer) => {
          answered = true
          client.write(chunk)
        })

        const end = () => {
          client.destroy()
          upstream.destroy()
        }

        client.on("close", end)
        upstream.on("close", end)
        client.on("error", end)
        upstream.on("error", end)
      })

      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        resume(
          Effect.succeed({
            port: (address as AddressInfo).port,
            close: () => {
              for (const socket of sockets) socket.destroy()
              server.close()
            },
            cut: () => {
              refusing = true

              for (const socket of sockets) socket.destroy()
            },
            restore: () => {
              refusing = false
            },
          }),
        )
      })
    }),
    (listening) => Effect.sync(listening.close),
  )

/**
 * Runs `body` on a runner over a fresh database whose turn sessions go
 * through the counting relay. `prepare: false` sends every statement's text,
 * so a case can read the order of statements inside a flight.
 */
const withProbe = <A, E>(
  environment: ConformanceEnvironment,
  options: {
    readonly prepare?: boolean
    readonly everyPool?: boolean
    /** Turn hooks the runner sees at every point no queued fault takes. */
    readonly hooks?: TestHooks
    /** The runner's tracer, so a case can read the spans turns open. */
    readonly tracer?: Tracer.Tracer
  },
  body: (
    probe: Probe,
    database: Redacted.Redacted<string>,
    relay: Relay,
  ) => Effect.Effect<A, E, Actors | ActorTest | SqlClient.SqlClient | Scope.Scope>,
) =>
  environment
    .run(Effect.all([Effect.service(Crypto.Crypto), Effect.service(NekiTurnSessions)]))
    .then(([crypto, neki]) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(environment.stop, () => environment.restart)
          const database = yield* environment.freshDatabase

          if (!Redacted.isRedacted(database))
            return yield* Effect.die(new Error("The pipeline cases need a Postgres database"))

          const probe: Probe = { flights: 0, sent: [], handled: 0 }
          const relayed = yield* relay(new URL(Redacted.value(database)), probe)
          const stream = () => connect({ host: "127.0.0.1", port: relayed.port, noDelay: true })

          const context = yield* Layer.build(
            actorsLive(probe).pipe(
              Layer.provideMerge(
                ActorTest.layer({
                  database,
                }).pipe(
                  Layer.provide(
                    Layer.succeed(TurnHooks, options.hooks ?? { at: () => Effect.void }),
                  ),
                ),
              ),
              Layer.provide(Layer.succeed(Tracer.Tracer, options.tracer ?? Tracer.nativeTracer)),
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(TurnPoolSettings, { stream, prepare: options.prepare !== false }),
                  Layer.succeed(NekiTurnSessions, neki),
                  options.everyPool === true
                    ? Layer.succeed(ClusterMember, { tenant: "pipeline", connect: stream })
                    : Layer.empty,
                ),
              ),
            ),
          )

          return yield* body(probe, database, relayed).pipe(Effect.provideContext(context))
        }).pipe(Effect.scoped, Effect.provideService(Crypto.Crypto, crypto)),
      ),
    )

/** Flights `effect` sends through the relay once warm connections are open. */
const flightsOf = <A, E, R>(probe: Probe, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const before = probe.flights
    const sent = probe.sent.length
    const value = yield* effect

    return {
      value,
      flights: probe.flights - before,
      sent: probe.sent.slice(sent),
    }
  })

const wire = (flight: Buffer) => flight.toString("latin1")

/** Positions of `fragments` in `flight`, in the order given; -1 when absent. */
const positions = (flight: Buffer, fragments: ReadonlyArray<string>) =>
  fragments.map((fragment) => wire(flight).indexOf(fragment))

const increasing = (values: ReadonlyArray<number>) =>
  values.every((value, index) => value >= 0 && (index === 0 || value > values[index - 1]!))

/**
 * Queues a rival behind the held turn's lock on the generation table, ahead of
 * the next batch's admission. Postgres grants a queued table lock to its
 * waiter when the holder commits, so a `FOR UPDATE` sent in the same flight as
 * that COMMIT waits behind the rival. A row lock gives no such order: the
 * statement can lock the row it finds committed before the waiting rival wakes,
 * and the batch then runs ahead of the takeover the case needs to fence it.
 */
const takeoverLock = "LOCK TABLE actor_generations IN EXCLUSIVE MODE"

/** Another runner's connection to the same database. */
const rival = (database: Redacted.Redacted<string>) =>
  Layer.build(
    Database.postgres({
      url: database,
      maxConnections: 1,
      offTurnConnections: 1,
    }),
  )

/** Pipeline cases: round trips per turn, statement grouping and order across admission, handler, and commit, and batching of the pipelined worker. */
export const pipelineConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "pipeline: a warm turn and a wake each take two round trips, and a replay writes nothing",
    requiresIndependentConnections: true,
    run: ({ expect, environment }) =>
      withProbe(environment, {}, (probe) =>
        Effect.gen(function* () {
          const test = yield* ActorTest
          const meter = yield* Plain.get("warm")
          const first = yield* flightsOf(probe, meter.Add(1))
          expect(first.value).toBe(1)
          yield* meter.Add(1)

          const warm = yield* flightsOf(probe, meter.Add(1))
          expect(warm).toMatchObject({ value: 3, flights: 2 })

          const wake = yield* flightsOf(probe, (yield* Plain.get("woken")).Add(1))
          expect(wake).toMatchObject({ value: 1, flights: 2 })

          yield* test.invalidate(meter.ref)
          const reloaded = yield* flightsOf(probe, meter.Add(1))
          expect(reloaded).toMatchObject({ value: 4, flights: 4 })

          const id = yield* (yield* Actors).mintCommandId
          expect(yield* meter.Add(5).pipe(Actor.commandId(id))).toBe(9)
          const handled = probe.handled
          const replay = yield* flightsOf(probe, meter.Add(5).pipe(Actor.commandId(id)))
          expect(replay.value).toBe(9)
          expect(replay.flights <= 2).toBe(true)
          expect(
            replay.sent.every((flight) => !wire(flight).includes("INSERT INTO actor_receipts")),
          ).toBe(true)
          expect(probe.handled).toBe(handled)
          expect(yield* test.receiptsFor(meter.ref, "Add")).toBe(5)
        }),
      ),
  },
  {
    name: "pipeline: each awaited handler statement adds one round trip on the turn session",
    requiresIndependentConnections: true,
    run: ({ expect, environment }) =>
      withProbe(environment, {}, (probe) =>
        Effect.gen(function* () {
          const meter = yield* Meter.get("rows")
          yield* meter.Mark("a")
          yield* meter.Tap()

          const tap = yield* flightsOf(probe, meter.Tap())
          const mark = yield* flightsOf(probe, meter.Mark("b"))
          expect(mark.value).toBe(2)
          expect(mark.flights).toBe(tap.flights + 2)
          expect(tap.flights).toBe(2)
        }),
      ),
  },
  {
    name: "pipeline: admission, handler, and commit statements keep their groups and order",
    requiresIndependentConnections: true,
    run: ({ expect, environment }) =>
      withProbe(environment, { prepare: false }, (probe) =>
        Effect.gen(function* () {
          yield* (yield* Plain.get("warmup")).Add(1)
          const meter = yield* Plain.get("order")
          const cold = yield* flightsOf(probe, meter.Add(1))
          const warm = yield* flightsOf(probe, meter.Add(1))
          expect([cold.flights, warm.flights]).toEqual([2, 2])

          const [coldAdmission, coldCommit] = cold.sent
          expect(
            increasing(
              positions(coldAdmission!, [
                "BEGIN",
                "INSERT INTO actor_generations",
                "set_config",
                "FOR UPDATE OF g",
                "UPDATE actor_generations SET generation",
                "SELECT key, value FROM actor_state",
              ]),
            ),
          ).toBe(true)
          expect(wire(coldAdmission!)).not.toContain("COMMIT")
          expect(
            increasing(
              positions(coldCommit!, [
                "INSERT INTO actor_state",
                "INSERT INTO actor_receipts",
                "COMMIT",
              ]),
            ),
          ).toBe(true)

          const [warmAdmission, warmCommit] = warm.sent
          expect(
            increasing(positions(warmAdmission!, ["BEGIN", "set_config", "FOR UPDATE OF g"])),
          ).toBe(true)
          expect(wire(warmAdmission!)).not.toContain("INSERT INTO actor_generations")
          expect(wire(warmAdmission!)).not.toContain("FROM actor_state")
          expect(wire(warmCommit!)).not.toContain("BEGIN")
          expect(
            increasing(
              positions(warmCommit!, [
                "INSERT INTO actor_state",
                "INSERT INTO actor_receipts",
                "COMMIT",
              ]),
            ),
          ).toBe(true)
        }),
      ),
  },
  {
    name: "pipeline: a stale cached generation sends no writes, rolls back, and reloads committed state",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withProbe(environment, { prepare: false }, (probe, database) =>
        Effect.gen(function* () {
          const test = yield* ActorTest
          const meter = yield* Plain.get("stale")
          expect(yield* meter.Add(1)).toBe(1)
          expect(yield* meter.Add(1)).toBe(2)
          const before = Number((yield* test.inspect(meter.ref)).generation)

          const context = yield* rival(database)
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`UPDATE actor_generations SET generation = generation + 1
                  WHERE actor_type = 'Plain' AND actor_id = ${meter.ref.id}`
                yield* sql`DELETE FROM actor_state WHERE actor_type = 'Plain' AND actor_id = ${meter.ref.id}`
              }),
            )
          }).pipe(Effect.provideContext(context), Effect.orDie)

          const handled = probe.handled
          const stale = yield* flightsOf(probe, meter.Add(10))
          expect(stale.value).toBe(10)
          expect(probe.handled).toBe(handled + 1)
          const [staleAdmission, staleEnd] = stale.sent
          expect(wire(staleAdmission!)).toContain("FOR UPDATE OF g")
          expect(wire(staleAdmission!)).not.toContain("UPDATE actor_generations SET generation")
          expect(wire(staleEnd!)).toContain("ROLLBACK")
          expect(wire(staleEnd!)).not.toContain("INSERT INTO actor_state")
          expect(wire(staleEnd!)).not.toContain("INSERT INTO actor_receipts")

          const inspection = yield* test.inspect(meter.ref)
          expect(inspection).toMatchObject({
            state: { count: 10 },
            receipts: 3,
          })
          expect(Number(inspection.generation)).toBe(before + 2)
        }),
      ),
  },
  {
    name: "pipeline: a turn waiting on the fence of a rival takeover reloads instead of committing",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withProbe(environment, {}, (probe, database) =>
        Effect.gen(function* () {
          const test = yield* ActorTest
          const meter = yield* Plain.get("fenced")
          expect(yield* meter.Add(1)).toBe(1)
          expect(yield* meter.Add(1)).toBe(2)
          const context = yield* rival(database)
          const handled = probe.handled
          const add = meter.Add(10)
          let turn: Fiber.Fiber<Effect.Success<typeof add>, Effect.Error<typeof add>> | undefined

          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`SELECT 1 FROM actor_generations
                  WHERE actor_type = 'Plain' AND actor_id = ${meter.ref.id} FOR UPDATE`
                turn = yield* Effect.forkDetach(add)
                yield* Effect.gen(function* () {
                  const waiting = yield* sql<{ waiting: boolean }>`
                    SELECT count(*) > 0 AS waiting FROM pg_stat_activity
                    WHERE wait_event_type = 'Lock' AND datname = current_database()
                      AND pid <> pg_backend_pid()`

                  if (!waiting[0]!.waiting) return yield* Effect.fail("not yet")
                }).pipe(Effect.retry(Schedule.spaced("20 millis")))
                expect(probe.handled).toBe(handled)
                yield* sql`UPDATE actor_generations SET generation = generation + 1
                  WHERE actor_type = 'Plain' AND actor_id = ${meter.ref.id}`
                yield* sql`DELETE FROM actor_state WHERE actor_type = 'Plain' AND actor_id = ${meter.ref.id}`
              }),
            )
          }).pipe(Effect.provideContext(context), Effect.orDie)

          expect(yield* Fiber.join(turn!)).toBe(10)
          expect(probe.handled).toBe(handled + 1)
          expect(yield* test.inspect(meter.ref)).toMatchObject({
            state: { count: 10 },
            receipts: 3,
          })
        }),
      ),
  },
  {
    name: "pipeline: a failed statement in the commit group makes COMMIT roll back, fails the turn, and discards the cache",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withProbe(environment, { prepare: false }, (probe) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          const meter = yield* Plain.get("poisoned")
          expect(yield* meter.Add(1)).toBe(1)
          const handled = probe.handled

          yield* sql.unsafe(`CREATE SEQUENCE pipeline_poison`)
          yield* sql.unsafe(`CREATE FUNCTION pipeline_poison() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              IF nextval('pipeline_poison') = 1 THEN RAISE EXCEPTION 'poisoned receipt'; END IF;
              RETURN NEW;
            END $$`)
          yield* sql.unsafe(`CREATE TRIGGER pipeline_poison BEFORE INSERT ON actor_receipts
            FOR EACH ROW WHEN (NEW.actor_type = 'Plain') EXECUTE FUNCTION pipeline_poison()`)

          const sent = probe.sent.length
          const failed = yield* Effect.exit(meter.Add(2))
          expect(failed._tag).toBe("Failure")

          const flights = probe.sent.slice(sent).map(wire)
          expect(
            flights.some(
              (flight) => flight.includes("INSERT INTO actor_state") && flight.includes("COMMIT"),
            ),
          ).toBe(true)
          expect(probe.handled).toBe(handled + 1)
          expect(yield* test.inspect(meter.ref)).toMatchObject({
            state: { count: 1 },
            receipts: 1,
          })
          expect(yield* meter.Add(4)).toBe(5)
          expect(yield* test.inspect(meter.ref)).toMatchObject({
            state: { count: 5 },
            receipts: 2,
          })
        }),
      ),
  },
  {
    name: "pipeline: a crash before commit rolls the turn back and the retry starts a fresh transaction",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withProbe(environment, {}, (probe) =>
        Effect.gen(function* () {
          const test = yield* ActorTest
          const meter = yield* Plain.get("crash")
          expect(yield* meter.Add(1)).toBe(1)
          yield* test.crashNext("beforeCommit")
          expect(yield* meter.Add(2)).toBe(3)
          expect(yield* meter.Add(3)).toBe(6)
          expect(probe.handled).toBe(4)
          expect(yield* test.inspect(meter.ref)).toMatchObject({
            state: { count: 6 },
            receipts: 3,
          })
        }),
      ),
  },
  {
    name: "pipeline: a crash after commit resolves the retry through the receipt without rerunning the handler",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withProbe(environment, {}, (probe) =>
        Effect.gen(function* () {
          const test = yield* ActorTest
          const meter = yield* Plain.get("after-commit")
          expect(yield* meter.Add(1)).toBe(1)
          yield* test.crashNext("afterCommit")
          expect(yield* meter.Add(2)).toBe(3)
          expect(yield* meter.Add(3)).toBe(6)
          expect(probe.handled).toBe(3)
          expect(yield* test.inspect(meter.ref)).toMatchObject({
            state: { count: 6 },
            receipts: 3,
          })
        }),
      ),
  },
  {
    name: "pipeline: a delayed intent keeps two round trips and is due its delay after commit",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withProbe(environment, { prepare: false }, (probe) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const meter = yield* Plain.get("delayed")
          yield* meter.Add(1)
          yield* meter.Add(1)

          const clock = sql<{ now: string }>`
            SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now`

          const before = Number((yield* clock)[0]!.now)
          const deferred = yield* flightsOf(probe, meter.Defer(400))
          expect(deferred).toMatchObject({ value: 2, flights: 2 })

          const [row] = yield* sql<{ due: string; scheduled: string }>`
            SELECT due_at_ms::text AS due, scheduled_at_ms::text AS scheduled FROM actor_outbox
            WHERE actor_type = 'Plain' AND actor_id = ${meter.ref.id} AND command = 'Remind'`

          expect(Number(row!.due) >= before + 400 + 3_600_000).toBe(true)
          expect(row!.scheduled).toBe(row!.due)

          const commit = wire(deferred.sent[1]!)
          const moved = commit.slice(commit.indexOf("UPDATE actor_outbox"))
          const shift = moved.slice(0, moved.indexOf("WHERE"))
          expect(shift.split("clock_timestamp()").length - 1).toBe(1)
        }),
      ),
  },
  {
    name: "pipeline: a batch of waiting commands takes two round trips, and its savepoints add none",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withProbe(environment, { prepare: false }, (probe) =>
        Effect.gen(function* () {
          const meter = yield* Meter.get("batched")
          yield* meter.Tap()

          const taps = yield* flightsOf(
            probe,
            Effect.gen(function* () {
              const first = yield* holding(meter.Tap())

              const waiting = yield* enqueue(
                Array.from({ length: 8 }, () => Effect.orDie(meter.Tap())),
              )

              const before = probe.flights
              yield* first.release
              yield* Fiber.join(first.fiber)

              return { before, replies: yield* Effect.forEach(waiting, Fiber.join) }
            }),
          )

          expect(probe.flights - taps.value.before).toBe(2)
          const batch = probe.sent.slice(-2).map(wire)
          expect(batch[0]!.indexOf("COMMIT") < batch[0]!.indexOf("FOR UPDATE OF g")).toBe(true)
          expect(batch[1]).toContain("COMMIT")
          expect(batch.join("").split("SAVEPOINT durable_handler").length - 1).toBe(3)

          const first = yield* holding(meter.Tap())

          const waiting = yield* enqueue(
            ["m1", "m2", "m3", "m4"].map((id) => Effect.orDie(meter.Mark(id))),
          )

          const before = probe.flights
          yield* first.release
          yield* Fiber.join(first.fiber)
          expect(yield* Effect.forEach(waiting, Fiber.join)).toEqual([1, 2, 3, 4])
          expect(probe.flights - before).toBe(1 + 4 * 2 + 1)
          expect(
            probe.sent
              .slice(-9)
              .map(wire)
              .every((flight) => /insert|select|commit/i.test(flight)),
          ).toBe(true)
        }),
      ),
  },
  {
    name: "pipeline: the next batch's admission rides in the previous batch's commit flight, and its handlers wait for their own fence",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withProbe(environment, { prepare: false }, (probe, database) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const meter = yield* Plain.get("riding")
          expect(yield* meter.Add(1)).toBe(1)
          const context = yield* rival(database)
          const first = yield* holding(meter.Add(1))
          const waiting = yield* enqueue([meter.Add(10), meter.Add(100)].map(Effect.orDie))
          const handled = probe.handled
          const sent = probe.sent.length
          const gate = yield* Deferred.make<void>()
          const rivalPid = yield* Deferred.make<number>()

          const lockWaiters = sql<{ pid: number }>`SELECT pid FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND datname = current_database()`

          const waitFor = (found: (pids: ReadonlyArray<number>) => boolean) =>
            Effect.gen(function* () {
              const pids = (yield* lockWaiters).map(({ pid }) => pid)

              if (!found(pids)) return yield* Effect.fail("not yet")
            }).pipe(Effect.retry(Schedule.spaced("20 millis")), Effect.orDie)

          const takeover = yield* Effect.forkDetach(
            Effect.gen(function* () {
              const rivalSql = yield* SqlClient.SqlClient

              yield* rivalSql.withTransaction(
                Effect.gen(function* () {
                  const [row] = yield* rivalSql<{ pid: number }>`SELECT pg_backend_pid() AS pid`
                  yield* Deferred.succeed(rivalPid, row!.pid)
                  yield* rivalSql.unsafe(takeoverLock)
                  yield* Deferred.await(gate)
                  yield* rivalSql`UPDATE actor_generations SET generation = generation + 1
                    WHERE actor_type = 'Plain' AND actor_id = ${meter.ref.id}`
                }),
              )
            }).pipe(Effect.provideContext(context), Effect.orDie),
          )

          const pid = yield* Deferred.await(rivalPid)
          yield* waitFor((pids) => pids.includes(pid))
          yield* first.release
          expect(yield* Fiber.join(first.fiber)).toBe(2)

          yield* waitFor((pids) => pids.some((waiter) => waiter !== pid))
          expect(probe.handled).toBe(handled)

          const riding = probe.sent
            .slice(sent)
            .map(wire)
            .find((flight) => flight.includes("COMMIT") && flight.includes("FOR UPDATE OF g"))

          expect(riding === undefined).toBe(false)
          expect(riding!.indexOf("COMMIT") < riding!.indexOf("FOR UPDATE OF g")).toBe(true)

          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(takeover)
          expect(yield* Effect.forEach(waiting, Fiber.join)).toEqual([12, 112])
          expect(probe.handled).toBe(handled + 2)
        }),
      ),
  },
  {
    name: "pipeline: a batch whose commit fails rolls back the next batch before its handlers run, and every caller retries once",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withProbe(environment, { prepare: false }, (probe) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          const meter = yield* Plain.get("failing")
          expect(yield* meter.Add(1)).toBe(1)
          const handled = probe.handled
          const first = yield* holding(meter.Add(1))
          const failing = yield* enqueue([meter.Add(10), meter.Add(100)].map(Effect.orDie))
          const paused = yield* test.pauseNext("beforeCommit")
          yield* first.release
          expect(yield* Fiber.join(first.fiber)).toBe(2)
          yield* paused.reached

          const next = yield* enqueue([meter.Add(1000), meter.Add(10000)].map(Effect.orDie))
          yield* sql.unsafe(`CREATE SEQUENCE pipeline_batch_poison`)
          yield* sql.unsafe(`CREATE FUNCTION pipeline_batch_poison() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              IF nextval('pipeline_batch_poison') = 1 THEN RAISE EXCEPTION 'poisoned receipt'; END IF;
              RETURN NEW;
            END $$`)
          yield* sql.unsafe(`CREATE TRIGGER pipeline_batch_poison BEFORE INSERT ON actor_receipts
            FOR EACH ROW WHEN (NEW.actor_type = 'Plain') EXECUTE FUNCTION pipeline_batch_poison()`)
          const sent = probe.sent.length
          yield* paused.release

          expect(yield* Effect.forEach(failing, Fiber.join)).toEqual([12, 112])
          expect(yield* Effect.forEach(next, Fiber.join)).toEqual([1112, 11112])

          expect(
            probe.sent
              .slice(sent)
              .map(wire)
              .some(
                (flight) =>
                  flight.includes("INSERT INTO actor_receipts") &&
                  flight.indexOf("COMMIT") < flight.lastIndexOf("FOR UPDATE OF g"),
              ),
          ).toBe(true)
          expect(probe.handled - handled).toBe(1 + 2 * 2 + 2)
          expect(yield* test.inspect(meter.ref)).toMatchObject({
            state: { count: 11112 },
            receipts: 6,
          })
        }),
      ),
  },
  {
    name: "pipeline: a later batch stays hidden until its own commit",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withProbe(environment, {}, () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          const meter = yield* Plain.get("hidden")
          expect(yield* meter.Add(1)).toBe(1)
          const first = yield* holding(meter.Add(1))
          const later = yield* enqueue([meter.Defer(0), meter.Defer(0)].map(Effect.orDie))
          const paused = yield* test.pauseNext("beforeCommit")
          yield* first.release
          expect(yield* Fiber.join(first.fiber)).toBe(2)
          yield* paused.reached

          const reminders = sql<{ count: number }>`SELECT count(*)::integer AS count
            FROM actor_outbox WHERE actor_type = 'Plain' AND actor_id = ${meter.ref.id}`

          expect(later.map((fiber) => fiber.pollUnsafe())).toEqual([undefined, undefined])
          expect((yield* reminders)[0]!.count).toBe(0)
          yield* paused.release
          expect(yield* Effect.forEach(later, Fiber.join)).toEqual([2, 2])
          expect((yield* reminders)[0]!.count).toBe(2)
        }),
      ),
  },
  {
    name: "pipeline: a defect after a batch commits restarts the activation, and every caller gets its committed outcome",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) => {
      const failing = new Set([2, 20])

      const hooks: TestHooks = {
        at: (point, request) =>
          point !== "afterCommit" || request.command !== "Add"
            ? Effect.void
            : Schema.decodeEffect(AddPayload)(request.payload).pipe(
                Effect.orDie,
                Effect.flatMap(({ value }) =>
                  failing.delete(value)
                    ? Effect.die(new Error("Defect after commit"))
                    : Effect.void,
                ),
              ),
      }

      return withProbe(environment, { hooks }, (probe) =>
        Effect.gen(function* () {
          const test = yield* ActorTest
          const meter = yield* Plain.get("after-commit-defect")
          expect(yield* meter.Add(1)).toBe(1)

          const handled = probe.handled
          expect(yield* meter.Add(2)).toBe(3)
          expect(probe.handled).toBe(handled + 1)

          const first = yield* holding(meter.Add(4))
          const waiting = yield* enqueue([meter.Add(20), meter.Add(40)].map(Effect.orDie))
          yield* first.release
          expect(yield* Fiber.join(first.fiber)).toBe(7)
          expect(yield* Effect.forEach(waiting, Fiber.join)).toEqual([27, 67])
          expect(probe.handled).toBe(handled + 4)
          expect(yield* test.inspect(meter.ref)).toMatchObject({
            state: { count: 67 },
            receipts: 5,
          })
        }),
      )
    },
  },
  {
    name: "pipeline: each pipelined batch has its own span, not the span of the batch before it",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) => {
      const spans: Array<Tracer.NativeSpan> = []

      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)

          return span
        },
      })

      return withProbe(environment, { tracer }, () =>
        Effect.gen(function* () {
          const meter = yield* Plain.get("spans")
          yield* meter.Add(1)
          const held = yield* (yield* Actors).mintCommandId
          const before = spans.length
          const first = yield* holding(meter.Add(1).pipe(Actor.commandId(held)))
          const waiting = yield* enqueue([meter.Add(10), meter.Add(100)].map(Effect.orDie))
          yield* first.release
          yield* Fiber.join(first.fiber)
          yield* Effect.forEach(waiting, Fiber.join)

          const turns = spans
            .slice(before)
            .filter((span) => span.name.startsWith("durable-actors.Plain/"))

          const lone = turns.filter((span) => span.attributes.get("command.id") === held)
          const batch = turns.filter((span) => span.name === "durable-actors.Plain/batch")
          expect(lone.map((span) => span.name)).toEqual(["durable-actors.Plain/Add"])
          expect(batch.map((span) => span.attributes.get("batch.size"))).toEqual([2])
          expect(batch[0]!.links.length).toBe(2)

          expect(Option.getOrUndefined(batch[0]!.parent)?.spanId === lone[0]!.spanId).toBe(false)
        }),
      )
    },
  },
  {
    name: "pipeline: a keyed delayed effect, its replacement, and its cancellation each keep two round trips",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withProbe(environment, {}, (probe) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const plain = yield* Plain.get("pinged")
          yield* plain.Add(1)
          yield* plain.Add(1)

          const clock = sql<{ now: string }>`
            SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now`

          const pings = sql<{ due: string; ready: string; key: string | null }>`
            SELECT due_at_ms::text AS due, ready_at_ms::text AS ready, timer_key AS key
            FROM actor_outbox WHERE actor_type = 'Plain' AND actor_id = ${plain.ref.id}
              AND kind = 'effect' AND command = 'Ping'`

          const before = Number((yield* clock)[0]!.now)
          expect((yield* flightsOf(probe, plain.PingLater(400))).flights).toBe(2)

          const [first] = yield* pings
          expect(Number(first!.due) >= before + 400 + 3_600_000).toBe(true)
          expect(first!.ready).toBe(first!.due)

          expect((yield* flightsOf(probe, plain.PingLater(0))).flights).toBe(2)
          expect((yield* pings).length).toBe(1)

          expect((yield* flightsOf(probe, plain.CancelPing())).flights).toBe(2)
          expect(yield* pings).toEqual([])
        }),
      ),
  },
  {
    name: "pipeline: an unreachable database fails a command id mint as ActorUnavailable, not a defect",
    requiresIndependentConnections: true,
    run: ({ expect, environment }) =>
      withProbe(environment, { everyPool: true }, (_probe, _database, relayed) =>
        Effect.gen(function* () {
          const meter = yield* Plain.get("unreachable")
          expect(yield* meter.Add(1)).toBe(1)

          const unavailable = (exit: Exit.Exit<unknown, unknown>) => {
            if (Exit.isSuccess(exit) || Cause.hasDies(exit.cause)) return false
            const error = Cause.findErrorOption(exit.cause)

            return (
              Option.isSome(error) &&
              Schema.is(ActorError)(error.value) &&
              Schema.is(ActorUnavailable)(error.value.reason)
            )
          }

          relayed.cut()
          const minted = yield* Effect.exit((yield* Actors).mintCommandId)
          const called = yield* Effect.exit(meter.Add(1))
          relayed.restore()

          expect(unavailable(minted)).toBe(true)
          expect(unavailable(called)).toBe(true)

          const retried = yield* meter
            .Add(1)
            .pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 50 }))

          expect(retried).toBe(2)
        }),
      ),
  },
  {
    name: "pipeline: a turn that loses the database mid-commit is answered, and its caller's retry commits it once",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withProbe(environment, { everyPool: true }, (probe, _database, relayed) =>
        Effect.gen(function* () {
          const test = yield* ActorTest
          const meter = yield* Plain.get("lost-mid-commit")
          expect(yield* meter.Add(1)).toBe(1)

          const id = yield* (yield* Actors).mintCommandId
          const committing = yield* test.pauseNext("beforeCommit")
          const handled = probe.handled

          const call = yield* meter.Add(2).pipe(
            Actor.commandId(id),
            Effect.retry({
              while: (error) => error.isRetryable,
              schedule: Schedule.spaced("100 millis"),
              times: 50,
            }),
            Effect.timeoutOption("10 seconds"),
            Effect.forkChild,
          )

          yield* committing.reached
          relayed.cut()
          yield* committing.release
          yield* Effect.sleep("1 second")
          relayed.restore()

          expect(yield* Fiber.join(call)).toEqual(Option.some(3))
          expect(probe.handled - handled).toBe(2)
          expect(yield* test.inspect(meter.ref)).toMatchObject({
            state: { count: 3 },
            receipts: 2,
          })
        }),
      ),
  },
  {
    name: "pipeline: a batch that loses the database mid-commit answers every command in it, and each caller's retry commits once",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withProbe(environment, { everyPool: true }, (probe, _database, relayed) =>
        Effect.gen(function* () {
          const test = yield* ActorTest
          const actors = yield* Actors
          const meter = yield* Plain.get("batch-lost-mid-commit")
          expect(yield* meter.Add(1)).toBe(1)

          const amounts = [2, 3, 4]
          const ids = yield* Effect.forEach(amounts, () => actors.mintCommandId)
          const handled = probe.handled

          const first = yield* holding(meter.Add(10))

          const calls = yield* enqueue(
            amounts.map((amount, index) =>
              meter.Add(amount).pipe(
                Actor.commandId(ids[index]!),
                Effect.retry({
                  while: (error) => error.isRetryable,
                  schedule: Schedule.spaced("100 millis"),
                  times: 50,
                }),
                Effect.timeoutOption("10 seconds"),
                Effect.orDie,
              ),
            ),
          )

          const inBatch = yield* test.pauseNext("beforeCommit")
          const thenInBatch = yield* test.pauseNext("beforeCommit")
          yield* first.release
          yield* Fiber.join(first.fiber)
          yield* inBatch.reached
          yield* inBatch.release
          yield* thenInBatch.reached

          expect(probe.handled - handled).toBe(1 + 2)
          relayed.cut()
          yield* thenInBatch.release
          yield* Effect.sleep("1 second")
          relayed.restore()

          const replies = yield* Effect.forEach(calls, Fiber.join)
          expect(replies.every(Option.isSome)).toBe(true)

          expect(probe.handled - handled).toBe(1 + amounts.length * 2)
          expect(yield* test.inspect(meter.ref)).toMatchObject({
            state: { count: 20 },
            receipts: 5,
          })
        }),
      ),
  },
]
