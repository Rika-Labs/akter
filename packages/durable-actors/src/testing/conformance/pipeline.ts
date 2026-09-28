import { createServer, connect, type Socket, type AddressInfo } from "node:net"
import { pgTable, text } from "drizzle-orm/pg-core"
import { Crypto, Duration, Effect, Fiber, Layer, Redacted, Schedule, Schema } from "effect"
import type { Scope } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor, Actors, Intent, User } from "../../index.ts"
import { Database } from "../../runtime/layer.ts"
import { TurnPoolSettings } from "../../runtime/turn/pipeline.ts"
import { ActorTest } from "../actor-test.ts"
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
            // Stages a one-hour reminder after a real-time pause, so a due
            // time measured from admission would land short of commit + 1 h.
            Defer: Effect.fnUntraced(function* (pauseMs: number) {
              probe.handled += 1
              yield* Effect.sleep(pauseMs)
              const turn = yield* Plain.Turn
              const self = yield* Plain.intents(turn.id)
              yield* self.Remind().pipe(Intent.after("1 hour"))

              return turn.state.count
            }),
            Remind: () => Effect.void,
            // Performs the keyed ping an hour out after a real-time pause, so
            // its due time too must be measured from commit.
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

/**
 * A TCP relay in front of Postgres for the turn pool only. The relay counts
 * a flight each time the client writes after the server has answered, which
 * is one network round trip no matter how the kernel splits the bytes.
 */
const relay = (url: URL, probe: Probe) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly port: number; readonly close: () => void }>((resume) => {
      const sockets = new Set<Socket>()

      const server = createServer((client) => {
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
  options: { readonly prepare?: boolean },
  body: (
    probe: Probe,
    database: Redacted.Redacted<string>,
  ) => Effect.Effect<A, E, Actors | ActorTest | SqlClient.SqlClient | Scope.Scope>,
) =>
  environment.run(Effect.service(Crypto.Crypto)).then((crypto) =>
    Effect.runPromise(
      Effect.gen(function* () {
        // The case's runner stands in for the suite's, which stops meanwhile.
        yield* Effect.acquireRelease(environment.stop, () => environment.restart)
        const database = yield* environment.freshDatabase

        if (!Redacted.isRedacted(database))
          return yield* Effect.die(new Error("The pipeline cases need a Postgres database"))

        const probe: Probe = { flights: 0, sent: [], handled: 0 }
        const { port } = yield* relay(new URL(Redacted.value(database)), probe)

        const context = yield* Layer.build(
          actorsLive(probe).pipe(
            Layer.provideMerge(
              ActorTest.layer({
                database,
                as: User.make({ subject: "alice" }),
              }),
            ),
            Layer.provide(
              Layer.succeed(TurnPoolSettings, {
                stream: () => connect({ host: "127.0.0.1", port, noDelay: true }),
                prepare: options.prepare !== false,
              }),
            ),
          ),
        )

        return yield* body(probe, database).pipe(Effect.provideContext(context))
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

/** Another runner's connection to the same database. */
const rival = (database: Redacted.Redacted<string>) =>
  Layer.build(
    Database.postgres({
      url: database,
      maxConnections: 1,
      offTurnConnections: 1,
    }),
  )

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

          // A generation bumped behind the activation costs the stale turn's
          // two round trips, then the reload's two.
          yield* test.invalidate(meter.ref)
          const reloaded = yield* flightsOf(probe, meter.Add(1))
          expect(reloaded).toMatchObject({ value: 4, flights: 4 })

          const id = yield* (yield* Actors).mintCommandId
          expect(yield* meter.Add(5).pipe(Actor.commandId(id))).toBe(9)
          const handled = probe.handled
          const replay = yield* flightsOf(probe, meter.Add(5).pipe(Actor.commandId(id)))
          // The cluster may answer a duplicate from its own reply record
          // before any turn; a turn that resolves it from the receipt sends
          // only the admission group and a rollback.
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
          // The insert and the count are awaited one after the other.
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
          // Opens the turn session so the measured turns carry no startup.
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

          // Another runner takes the actor over and commits: a new generation
          // and state the cache has never seen.
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
          // The stale activation's handler never ran on count 2: the retry
          // reloaded state the rival left, so the result is 0 + 10.
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

          // The rival holds the generation row while it takes over, so the
          // turn's fenced read waits for the rival to commit and then sees
          // the new generation.
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

          // The receipt insert fails once, after the state upsert queued
          // before it; the sequence is not transactional, so later turns pass.
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

          // The commit group carried the staged count and COMMIT, which the
          // server answered with ROLLBACK: nothing persisted, and the next
          // turn reads count 1 rather than the 3 the failed turn staged.
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
      withProbe(environment, {}, (probe) =>
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
        }),
      ),
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

          // Performing again under the key drops the unstarted row in the same group.
          expect((yield* flightsOf(probe, plain.PingLater(0))).flights).toBe(2)
          expect((yield* pings).length).toBe(1)

          expect((yield* flightsOf(probe, plain.CancelPing())).flights).toBe(2)
          expect(yield* pings).toEqual([])
        }),
      ),
  },
]
