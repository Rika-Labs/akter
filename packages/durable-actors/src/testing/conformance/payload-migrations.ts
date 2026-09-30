import { PGlite } from "@electric-sql/pglite"
import {
  Cause,
  Crypto,
  Deferred,
  type Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Match,
  Predicate,
  Redacted,
  Schedule,
  Schema,
  type Scope,
} from "effect"
import { SqlClient, type SqlError } from "effect/unstable/sql"
import { Actor, RetentionGap, UnknownCursor, User } from "../../index.ts"
import { InternalActors } from "../../runtime/actors.ts"
import type { PayloadMigrations } from "../../members/payload.ts"
import {
  checkPayloads,
  clearPayloads,
  formatPayloadProblem,
} from "../../runtime/payloads/versions.ts"
import { migrate, migrations, migrator } from "../../runtime/database/migrations.ts"
import { Database } from "../../runtime/layer.ts"
import { ActorTest } from "../actor-test.ts"
import { ActorCluster, type RunnerServices } from "../cluster.ts"
import type {
  ConformanceCase,
  ConformanceDatabase,
  ConformanceEnvironment,
} from "../conformance.ts"

/** What the executor, routes, and subscription handler saw, across deployments of one case. */
const seen = {
  executed: [] as Array<unknown>,
  deadLetters: [] as Array<{ readonly effect: unknown; readonly ambiguous: boolean }>,
  delivered: [] as Array<unknown>,
  /** How the next executor attempts end. */
  executor: "succeed" as "succeed" | "fail" | "die",
  /** Whether the subscription handler accepts deliveries; otherwise it dies and the row backs off. */
  accepting: true,
}

const reset = Effect.sync(() => {
  seen.executed.length = 0
  seen.deadLetters.length = 0
  seen.delivered.length = 0
  seen.executor = "succeed"
  seen.accepting = true
})

class Declined extends Schema.TaggedError<Declined>()("Declined", {}) {}

const Money = Schema.Struct({ amount: Schema.Finite, currency: Schema.String })

/** `Placed` and `Charge` before the currency change: an amount in US cents. */
const V0 = { orderId: Schema.String, amount: Schema.Finite }

const V1 = { orderId: Schema.String, total: Money }

const toV1 = Actor.migration(
  V0,
  V1,
  (v0) => {
    if (v0.amount < 0) throw new Error(`cannot convert ${v0.amount}`)

    return { orderId: v0.orderId, total: { amount: v0.amount, currency: "USD" } }
  },
  { downcast: (v1) => ({ orderId: v1.orderId, amount: v1.total.amount }) },
)

interface Variant {
  /** Chain shape: v0 alone, v1 with the step, v1 with the step dropped, or v1 writing v0. */
  readonly chain: "v0" | "v1" | "v1-from1" | "v1-write0"
  /** Registers the `Audit` subscriber. */
  readonly audit?: boolean
}

const migrationsOf = (variant: Variant): PayloadMigrations | undefined =>
  Match.value(variant.chain).pipe(
    Match.when("v0", () => undefined),
    Match.when("v1-from1", () => ({ from: 1, steps: [] })),
    Match.orElse(() => [toV1]),
  )

/**
 * One deployment of `Ledger`: `Place` emits `Placed` and performs `Charge`,
 * `History` reads `Placed` back, and `Audit` follows `Placed` by order id.
 */
