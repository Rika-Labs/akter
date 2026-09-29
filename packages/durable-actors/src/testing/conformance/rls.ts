import { PGlite } from "@electric-sql/pglite"
import {
  Cause,
  Context,
  Crypto,
  Data,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor, Actors, Intent, User } from "../../index.ts"
import { InternalActors, Outcome, Request } from "../../handles/actors.ts"
import { migrate } from "../../runtime/database/migrations.ts"
import { Database } from "../../runtime/layer.ts"
import { ActorTest } from "../actor-test.ts"
import { ActorCluster } from "../cluster.ts"
import type {
  ConformanceCase,
  ConformanceDatabase,
  ConformanceEnvironment,
} from "../conformance.ts"
import { pauseReplay, replayedThrough } from "./read-your-writes.ts"
import { Notebook, tablesDdl, tablesFixture, tablesLayer } from "./tables.ts"

class Recorded extends Actor.Event<Recorded>()("Recorded", { body: Schema.String }) {}

class Ship extends Actor.effect<Ship>()("Ship", {
  input: { body: Schema.String },
  success: Schema.String,
}) {}

const Record = Actor.command("Record", { input: Schema.String })

const Tick = Actor.command("Tick")

const Shipped = Actor.command("Shipped", { input: Schema.String })

// Read outside any turn by a stream handler: the attachment and the events so far.
const Snapshot = Actor.stream("Snapshot", { output: Schema.String })

// Polled through `pollWorkflow` until it finishes.
const Settle = Actor.workflow("Settle", { output: Schema.String })

const attachments = Actor.blob("attachments")

const Read = Actor.query("Read", {
  output: Schema.Struct({
    entries: Schema.Array(Schema.String),
    ticks: Schema.Int,
    shipped: Schema.Array(Schema.String),
    events: Schema.Array(Schema.String),
  }),
})

const Ledger = Actor.make("Ledger", {
  key: Schema.String,
  state: Actor.state({
    entries: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    ticks: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    shipped: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
  events: [Recorded],
  effects: [Ship],
  blobs: [attachments],
  api: { Record, Read, Snapshot, Settle },
  internal: { Tick, Shipped },
  policy: { effects: { Ship: { onSuccess: Shipped } } },
})

// One turn writes state, an event, a keyed timer, and an effect, so the
// relay, the executor, and the route turn all cross the tenant boundary.
const ledgerLayer = Layer.mergeAll(
  Ledger.toLayer(
    Effect.succeed({
      Record: Effect.fnUntraced(function* (body: string) {
        const turn = yield* Ledger.Turn
        yield* turn.state.set({ entries: [...turn.state.entries, body] })
        yield* turn.emit(Recorded.make({ body }))
        yield* turn.blob(attachments).set("latest", new TextEncoder().encode(body))
        const self = yield* Ledger.intents(turn.id)
        yield* self.Tick().pipe(Intent.after("1 second"), Intent.key("tick"))
        yield* turn.perform(Ship.make({ body }))
      }),
      Tick: Effect.fnUntraced(function* () {
        const turn = yield* Ledger.Turn
        yield* turn.state.set({ ticks: turn.state.ticks + 1 })
      }),
      Shipped: Effect.fnUntraced(function* (body: string) {
        const turn = yield* Ledger.Turn
        yield* turn.state.set({ shipped: [...turn.state.shipped, body] })
      }),
      Snapshot: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            const read = yield* Ledger.Read
            const latest = yield* read.blob(attachments).get("latest")
            const events = yield* read.events(Recorded).pipe(Effect.orDie)

            return Stream.make(
              `${Option.match(latest, { onNone: () => "", onSome: (bytes) => new TextDecoder().decode(bytes) })}/${events.length}`,
            )
          }),
        ),
      Settle: () => Effect.succeed("settled"),
    }),
  ),
  Ledger.toEffectLayer(Effect.succeed({ Ship: ({ body }) => Effect.succeed(body) })),
  Ledger.toQueryLayer(
    Effect.succeed({
      Read: Effect.fnUntraced(function* () {
        const read = yield* Ledger.Read
        const events = yield* read.events(Recorded).pipe(Effect.orDie)

        return {
          entries: read.state.entries,
          ticks: read.state.ticks,
          shipped: read.state.shipped,
          events: events.map(({ event }) => event.body),
        }
      }),
    }),
  ),
)