const deployment = (variant: Variant) => {
  const current = (variant.chain === "v0" ? V0 : V1) as typeof V1

  const options = {
    migrations: migrationsOf(variant),
    writeVersion: variant.chain === "v1-write0" ? 0 : undefined,
  }

  class Placed extends Actor.Event<Placed>()("Placed", current, options) {}

  class Noted extends Actor.Event<Noted>()("Noted", { text: Schema.String }) {}

  class Charge extends Actor.effect<Charge>()("Charge", { input: current, ...options }) {}

  const Place = Actor.command("Place", {
    input: Schema.Struct({
      orderId: Schema.String,
      amount: Schema.Finite,
      after: Schema.optional(Schema.Finite),
    }),
  })

  const Note = Actor.command("Note", { input: Schema.String })

  const History = Actor.query("History", {
    output: Schema.Array(Schema.Json),
    errors: [UnknownCursor, RetentionGap],
  })

  const Lost = Actor.command("Lost", { input: Actor.DeadLetter(Charge) })

  const Watch = Actor.workflow("Watch", {
    input: { id: Schema.String },
    output: Schema.String,
    key: ({ id }) => id,
  })

  const AwaitPlaced = Watch.wait("placed", Placed)

  const Ledger = Actor.make("Ledger", {
    key: Schema.String,
    events: [Placed, Noted],
    effects: [Charge],
    api: { Place, Note, History, Watch },
    internal: { Lost },
    policy: {
      deliveryTimeout: "3 seconds",
      effects: {
        Charge: {
          retry: { times: 1, backoff: { base: "1 second", max: "1 second" } },
          onDeadLetter: Lost,
        },
      },
    },
  })

  const encodePlaced = (event: Placed) =>
    Schema.encodeUnknownEffect(Schema.toCodecJson(Placed))(event).pipe(Effect.orDie)

  const encodeCharge = (charge: Charge) =>
    Schema.encodeUnknownEffect(Schema.toCodecJson(Charge))(charge).pipe(Effect.orDie)

  const valueOf = (orderId: string, amount: number) =>
    variant.chain === "v0" ? { orderId, amount } : { orderId, total: { amount, currency: "USD" } }

  const ledger = Ledger.toLayer(
    Effect.succeed({
      Place: Effect.fnUntraced(function* ({ orderId, amount, after }) {
        const turn = yield* Ledger.Turn

        yield* turn.emit(Placed.make(valueOf(orderId, amount) as never))

        yield* turn.perform(
          Charge.make(valueOf(orderId, amount) as never),
          after === undefined ? undefined : { after: `${after} millis` },
        )
      }),
      Note: Effect.fnUntraced(function* (text: string) {
        yield* (yield* Ledger.Turn).emit(Noted.make({ text }))
      }),
      Watch: () => AwaitPlaced().pipe(Effect.as("placed")),
      Lost: (letter) =>
        encodeCharge(letter.effect).pipe(
          Effect.map((effect) => {
            seen.deadLetters.push({ effect, ambiguous: letter.ambiguous })
          }),
        ),
    }),
  )

  const queries = Ledger.toQueryLayer(
    Effect.succeed({
      History: Effect.fnUntraced(function* () {
        const read = yield* Ledger.Read

        return yield* Effect.forEach(yield* read.events(Placed), ({ event }) => encodePlaced(event))
      }),
    }),
  )

  const executors = Ledger.toEffectLayer(
    Effect.succeed({
      Charge: (charge: Charge) =>
        encodeCharge(charge).pipe(
          Effect.flatMap((encoded) => {
            seen.executed.push(encoded)

            return Match.value(seen.executor).pipe(
              Match.when("succeed", () => Effect.void),
              Match.when("fail", () => Effect.fail(Declined.make({}))),
              Match.orElse(() => Effect.die(new Error("provider connection reset"))),
            )
          }),
        ),
    }),
  )

  const auditLayer = () => {
    const Delivery = Actor.Delivery({ source: Ledger, events: [Placed] })

    const Record = Actor.command("Record", { input: Delivery })

    const Placements = Actor.subscription("Placements", {
      source: Ledger,
      events: [Placed],
      handler: Record,
      route: (event) => event.orderId,
    })

    const Audit = Actor.make("Audit", {
      key: Schema.String,
      api: {},
      internal: { Record },
      subscriptions: [Placements],
    })

    const audit = Audit.toLayer(
      Effect.succeed({
        Record: (delivery: typeof Delivery.Type) =>
          Effect.suspend(() => {
            if (!seen.accepting) return Effect.die(new Error("not accepting yet"))

            return Predicate.isTagged(delivery, "Event")
              ? encodePlaced(delivery.event).pipe(
                  Effect.map((event) => {
                    seen.delivered.push(event)
                  }),
                )
              : Effect.void
          }),
      }),
    )

    return audit
  }

  const layer = Layer.mergeAll(
    ledger,
    queries,
    executors,
    variant.audit === true ? auditLayer() : Layer.empty,
  )

  return {
    Ledger,
    layer: layer as Layer.Layer<never, never, RunnerServices>,
    place: (orderId: string, amount: number, after?: number) =>
      Ledger.get(orderId).pipe(
        Effect.flatMap((ledger) => ledger.Place({ orderId, amount, after })),
      ),
    history: (orderId: string) =>
      Ledger.get(orderId).pipe(Effect.flatMap((ledger) => ledger.History())),
    /** A `Placed` of the order as this deployment encodes it. */
    placed: (orderId: string, amount: number) =>
      encodePlaced(Placed.make(valueOf(orderId, amount) as never)),
    /** A `Charge` of the order as this deployment encodes it. */
    charge: (orderId: string, amount: number) =>
      encodeCharge(Charge.make(valueOf(orderId, amount) as never)),
    /** Starts a `Watch` execution and returns its id once it waits. */
    watch: (id: string) =>
      Ledger.get(id).pipe(
        Effect.flatMap((ledger) => ledger.Watch({ id })),
        Effect.map((run) => run.executionId),
      ),
  }
}

const Base = deployment({ chain: "v0" })

const Audited = deployment({ chain: "v0", audit: true })

const Next = deployment({ chain: "v1" })

const NextAudited = deployment({ chain: "v1", audit: true })

const Shortened = deployment({ chain: "v1-from1" })

const FirstPhase = deployment({ chain: "v1-write0" })

/** `Ledger` after its `Placed` class, and the workflow waiting on it, were removed. */
const Unplaced = (() => {
  class Noted extends Actor.Event<Noted>()("Noted", { text: Schema.String }) {}

  const Note = Actor.command("Note", { input: Schema.String })

  const Ledger = Actor.make("Ledger", { key: Schema.String, events: [Noted], api: { Note } })

  const layer = Ledger.toLayer(
    Effect.succeed({
      Note: Effect.fnUntraced(function* (text: string) {
        yield* (yield* Ledger.Turn).emit(Noted.make({ text }))
      }),
    }),
  )

  return { Ledger, layer: layer as Layer.Layer<never, never, RunnerServices> }
})()

const TENANT = "0b7f3a52-1c4d-4e6f-8a9b-3c5d7e9f1a2b"

type Deployed = Layer.Success<ReturnType<typeof ActorTest.layer>>

/**
 * One database every deployment of a case shares: a fresh Postgres database,
 * or one in-memory PGlite instance each deployment borrows in turn.
 */
const caseDatabase = (environment: ConformanceEnvironment) =>
  Effect.gen(function* () {
    const fresh = yield* environment.freshDatabase

    if (Redacted.isRedacted(fresh)) return fresh

    const pglite = yield* Effect.acquireRelease(
      Effect.sync(() => new PGlite()).pipe(
        Effect.tap((instance) => Effect.promise(() => instance.waitReady)),
      ),
      (instance) => Effect.promise(() => instance.close()),
    )

    return { liveClient: pglite } as ConformanceDatabase
  })

/** Runs `body` on a fresh runtime of `actors` against `database`, then stops it. */
const deploy = <A, E>(
  database: ConformanceDatabase,
  actors: Layer.Layer<never, never, RunnerServices>,
  body: Effect.Effect<A, E, Deployed | Crypto.Crypto>,
  options?: { readonly payloadWriterWindow?: Duration.Input },
) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto

    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() =>
        ManagedRuntime.make(
          actors.pipe(
            Layer.provideMerge(
              ActorTest.layer({
                database,
                as: User.make({ subject: "alice" }),
                retryWindowMs: 60_000,
                payloadWriterWindow: options?.payloadWriterWindow,
              }),
            ),
            Layer.provideMerge(Layer.succeed(Crypto.Crypto, crypto)),
          ),
        ),
      ),
      (runtime) => Effect.promise(() => runtime.dispose()),
    )

    return yield* Effect.promise(() =>
      runtime.runPromiseExit(body.pipe(Actor.tenant(TENANT))),
    ).pipe(Effect.flatten)
  }).pipe(Effect.scoped)

/** The startup failure of a deployment, pretty-printed; dies if it starts. */
const refusal = (
  database: ConformanceDatabase,
  actors: Layer.Layer<never, never, RunnerServices>,
) =>
  deploy(database, actors, Effect.void).pipe(
    Effect.exit,
    Effect.flatMap((exit) =>
      Exit.isFailure(exit)
        ? Effect.succeed(Cause.pretty(exit.cause))
        : Effect.die(new Error("The deployment started")),
    ),
  )

const query = <A>(statement: (sql: SqlClient.SqlClient) => Effect.Effect<A, SqlError.SqlError>) =>
  Effect.gen(function* () {
    return yield* statement(yield* SqlClient.SqlClient)
  }).pipe(Effect.orDie)

const eventVersions = query(
  (sql) => sql<{ version: number }>`SELECT payload_version AS version FROM actor_events
    WHERE actor_type = 'Ledger' AND event = 'Placed' ORDER BY sequence`,
).pipe(Effect.map((rows) => rows.map(({ version }) => version)))

const effectVersions = query(
  (sql) => sql<{ version: number }>`SELECT payload_version AS version FROM actor_outbox
    WHERE actor_type = 'Ledger' AND kind = 'effect' ORDER BY scheduled_at_ms, intent_id`,
).pipe(Effect.map((rows) => rows.map(({ version }) => version)))

const recordedVersions = query(
  (sql) => sql<{
    kind: string
    version: number
    superseded: boolean
    cleared: boolean
  }>`SELECT kind, version, superseded_at_ms IS NOT NULL AS superseded,
      cleared_at_ms IS NOT NULL AS cleared
    FROM actor_payload_versions WHERE actor_type = 'Ledger' AND tag IN ('Placed', 'Charge')
    ORDER BY kind, version`,
)

const status = (executionId: string) =>
  query(
    (sql) => sql<{ status: string }>`SELECT status FROM actor_workflow_executions
      WHERE execution_id = ${executionId}`,
  ).pipe(Effect.map((rows) => rows[0]?.status))

/** Waits until `check` holds, driving the relay; dies after 30 seconds. */
const eventually = <R>(
  check: Effect.Effect<boolean, never, R>,
  options?: { readonly drive?: boolean },
) =>
  Effect.gen(function* () {
    if (options?.drive !== false) yield* (yield* ActorTest).advance("0 millis")

    return yield* check
  }).pipe(
    Effect.repeat({ schedule: Schedule.spaced("50 millis"), until: (done) => done }),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.die(new Error("Timed out waiting for the relay")),
    }),
    Effect.asVoid,
  )