const Replicated = Actor.make("Replicated", {
  key: Schema.String,
  state: Actor.state({
    entries: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
  api: {
    Put: Actor.command("Put", { input: Schema.String }),
    Read: Actor.query("Read", { output: Schema.Array(Schema.String) }),
  },
})

const replicatedLayer = Layer.mergeAll(
  Replicated.toLayer(
    Effect.succeed({
      Put: Effect.fnUntraced(function* (body: string) {
        const turn = yield* Replicated.Turn
        yield* turn.state.set({ entries: [...turn.state.entries, body] })
      }),
    }),
  ),
  Replicated.toQueryLayer(
    Effect.succeed({
      Read: Effect.fnUntraced(function* () {
        const read = yield* Replicated.Read

        return read.state.entries
      }),
    }),
  ),
)

const live = Layer.mergeAll(ledgerLayer, replicatedLayer, tablesLayer(tablesFixture()))

const VIEWS = [
  "actors",
  "state",
  "receipts",
  "events",
  "outbox",
  "timers",
  "effects",
  "dead_letters",
  "workflows",
  "workflow_steps",
] as const

/** Hands every inspection view to `owner`, as the guide's script does. */
const viewsTo = (owner: string) => `DO $$
    DECLARE view record;
    BEGIN
      FOR view IN SELECT relname FROM pg_class
        WHERE relnamespace = 'durable'::regnamespace AND relkind = 'v'
      LOOP
        EXECUTE format('ALTER VIEW durable.%I OWNER TO %I', view.relname, '${owner}');
      END LOOP;
    END $$`

/**
 * The operator script of the row-level security guide: a tenant role the
 * runtime takes for tenant-scoped transactions, and a separate view-owner role
 * the policies bind, which the tenant role can't act as.
 */
const grants = ({ role, viewOwner }: { readonly role: string; readonly viewOwner: string }) => [
  `CREATE ROLE ${role} NOLOGIN`,
  `GRANT USAGE ON SCHEMA public TO ${role}`,
  `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
  `GRANT ${role} TO CURRENT_USER`,
  `CREATE ROLE ${viewOwner} NOLOGIN`,
  `GRANT USAGE ON SCHEMA public TO ${viewOwner}`,
  `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${viewOwner}`,
  `GRANT ${viewOwner} TO CURRENT_USER`,
  `GRANT CREATE ON SCHEMA durable TO ${viewOwner}`,
  viewsTo(viewOwner),
  `REVOKE CREATE ON SCHEMA durable FROM ${viewOwner}`,
]

type Target = Redacted.Redacted<string> | { readonly liveClient: PGlite }

const databaseLayer = (target: Target) =>
  Redacted.isRedacted(target)
    ? Database.postgres({ url: target, maxConnections: 2, offTurnConnections: 2 })
    : Database.pglite(target)

/** Runs `effect` on its own connection to `target`, outside any runtime. */
const onDatabase = <A, E>(target: Target, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Layer.build(databaseLayer(target)).pipe(
    Effect.flatMap((context) => Effect.provideContext(effect, context)),
    Effect.scoped,
    Effect.orDie,
  )

/**
 * A fresh database migrated, with the owned tables' drizzle-kit DDL applied
 * and, unless `grant` is false, the operator script run for a new role. On
 * PGlite the fresh database is an in-memory instance, which this keeps open
 * across the setup and the runtime; on Postgres the role is dropped at the end.
 */
const prepared = (
  environment: ConformanceEnvironment,
  options: { readonly grant: boolean } = { grant: true },
) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const uuid = (yield* crypto.randomUUIDv4.pipe(Effect.orDie)).replaceAll("-", "")
    const role = `durable_tenant_${uuid}`
    const viewOwner = `durable_views_${uuid}`
    const fresh: ConformanceDatabase = yield* environment.freshDatabase

    const target: Target = Redacted.isRedacted(fresh)
      ? fresh
      : {
          liveClient: yield* Effect.acquireRelease(
            Effect.sync(() => new PGlite()).pipe(
              Effect.tap((client) => Effect.promise(() => client.waitReady)),
            ),
            // PGlite runs one query at a time, so this one waits out any a
            // failed runtime interrupted; closing during one deadlocks.
            (client) =>
              Effect.promise(() => client.query("SELECT 1")).pipe(
                Effect.andThen(Effect.promise(() => client.close())),
              ),
          ),
        }

    yield* onDatabase(
      target,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* migrate

        for (const statement of [
          ...tablesDdl,
          ...(options.grant ? grants({ role, viewOwner }) : []),
        ])
          yield* sql.unsafe(statement)
      }),
    )

    // Registered before any runtime, so it runs after every runtime closed its connections.
    if (options.grant && Redacted.isRedacted(target))
      yield* Effect.addFinalizer(() =>
        onDatabase(
          target,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient

            for (const owner of [role, viewOwner]) {
              yield* sql.unsafe(`REASSIGN OWNED BY ${owner} TO CURRENT_USER`)
              yield* sql.unsafe(`DROP OWNED BY ${owner}`)
              yield* sql.unsafe(`DROP ROLE ${owner}`)
            }
          }),
        ),
      )

    return { target, role, viewOwner }
  })

/** A fresh database for `environment`, migrated with the owned tables and a new tenant role, as row-level security cases need. */
export const preparedForRowLevelSecurity = (environment: ConformanceEnvironment) =>
  prepared(environment)

const runtimeOn = (target: Target, role: string, replica?: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto

    // Fresh, or Cluster's Sharding layer is shared with the suite's runtime through the memo map.
    return yield* Layer.build(
      Layer.fresh(
        live.pipe(
          Layer.provideMerge(
            ActorTest.layer({
              database: Redacted.isRedacted(target) ? target : { liveClient: target.liveClient },
              as: User.make({ subject: "alice" }),
              rowLevelSecurity: { role },
              replica,
            }),
          ),
          Layer.provide(Layer.succeed(Crypto.Crypto, crypto)),
        ),
      ),
    )
  })

/** Runs `body` on a runtime with row-level security on, over a fresh prepared database. */
const withRowLevelSecurity = <A, E>(
  environment: ConformanceEnvironment,
  body: (setup: {
    readonly role: string
    readonly target: Target
  }) => Effect.Effect<
    A,
    E,
    Actors | InternalActors | ActorTest | SqlClient.SqlClient | Crypto.Crypto | Scope.Scope
  >,
) =>
  environment.run(
    Effect.gen(function* () {
      const { target, role } = yield* prepared(environment)
      const context = yield* runtimeOn(target, role).pipe(Effect.orDie)

      return yield* body({ role, target }).pipe(Effect.provideContext(context))
    }),
  )

class Probed extends Data.TaggedError("Probed")<{ readonly result: unknown }> {}

/** Runs `effect` in a transaction that always rolls back, returning its value. */
const rolledBack = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const exit = yield* sql
      .withTransaction(Effect.flatMap(effect, (result) => new Probed({ result })))
      .pipe(Effect.flip)

    return exit instanceof Probed ? (exit.result as A) : yield* Effect.fail(exit)
  })

const rejection = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isSuccess(exit) ? "succeeded" : Cause.pretty(exit.cause)

/** An attempt in a savepoint, so its failure leaves the probe's transaction usable. */
const attempt = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return rejection(yield* effect.pipe(sql.withTransaction, Effect.exit))
  })

/** Every table the `durable_tenant` policy protects: framework tables and owned tables. */
const protectedTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const rows = yield* sql<{ table: string }>`
    SELECT c.relname AS table FROM pg_class c JOIN pg_policy p ON p.polrelid = c.oid
    WHERE p.polname = 'durable_tenant' AND c.relrowsecurity
    ORDER BY c.relname`

  return rows.map(({ table }) => table)
})

/** Writes one of everything for `tenant`, then lets the timer, effect, and route run. */
const populate = (tenant: string) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger.get("shared-id").pipe(Actor.tenant(tenant))
    yield* ledger.Record(tenant)
    const notebook = yield* Notebook.get("shared-id").pipe(Actor.tenant(tenant))
    yield* notebook.Write({ id: "note", body: tenant })
  })

const decodeEntries = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ value: Schema.Array(Schema.String) })),
)

export const rlsConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "row-level security on: three runners serve two tenants' turns, timers, effects, and reads, each seeing only its own",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { target, role } = yield* prepared(environment)

          if (!Redacted.isRedacted(target))
            return yield* Effect.die(new Error("The three-runner case needs Postgres"))

          const crypto = yield* Crypto.Crypto

          const context = yield* Layer.build(
            ActorTest.cluster({
              database: target,
              runners: 3,
              shardLockExpiration: "3 seconds",
              actors: live,
              as: User.make({ subject: "alice" }),
              rowLevelSecurity: { role },
            }).pipe(Layer.provide(Layer.succeed(Crypto.Crypto, crypto))),
          )

          const cluster = Context.get(context, ActorCluster)
          const tenant = yield* cluster.on(0)(ActorTest.use((test) => Effect.succeed(test.tenant)))
          const tenants = [tenant, `${tenant}-b`]
          const ids = Array.from({ length: 6 }, (_, index) => `ledger-${index}`)
          const owners = new Set<number | undefined>()

          // Each write goes through a different runner than the next, so most dispatch remotely.
          for (const [index, id] of ids.entries())
            for (const scoped of tenants)
              yield* cluster.on(index % 3)(
                Effect.gen(function* () {
                  const ledger = yield* Ledger.get(id).pipe(Actor.tenant(scoped))
                  yield* ledger.Record(`${scoped}/${id}`)
                  const notebook = yield* Notebook.get(id).pipe(Actor.tenant(scoped))
                  yield* notebook.Write({ id: "note", body: scoped })
                  owners.add(yield* cluster.owner(ledger.ref))
                }),
              )

          // Any runner's relay and executors deliver the timers and effect routes.
          for (const [index, id] of ids.entries())
            for (const scoped of tenants) {
              const reader = (index + 1) % 3

              const read = cluster.on(reader)(
                Ledger.get(id).pipe(
                  Actor.tenant(scoped),
                  Effect.flatMap((ledger) => ledger.Read()),
                ),
              )

              const settled = yield* read.pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("200 millis"),
                  until: (state) => state.ticks === 1 && state.shipped.length === 1,
                }),
                Effect.timeout("30 seconds"),
              )

              expect(settled).toEqual({
                entries: [`${scoped}/${id}`],
                ticks: 1,
                shipped: [`${scoped}/${id}`],
                events: [`${scoped}/${id}`],
              })

              const notes = yield* cluster.on(reader)(
                Notebook.get(id).pipe(
                  Actor.tenant(scoped),
                  Effect.flatMap((notebook) => notebook.List()),
                ),
              )

              expect(notes.map(({ body }) => body)).toEqual([scoped])
            }

          expect(owners.size > 1).toBe(true)
        }),
      ),
  },
  {
    name: "row-level security on: every framework table and owned table carries the tenant policy",
    run: ({ expect, environment }) =>
      withRowLevelSecurity(environment, () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient

          // Every table with a tenant column, so a later migration that
          // forgets its policy fails here as well as at startup.
          const tenantTables = yield* sql<{ table: string }>`
            SELECT c.relname AS table FROM pg_class c
            WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r'
              AND EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
            ORDER BY c.relname`

          expect(yield* protectedTables).toEqual(tenantTables.map(({ table }) => table))
          expect(yield* protectedTables).toContain("conformance_notes")
          expect(yield* protectedTables).toContain("actor_generations")
        }),
      ),
  },
  {
    name: "row-level security on: turns, timers, effects, queries, and owned rows serve two tenants, each seeing only its own",
    timeoutMs: 30_000,
    run: ({ expect, environment }) =>
      withRowLevelSecurity(environment, () =>
        Effect.gen(function* () {
          const test = yield* ActorTest
          const tenants = [test.tenant, `${test.tenant}-b`]

          for (const tenant of tenants) yield* populate(tenant)

          // The relay, the executor, and retention span tenants as the connecting role.
          yield* test.advance("2 seconds")

          for (const tenant of tenants) {
            const ledger = yield* Ledger.get("shared-id").pipe(Actor.tenant(tenant))
            expect(yield* ledger.Read()).toEqual({
              entries: [tenant],
              ticks: 1,
              shipped: [tenant],
              events: [tenant],
            })

            const notebook = yield* Notebook.get("shared-id").pipe(Actor.tenant(tenant))
            expect((yield* notebook.List()).map(({ body }) => body)).toEqual([tenant])
          }

          yield* test.cleanup
        }),
      ),
  },
  {
    name: "row-level security on: a transaction naming one tenant reads, changes, and inserts no other tenant's rows in any protected table",
    timeoutMs: 30_000,
    run: ({ expect, environment }) =>
      withRowLevelSecurity(environment, ({ role }) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          const [home, abroad] = [test.tenant, `${test.tenant}-b`]

          for (const tenant of [home, abroad]) yield* populate(tenant)

          const tables = yield* protectedTables

          const stored = yield* sql<{ rows: number }>`
            SELECT count(*)::int AS rows FROM actor_generations WHERE tenant_id = ${abroad}`

          // The connecting role is exempt, so the other tenant's rows exist.
          expect(stored).toEqual([{ rows: 2 }])

          const probe = yield* rolledBack(
            Effect.gen(function* () {
              yield* sql`SELECT set_config('role', ${role}, true),
                set_config('durable.tenant', ${home}, true)`

              const seen: Record<string, number> = {}
              const changed: Record<string, number> = {}

              for (const table of tables) {
                const [row] = yield* sql<{ other: number }>`
                  SELECT count(*)::int AS other FROM ${sql(table)} WHERE tenant_id <> ${home}`

                seen[table] = row!.other

                const updated = yield* sql`
                  UPDATE ${sql(table)} SET tenant_id = tenant_id WHERE tenant_id = ${abroad}
                  RETURNING 1`

                changed[table] = updated.length
              }

              const [own] = yield* sql<{ rows: number }>`
                SELECT count(*)::int AS rows FROM actor_generations`

              const inserted = yield* attempt(
                sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id)
                  VALUES (0, ${abroad}, 'Ledger', 'forged')`,
              )

              const moved = yield* attempt(
                sql`UPDATE actor_generations SET tenant_id = ${abroad} WHERE tenant_id = ${home}`,
              )

              return { seen, changed, own: own!.rows, inserted, moved }
            }),
          )

          for (const table of tables) {
            expect({ table, other: probe.seen[table] }).toEqual({ table, other: 0 })
            expect({ table, changed: probe.changed[table] }).toEqual({ table, changed: 0 })
          }

          expect(probe.own).toBe(2)
          expect(probe.inserted).toContain("row-level security")
          expect(probe.moved).toContain("row-level security")

          // Unnamed, a transaction as the role sees no tenant at all.
          const unnamed = yield* rolledBack(
            Effect.gen(function* () {
              yield* sql`SELECT set_config('role', ${role}, true)`

              return yield* sql<{ rows: number }>`SELECT count(*)::int AS rows FROM actor_state`
            }),
          )

          expect(unnamed).toEqual([{ rows: 0 }])
        }),
      ),
  },
  {
    name: "row-level security on: turns, queries, and every caller-facing read outside a turn run as the tenant role",
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withRowLevelSecurity(environment, ({ role }) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          const internal = yield* InternalActors
          const ledger = yield* Ledger.get("revoked")
          yield* ledger.Record("first")
          const run = yield* ledger.Settle({})
          expect(yield* run.result).toBe("settled")

          const snapshot = ledger.Snapshot().pipe(
            Stream.runCollect,
            Effect.map((chunk) => [...chunk]),
          )

          const reads = {
            turn: ledger.Record("refused"),
            query: ledger.Read(),
            exists: internal.exists(ledger.ref),
            feed: internal.readFeed(ledger.ref, ["Recorded"], undefined, 10),
            poll: run.poll,
            stream: snapshot,
          }

          // Every read succeeds while the role holds its grants.
          expect(yield* internal.exists(ledger.ref)).toBe(true)
          expect((yield* internal.readFeed(ledger.ref, ["Recorded"], undefined, 10)).length).toBe(1)
          expect(Option.isSome(yield* run.poll)).toBe(true)
          expect(yield* snapshot).toEqual(["first/1"])

          // Only the role loses access, so a failure proves the role ran the statement.
          const revoked = [
            ["turn", "INSERT", "actor_receipts"],
            ["query", "SELECT", "actor_state"],
            ["exists", "SELECT", "actor_generations"],
            ["feed", "SELECT", "actor_events"],
            ["poll", "SELECT", "actor_workflow_executions"],
            ["stream", "SELECT", "actor_blobs"],
          ] as const

          const outcomes: Record<string, string> = {}

          for (const [read, privilege, table] of revoked) {
            yield* sql.unsafe(`REVOKE ${privilege} ON ${table} FROM ${role}`)
            outcomes[read] = rejection(
              yield* reads[read].pipe(Effect.timeout("20 seconds"), Effect.exit),
            )
            yield* sql.unsafe(`GRANT ${privilege} ON ${table} TO ${role}`)
          }

          expect(
            Object.fromEntries(revoked.map(([read]) => [read, outcomes[read] !== "succeeded"])),
          ).toEqual({ turn: true, query: true, exists: true, feed: true, poll: true, stream: true })

          yield* ledger.Record("second")
          expect((yield* ledger.Read()).entries).toEqual(["first", "second"])
          expect(yield* test.receiptsFor(ledger.ref, "Record")).toBe(2)
          expect(yield* snapshot).toEqual(["second/2"])
        }),
      ),
  },
  {
    name: "row-level security on: a role granted only the durable schema reads its transaction's tenant through the views and no runtime table",
    timeoutMs: 30_000,
    run: ({ expect, environment }) =>
      withRowLevelSecurity(environment, () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          const [home, abroad] = [test.tenant, `${test.tenant}-b`]

          for (const tenant of [home, abroad]) yield* populate(tenant)

          const uuid = yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie)
          const inspector = `inspector_${uuid.replaceAll("-", "")}`

          const tenantsIn = (tenant: string) =>
            Effect.gen(function* () {
              yield* sql`SELECT set_config('durable.tenant', ${tenant}, true)`
              const seen: Record<string, ReadonlyArray<string>> = {}

              for (const view of VIEWS) {
                const rows = yield* sql<{ tenant: string }>`
                  SELECT DISTINCT tenant_id AS tenant FROM ${sql(`durable.${view}`)}`

                seen[view] = rows.map(({ tenant }) => tenant)
              }

              const [counted] = yield* sql<{ actors: number; events: number }>`
                SELECT (SELECT count(*)::int FROM durable.actors) AS actors,
                  (SELECT count(*)::int FROM durable.events) AS events`

              return { seen, counted: counted! }
            })

          // The role is cluster-wide, so the probe rolls back and never outlives it.
          const probe = yield* rolledBack(
            Effect.gen(function* () {
              yield* sql.unsafe(`CREATE ROLE ${inspector} NOLOGIN`)
              yield* sql.unsafe(`GRANT USAGE ON SCHEMA durable TO ${inspector}`)
              yield* sql.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA durable TO ${inspector}`)
              yield* sql.unsafe(`SET LOCAL ROLE ${inspector}`)

              const atHome = yield* tenantsIn(home)
              const atAbroad = yield* tenantsIn(abroad)
              const nowhere = yield* tenantsIn("")
              const denied: Record<string, string> = {}

              for (const table of yield* protectedTables)
                denied[table] = yield* attempt(sql`SELECT 1 FROM ${sql(table)} LIMIT 1`)

              return { atHome, atAbroad, nowhere, denied }
            }),
          )

          for (const view of VIEWS) {
            expect(probe.atHome.seen[view]!.filter((tenant) => tenant !== home)).toEqual([])
            expect(probe.atAbroad.seen[view]!.filter((tenant) => tenant !== abroad)).toEqual([])
            expect(probe.nowhere.seen[view]).toEqual([])
          }

          // Each tenant has one ledger, with its one event, and one notebook.
          expect(probe.atHome.counted).toEqual({ actors: 2, events: 1 })
          expect(probe.atAbroad.counted).toEqual({ actors: 2, events: 1 })
          expect(probe.nowhere.counted).toEqual({ actors: 0, events: 0 })

          for (const [table, reason] of Object.entries(probe.denied))
            expect({ table, denied: /permission denied/.test(reason) }).toEqual({
              table,
              denied: true,
            })
        }),
      ),
  },
  {
    name: "row-level security on: the runtime refuses to start when the role is missing or owns an owned table, or a view belongs to an exempt role or one the tenant role can act as",
    timeoutMs: 30_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const missing = yield* prepared(environment, { grant: false })

          const absent = rejection(
            yield* runtimeOn(missing.target, missing.role).pipe(Effect.scoped, Effect.exit),
          )

          const { target, role } = yield* prepared(environment)

          yield* onDatabase(
            target,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              yield* sql`ALTER VIEW durable.receipts OWNER TO CURRENT_USER`
            }),
          )

          const unowned = rejection(yield* runtimeOn(target, role).pipe(Effect.scoped, Effect.exit))

          // The tenant role runs user turns, so it must not be able to alter or drop a view.
          const shared = yield* prepared(environment)

          yield* onDatabase(
            shared.target,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              yield* sql.unsafe(`GRANT CREATE ON SCHEMA durable TO ${shared.role}`)
              yield* sql.unsafe(viewsTo(shared.role))
            }),
          )

          const actable = rejection(
            yield* runtimeOn(shared.target, shared.role).pipe(Effect.scoped, Effect.exit),
          )

          // A table's owner bypasses its policies, so the role must not own an owned table.
          const owner = yield* prepared(environment)

          yield* onDatabase(
            owner.target,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              yield* sql.unsafe(`ALTER TABLE conformance_notes OWNER TO ${owner.role}`)
            }),
          )

          const owning = rejection(
            yield* runtimeOn(owner.target, owner.role).pipe(Effect.scoped, Effect.exit),
          )

          expect(absent).toContain(`role ${missing.role} does not exist`)
          expect(unowned).toContain("durable.receipts belongs to")
          expect(unowned).toContain("which the policies exempt")
          expect(actable).toContain(`which ${shared.role} can act as`)
          expect(owning).toContain(`role ${owner.role} owns public.conformance_notes`)
        }),
      ),
  },
  {
    name: "row-level security on: a replica read runs as the tenant role and binds the tenant, falling through to the primary when the role is refused there",
    requiresReplica: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { target, role } = yield* prepared(environment)
          const replica = environment.replica!

          if (!Redacted.isRedacted(target)) return yield* Effect.die("A replica needs Postgres")

          // The fresh database replicates under its own name.
          const onReplica = new URL(Redacted.value(replica.database))
          onReplica.pathname = new URL(Redacted.value(target)).pathname

          const context = yield* runtimeOn(target, role, Redacted.make(onReplica.href)).pipe(
            Effect.orDie,
          )

          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            const internal = yield* InternalActors
            const control = yield* replica.connect
            const ledger = yield* Replicated.get("replicated")

            const primaryVersion = Effect.map(
              sql<{
                version: string
              }>`SELECT (pg_current_wal_insert_lsn() - '0/0')::text AS version`,
              (rows) => rows[0]!.version,
            ).pipe(Effect.orDie)

            // A read with no version, so the replica answers whenever it can.
            const entries = internal
              .query(
                Request.make({
                  ref: ledger.ref,
                  caller: User.make({ subject: "alice" }),
                  command: "Read",
                  commandId: "",
                  payload: '{"value":null}',
                }),
              )
              .pipe(
                Effect.flatMap((outcome) =>
                  Outcome.guards.Success(outcome)
                    ? decodeEntries(outcome.value)
                    : Effect.die(`Read answered ${outcome._tag}`),
                ),
                Effect.map(({ value }) => value),
                Effect.orDie,
              )

            yield* ledger.Put("first")
            yield* sql.unsafe(`REVOKE SELECT ON actor_state FROM ${role}`)
            yield* replayedThrough(control, yield* primaryVersion)

            yield* Effect.scoped(
              Effect.gen(function* () {
                yield* pauseReplay(control)
                yield* sql.unsafe(`GRANT SELECT ON actor_state TO ${role}`)
                yield* ledger.Put("second")

                // The role cannot read state on the replica, so the primary answers.
                expect(yield* entries).toEqual(["first", "second"])
              }),
            )

            yield* replayedThrough(control, yield* primaryVersion)

            yield* Effect.scoped(
              Effect.gen(function* () {
                yield* pauseReplay(control)
                yield* ledger.Put("third")

                // The stale replica answers for the tenant; unbound, the policy would hide every row.
                expect(yield* entries).toEqual(["first", "second"])
              }),
            )
          }).pipe(Effect.provideContext(context))
        }),
      ),
  },
]