/** Moves every recorded supersession back past `Ledger`'s 30-day event horizon. */
const pastHorizon = query(
  (
    sql,
  ) => sql`UPDATE actor_payload_versions SET superseded_at_ms = superseded_at_ms - 31 * 86400000::bigint
    WHERE actor_type = 'Ledger' AND superseded_at_ms IS NOT NULL`,
)

const HOUR = 3_600_000

const withCase = <E>(
  environment: ConformanceEnvironment,
  body: (database: ConformanceDatabase) => Effect.Effect<void, E, Crypto.Crypto | Scope.Scope>,
) =>
  environment.run(
    Effect.gen(function* () {
      yield* reset
      yield* body(yield* caseDatabase(environment))
    }).pipe(Effect.orDie),
  )

/** Payload-version cases: the migration's guard on populated databases, stored payload versions, and upcasting of older events and effects through the chain. */
export const payloadMigrationsConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "payload migrations: refuses 0021_payload_versions on a database that already holds events, outbox rows, or dead letters",
    run: ({ expect, environment }) =>
      withCase(environment, (database) =>
        Effect.gen(function* () {
          const client = yield* Layer.build(
            Redacted.isRedacted(database)
              ? Database.postgres({ url: database, maxConnections: 2 })
              : Database.pglite(database),
          ).pipe(Effect.orDie)

          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* migrator(
              Object.fromEntries(Object.entries(migrations).filter(([id]) => id < "0021")),
            )
            yield* sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id)
              VALUES (1, 't', 'Ledger', 'o1')`
            yield* sql`INSERT INTO actor_outbox (routing_key, intent_id, bucket, due_at_ms,
                scheduled_at_ms, tenant_id, actor_type, actor_id, target_type, target_id, command,
                payload, caller)
              VALUES (1, 'pending', 0, 42, 42, 't', 'Ledger', 'o1', 'Ledger', 'o1', 'Note', '{}', '{}')`

            const refused = yield* Effect.exit(migrate)
            expect(Exit.isFailure(refused)).toBe(true)
            expect(Cause.pretty((refused as Exit.Failure<unknown, unknown>).cause)).toContain(
              "Migration 0021_payload_versions needs a database without events, outbox rows, or dead letters",
            )

            yield* sql`DELETE FROM actor_outbox`
            expect(yield* migrate).toEqual([
              [21, "payload_versions"],
              [22, "parent_placement"],
              [23, "operator_audit"],
              [24, "adoption"],
              [25, "fleet"],
            ])
          }).pipe(Effect.provideContext(client))
        }),
      ),
  },
  {
    name: "payload migrations: stores the current payload version with each emitted event and performed effect",
    run: ({ expect, environment }) =>
      withCase(environment, (database) =>
        deploy(
          database,
          Next.layer,
          Effect.gen(function* () {
            yield* Next.place("o1", 500, HOUR)
            expect(yield* eventVersions).toEqual([1])
            expect(yield* effectVersions).toEqual([1])
            expect(yield* recordedVersions).toEqual([
              { kind: "effect", version: 1, superseded: false, cleared: false },
              { kind: "event", version: 1, superseded: false, cleared: false },
            ])

            const views = yield* query(
              (sql) => sql<{
                version: number
              }>`SELECT payload_version AS version FROM durable.events
                WHERE actor_type = 'Ledger' UNION ALL
                SELECT payload_version FROM durable.effects WHERE actor_type = 'Ledger'`,
            )

            expect(views).toEqual([{ version: 1 }, { version: 1 }])
          }),
        ),
      ),
  },
  {
    name: "payload migrations: upcasts version-0 events written before a chain step was added through the chain in read.events, feeds, and subscription deliveries",
    run: ({ expect, environment }) =>
      withCase(environment, (database) =>
        Effect.gen(function* () {
          seen.accepting = false
          yield* deploy(database, Audited.layer, Audited.place("o1", 500, HOUR))

          yield* deploy(
            database,
            NextAudited.layer,
            Effect.gen(function* () {
              expect(yield* eventVersions).toEqual([0])
              expect(yield* NextAudited.history("o1")).toEqual([yield* Next.placed("o1", 500)])

              const internal = yield* InternalActors
              const ledger = yield* NextAudited.Ledger.get("o1")
              const feed = yield* internal.readFeed(ledger.ref, ["Placed"], undefined, 10)
              expect(feed.map(({ value }) => JSON.parse(value))).toEqual([
                yield* Next.placed("o1", 500),
              ])

              seen.accepting = true
              yield* query(
                (sql) => sql`UPDATE actor_subscriptions SET due_at_ms = 0, attempts = 0
                  WHERE source_type = 'Ledger'`,
              )
              yield* eventually(Effect.sync(() => seen.delivered.length > 0))
              expect(seen.delivered).toEqual([yield* Next.placed("o1", 500)])
            }),
          )
        }),
      ),
  },
  {
    name: "payload migrations: runs a pending effect written at an older version with the upcast payload",
    run: ({ expect, environment }) =>
      withCase(environment, (database) =>
        Effect.gen(function* () {
          yield* deploy(database, Base.layer, Base.place("o1", 700, HOUR))

          yield* deploy(
            database,
            Next.layer,
            Effect.gen(function* () {
              expect(yield* effectVersions).toEqual([0])
              yield* (yield* ActorTest).advance("61 minutes")
              yield* eventually(Effect.sync(() => seen.executed.length > 0))
              expect(seen.executed).toEqual([yield* Next.charge("o1", 700)])
            }),
          )
        }),
      ),
  },
  {
    name: "payload migrations: delivers an onDeadLetter route with the upcast effect and keeps the dead letter's version",
    run: ({ expect, environment }) =>
      withCase(environment, (database) =>
        Effect.gen(function* () {
          yield* deploy(database, Base.layer, Base.place("o1", 900, HOUR))
          seen.executor = "fail"

          yield* deploy(
            database,
            Next.layer,
            Effect.gen(function* () {
              yield* (yield* ActorTest).advance("61 minutes")
              yield* eventually(Effect.sync(() => seen.deadLetters.length > 0))
              expect(seen.deadLetters).toEqual([
                { effect: yield* Next.charge("o1", 900), ambiguous: false },
              ])

              expect(
                yield* query(
                  (sql) => sql<{ version: number }>`SELECT payload_version AS version
                    FROM actor_dead_letters WHERE actor_type = 'Ledger'`,
                ),
              ).toEqual([{ version: 0 }])
            }),
          )
        }),
      ),
  },
  {
    name: "payload migrations: resets payload_version to 0 when a settled effect row becomes its route intent",
    run: ({ expect, environment }) =>
      withCase(environment, (database) =>
        deploy(
          database,
          Next.layer,
          Effect.gen(function* () {
            yield* query(
              (sql) =>
                sql`CREATE TABLE payload_route_rows (kind text, command text, payload_version int)`,
            )
            yield* query(
              (sql) => sql`CREATE FUNCTION payload_route_copy() RETURNS trigger AS $$
                BEGIN
                  INSERT INTO payload_route_rows VALUES (NEW.kind, NEW.command, NEW.payload_version);
                  RETURN NEW;
                END $$ LANGUAGE plpgsql`,
            )
            yield* query(
              (sql) => sql`CREATE TRIGGER payload_route_copy AFTER UPDATE OF kind ON actor_outbox
                FOR EACH ROW EXECUTE FUNCTION payload_route_copy()`,
            )

            seen.executor = "fail"
            yield* Next.place("o1", 300)
            yield* eventually(Effect.sync(() => seen.deadLetters.length > 0))

            expect(
              yield* query(
                (sql) => sql<{ kind: string; command: string; payload_version: number }>`
                  SELECT kind, command, payload_version FROM payload_route_rows`,
              ),
            ).toEqual([{ kind: "intent", command: "Lost", payload_version: 0 }])
          }),
        ),
      ),
  },
  {
    name: "payload migrations: fails a read as a defect, never a skip, when an upcast throws or the stored version is newer than the chain",
    run: ({ expect, environment }) =>
      withCase(environment, (database) =>
        Effect.gen(function* () {
          yield* deploy(
            database,
            Base.layer,
            Effect.gen(function* () {
              yield* Base.place("bad", -1, HOUR)
              yield* Base.place("newer", 1, HOUR)
            }),
          )

          yield* deploy(
            database,
            Layer.empty,
            query(
              (sql) => sql`UPDATE actor_events SET payload_version = 5
                WHERE actor_type = 'Ledger' AND actor_id = 'newer'`,
            ),
          )

          yield* deploy(
            database,
            Next.layer,
            Effect.gen(function* () {
              const thrown = yield* Next.history("bad").pipe(Effect.exit)
              expect(Exit.isFailure(thrown)).toBe(true)
              expect(Cause.pretty((thrown as Exit.Failure<unknown, unknown>).cause)).toContain(
                "cannot convert -1",
              )

              const newer = yield* Next.history("newer").pipe(Effect.exit)
              expect(Exit.isFailure(newer)).toBe(true)
              expect(Cause.pretty((newer as Exit.Failure<unknown, unknown>).cause)).toContain(
                "payload version 5, newer than this code's chain (1)",
              )
            }),
          )
        }),
      ),
  },
  {
    name: "payload migrations: keeps an earlier attempt's ambiguity on the row and in the dead letter when a later attempt fails to decode its payload",
    run: ({ expect, environment }) =>
      withCase(environment, (database) =>
        deploy(
          database,
          Next.layer,
          Effect.gen(function* () {
            seen.executor = "die"
            yield* Next.place("o1", 400)
            yield* eventually(Effect.sync(() => seen.executed.length > 0))

            yield* query(
              (sql) => sql`UPDATE actor_outbox SET payload_version = 9
                WHERE actor_type = 'Ledger' AND kind = 'effect'`,
            )
            yield* eventually(
              query(
                (sql) => sql<{ n: number }>`SELECT count(*)::int AS n FROM actor_dead_letters
                  WHERE actor_type = 'Ledger'`,
              ).pipe(Effect.map((rows) => rows[0]!.n > 0)),
            )
            expect(seen.executed.length).toBe(1)

            const letters = yield* query(
              (sql) => sql<{ ambiguous: boolean; payload_version: number; cause: string }>`
                SELECT ambiguous, payload_version, cause FROM actor_dead_letters
                WHERE actor_type = 'Ledger'`,
            )

            expect(
              letters.map(({ ambiguous, payload_version }) => ({ ambiguous, payload_version })),
            ).toEqual([{ ambiguous: true, payload_version: 9 }])
            expect(letters[0]!.cause).toContain("payload version 9, newer than this code's chain")
          }),
        ),
      ),
  },
  {
    name: "payload migrations: refuses startup after a rollback past a recorded version, and when a shortened chain drops a version still retained",
    run: ({ expect, environment }) =>
      withCase(environment, (database) =>
        Effect.gen(function* () {
          yield* deploy(database, Base.layer, Base.place("o1", 100, HOUR))
          expect(yield* refusal(database, Shortened.layer)).toContain("deploy refused")

          const shortened = yield* deploy(
            database,
            Layer.empty,
            checkPayloads([Shortened.Ledger]).pipe(Effect.orDie),
          )

          expect(shortened.map(formatPayloadProblem)).toEqual([
            "Ledger/Placed (event)  version 0 may still be stored below this chain's first version 1; run durable payloads clear once its events are gone",
            "Ledger/Charge (effect)  version 0 stored in 1 pending effect or dead letter row below this chain's first version 1",
          ])

          yield* deploy(database, Next.layer, Effect.void)
          const rollback = yield* refusal(database, Base.layer)
          expect(rollback).toContain("deploy refused")
          expect(rollback).toContain(
            "version 1 recorded above this chain's current version 0: a rollback past a payload schema change",
          )

          const checked = yield* deploy(
            database,
            Layer.empty,
            checkPayloads([Base.Ledger, Next.Ledger]).pipe(Effect.orDie),
          )

          expect(checked.map(({ actorType, tag }) => `${actorType}/${tag}`)).toEqual([
            "Ledger/Placed",
            "Ledger/Charge",
          ])
        }),
      ),
  },
  {
    name: "payload migrations: refuses a shortened chain after the retention horizon until durable payloads clear finds no row of the dropped version, and refuses again after restoring a snapshot taken before the clear",
    run: ({ expect, environment }) =>
      withCase(environment, (database) =>
        Effect.gen(function* () {
          yield* deploy(
            database,
            Base.layer,
            Effect.gen(function* () {
              yield* Base.place("o1", 100)
              yield* eventually(Effect.sync(() => seen.executed.length > 0))
            }),
          )

          yield* deploy(
            database,
            Next.layer,
            Effect.gen(function* () {
              expect(yield* recordedVersions).toEqual([
                { kind: "effect", version: 0, superseded: true, cleared: false },
                { kind: "effect", version: 1, superseded: false, cleared: false },
                { kind: "event", version: 0, superseded: true, cleared: false },
                { kind: "event", version: 1, superseded: false, cleared: false },
              ])
              expect(yield* clearPayloads([Next.Ledger])).toEqual([])
            }),
          )

          yield* deploy(
            database,
            Layer.empty,
            Effect.gen(function* () {
              yield* pastHorizon
              expect(yield* clearPayloads([Next.Ledger])).toEqual([
                { actorType: "Ledger", tag: "Placed", version: 0, outcome: "stored" },
              ])

              yield* query(
                (sql) => sql`CREATE TABLE payload_snapshot AS SELECT * FROM actor_payload_versions`,
              )
              yield* query(
                (sql) =>
                  sql`DELETE FROM actor_events WHERE actor_type = 'Ledger' AND payload_version = 0`,
              )
              expect(yield* clearPayloads([Next.Ledger])).toEqual([
                { actorType: "Ledger", tag: "Placed", version: 0, outcome: "cleared" },
              ])
            }),
          )

          yield* deploy(database, Shortened.layer, Effect.void)

          yield* deploy(
            database,
            Layer.empty,
            query((sql) =>
              sql`DELETE FROM actor_payload_versions`.pipe(
                Effect.andThen(
                  sql`INSERT INTO actor_payload_versions SELECT * FROM payload_snapshot`,
                ),
              ),
            ),
          )
          expect(yield* refusal(database, Shortened.layer)).toContain(
            "Ledger/Placed (event)  version 0 may still be stored",
          )
        }),
      ),
  },
  {
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    name: "payload migrations: refuses durable payloads clear while a runtime writing that version refreshed within the window, and a runtime past its window refuses new turns until it refreshes",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset
          const database = yield* environment.freshDatabase

          const afterRunner0 = Layer.effectDiscard(
            eventually(
              query(
                (sql) => sql`SELECT 1 FROM actor_payload_writers
                  WHERE actor_type = 'Ledger' AND tag = 'Placed' AND version = 0`,
              ).pipe(Effect.map((rows) => rows.length > 0)),
              { drive: false },
            ),
          )

          const context = yield* Layer.build(
            ActorTest.cluster({
              database,
              runners: 2,
              shardLockExpiration: "3 seconds",
              actors: Layer.empty,
              runnerActors: (runner) =>
                runner === 0 ? Base.layer : Next.layer.pipe(Layer.provide(afterRunner0)),
              as: User.make({ subject: "alice" }),
              payloadWriterWindow: "2 seconds",
            }),
          )

          yield* Effect.gen(function* () {
            const cluster = yield* ActorCluster
            yield* cluster.ready
            const on1 = cluster.on(1)

            expect(yield* on1(recordedVersions)).toEqual([
              { kind: "effect", version: 0, superseded: true, cleared: false },
              { kind: "effect", version: 1, superseded: false, cleared: false },
              { kind: "event", version: 0, superseded: true, cleared: false },
              { kind: "event", version: 1, superseded: false, cleared: false },
            ])
            yield* on1(pastHorizon)

            expect(yield* on1(clearPayloads([Next.Ledger]))).toEqual([
              { actorType: "Ledger", tag: "Placed", version: 0, outcome: "writer" },
            ])

            yield* on1(
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient
                const locked = yield* Deferred.make<void>()
                const release = yield* Deferred.make<void>()

                const holder = yield* sql
                  .withTransaction(
                    Effect.gen(function* () {
                      yield* sql`SELECT 1 FROM actor_payload_writers FOR UPDATE`
                      yield* Deferred.succeed(locked, undefined)
                      yield* Deferred.await(release)
                    }),
                  )
                  .pipe(Effect.orDie, Effect.forkScoped)

                yield* Deferred.await(locked)
                yield* Effect.sleep("2500 millis")

                const refused = yield* Next.place("o2", 100).pipe(Effect.flip)
                expect(refused.reason._tag).toBe("Timeout")
                expect(
                  yield* query(
                    (sql) => sql<{ n: number }>`SELECT count(*)::int AS n FROM actor_events
                      WHERE actor_type = 'Ledger' AND actor_id = 'o2'`,
                  ),
                ).toEqual([{ n: 0 }])

                yield* Deferred.succeed(release, undefined)
                yield* Fiber.join(holder)
                yield* Next.place("o2", 100).pipe(
                  Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 50 }),
                )
              }).pipe(Effect.scoped),
            )
          }).pipe(Effect.provideContext(context))
        }),
      ),
  },
  {
    name: "payload migrations: records the writeVersion, not the chain's last version, while a two-phase deploy is in its first phase",
    run: ({ expect, environment }) =>
      withCase(environment, (database) =>
        deploy(
          database,
          FirstPhase.layer,
          Effect.gen(function* () {
            yield* FirstPhase.place("o1", 100, HOUR)
            expect(yield* recordedVersions).toEqual([
              { kind: "effect", version: 0, superseded: false, cleared: false },
              { kind: "event", version: 0, superseded: false, cleared: false },
            ])

            expect(
              yield* query(
                (sql) => sql<{ tag: string; version: number }>`SELECT tag, version
                  FROM actor_payload_writers WHERE actor_type = 'Ledger' ORDER BY tag`,
              ),
            ).toEqual([
              { tag: "Charge", version: 0 },
              { tag: "Noted", version: 0 },
              { tag: "Placed", version: 0 },
            ])
          }),
        ),
      ),
  },
  {
    name: "payload migrations: writes the old version under writeVersion and reads both versions on one runtime",
    run: ({ expect, environment }) =>
      withCase(environment, (database) =>
        Effect.gen(function* () {
          yield* deploy(database, Next.layer, Next.place("o1", 100, HOUR))

          yield* deploy(
            database,
            FirstPhase.layer,
            Effect.gen(function* () {
              yield* FirstPhase.place("o1", 200)
              expect(yield* eventVersions).toEqual([1, 0])
              expect(yield* FirstPhase.history("o1")).toEqual([
                yield* Next.placed("o1", 100),
                yield* Next.placed("o1", 200),
              ])
              yield* eventually(Effect.sync(() => seen.executed.length > 0))
              expect(seen.executed).toEqual([yield* Next.charge("o1", 200)])
            }),
          )

          const oldReader = yield* refusal(database, Base.layer)
          expect(oldReader).toContain("version 1 recorded above this chain's current version 0")
        }),
      ),
  },
  {
    timeoutMs: 60_000,
    name: "payload migrations: refuses removing an event class while a subscription has undelivered events of that tag or an open workflow waits on it",
    run: ({ expect, environment }) =>
      withCase(environment, (database) =>
        Effect.gen(function* () {
          seen.accepting = false
          yield* deploy(
            database,
            Audited.layer,
            Effect.gen(function* () {
              yield* Audited.place("o1", 100, HOUR)
              yield* eventually(
                query(
                  (sql) => sql<{ attempts: number }>`SELECT attempts FROM actor_subscriptions
                    WHERE source_type = 'Ledger'`,
                ).pipe(Effect.map((rows) => rows.some(({ attempts }) => attempts > 0))),
              )
            }),
          )

          expect(yield* refusal(database, Unplaced.layer)).toContain(
            "Ledger/Placed (event)  event class removed while subscription Audit.Placements has undelivered events of it",
          )

          seen.accepting = true
          yield* deploy(
            database,
            Audited.layer,
            Effect.gen(function* () {
              yield* query((sql) => sql`UPDATE actor_subscriptions SET due_at_ms = 0`)
              yield* eventually(Effect.sync(() => seen.delivered.length > 0))
            }),
          )

          expect(
            yield* deploy(
              database,
              Layer.empty,
              checkPayloads([Unplaced.Ledger]).pipe(Effect.orDie),
            ),
          ).toEqual([])

          const waiting = yield* caseDatabase(environment)

          const executionId = yield* deploy(
            waiting,
            Base.layer,
            Effect.gen(function* () {
              const id = yield* Base.watch("w")
              yield* eventually(status(id).pipe(Effect.map((held) => held === "suspended")))

              return id
            }),
          )

          const refused = yield* refusal(waiting, Unplaced.layer)
          expect(refused).toContain("deploy refused")
          expect(refused).toContain("Ledger/Watch  workflow removed  1 open execution")

          yield* deploy(
            waiting,
            Base.layer,
            Effect.gen(function* () {
              yield* Base.place("w", 100)
              yield* eventually(status(executionId).pipe(Effect.map((held) => held === "finished")))
            }),
          )
          yield* deploy(waiting, Unplaced.layer, Effect.void)
        }),
      ),
  },
  {
    timeoutMs: 60_000,
    name: "payload migrations: replays a subscription receipt after a schema change without CommandConflict",
    run: ({ expect, environment }) =>
      withCase(environment, (database) =>
        Effect.gen(function* () {
          yield* deploy(
            database,
            Audited.layer,
            Effect.gen(function* () {
              yield* Audited.place("o1", 100, HOUR)
              yield* eventually(Effect.sync(() => seen.delivered.length > 0))
            }),
          )

          yield* deploy(
            database,
            NextAudited.layer,
            Effect.gen(function* () {
              yield* query(
                (sql) => sql`UPDATE actor_subscriptions SET delivered = 0, due_at_ms = 0
                  WHERE source_type = 'Ledger'`,
              )
              yield* eventually(
                query(
                  (sql) => sql<{ delivered: string; last_error: string | null }>`
                    SELECT delivered::text AS delivered, last_error FROM actor_subscriptions
                    WHERE source_type = 'Ledger' AND source_id = 'o1'`,
                ).pipe(Effect.map((rows) => rows[0]?.delivered === "1")),
              )

              expect(
                yield* query(
                  (sql) => sql<{ last_error: string | null }>`SELECT last_error
                    FROM actor_subscriptions WHERE source_type = 'Ledger' AND source_id = 'o1'`,
                ),
              ).toEqual([{ last_error: null }])
              expect(seen.delivered.length).toBe(1)
            }),
          )
        }),
      ),
  },
  {
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    name: "payload migrations: two runners, one with the new chain under writeVersion, both write and read version 0",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset
          const database = yield* environment.freshDatabase

          const context = yield* Layer.build(
            ActorTest.cluster({
              database,
              runners: 2,
              shardLockExpiration: "3 seconds",
              actors: Layer.empty,
              runnerActors: (runner) => (runner === 0 ? FirstPhase.layer : Base.layer),
              as: User.make({ subject: "alice" }),
            }),
          )

          yield* Effect.gen(function* () {
            const cluster = yield* ActorCluster
            yield* cluster.ready

            for (const runner of [0, 1])
              for (const id of ["a", "b", "c", "d"])
                yield* cluster.on(runner)(
                  (runner === 0 ? FirstPhase : Base).place(`${id}${runner}`, 100),
                )

            expect(new Set(yield* cluster.on(0)(eventVersions))).toEqual(new Set([0]))

            for (const id of ["a0", "b1"]) {
              expect(yield* cluster.on(0)(FirstPhase.history(id))).toEqual([
                yield* Next.placed(id, 100),
              ])
              expect(yield* cluster.on(1)(Base.history(id))).toEqual([yield* Base.placed(id, 100)])
            }
          }).pipe(Effect.provideContext(context))
        }),
      ),
  },
]
