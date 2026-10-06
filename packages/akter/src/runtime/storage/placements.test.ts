import { BunCrypto } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import { pgTable, text } from "drizzle-orm/pg-core"
import {
  Cause,
  Config,
  type Crypto,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Schema,
  type Scope,
} from "effect"
import { SqlClient } from "effect/sql"
import { afterAll, describe, expect, it } from "vitest"
import { Actor, Actors, Intent } from "../../index.ts"
import type { ActorRef } from "../../identity/caller.ts"
import { ActorTest } from "../../testing/actor-test.ts"
import { disposableDatabase } from "../../testing/database.ts"
import { migrate } from "../database/migrations.ts"
import { ShardMap } from "../database/shards.ts"
import { Database } from "../layer.ts"
import { AUTHORITY_BUCKET, authorityKey, routingKey } from "./codec.ts"
import { AUTHORITY_MOVED_TABLES, checkPlacement } from "./placements.ts"

const runtime = ManagedRuntime.make(BunCrypto.layer)
afterAll(() => runtime.dispose())

const TENANT = "ledger-tenant"

const ledgerRows = Actor.table(
  pgTable("authority_ledger_rows", {
    id: text("id").primaryKey(),
    value: text("value").notNull(),
  }),
)

/**
 * An owned table, and a control table the owned table's trigger projects into
 * and the handler writes with its own SQL, as the control plane's actors do.
 */
const ddl = [
  `CREATE TABLE authority_ledger_rows (
    routing_key bigint NOT NULL, tenant_id text NOT NULL, actor_id text NOT NULL,
    id text NOT NULL, value text NOT NULL,
    PRIMARY KEY (routing_key, tenant_id, actor_id, id))`,
  `CREATE TABLE authority_control (actor_id text PRIMARY KEY, notes integer NOT NULL)`,
  `CREATE TABLE authority_projection (actor_id text NOT NULL, id text NOT NULL, value text NOT NULL,
    PRIMARY KEY (actor_id, id))`,
  `CREATE FUNCTION authority_project() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    INSERT INTO authority_projection VALUES (NEW.actor_id, NEW.id, NEW.value)
    ON CONFLICT (actor_id, id) DO UPDATE SET value = EXCLUDED.value;
    RETURN NULL;
  END $$`,
  `CREATE TRIGGER authority_project AFTER INSERT OR UPDATE ON authority_ledger_rows
    FOR EACH ROW EXECUTE FUNCTION authority_project()`,
]

const Note = Actor.command("Note", { payload: Schema.String, success: Schema.Int })
const Later = Actor.command("Later")
const Noted = Actor.event("Noted", { value: Schema.String })
const Work = Actor.job("Work", { payload: {}, success: Schema.String })

const declare = (placement: "tenant" | "authority") =>
  Actor.make("Ledger", {
    key: Schema.String,
    placement,
    state: Actor.state({
      notes: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    }),
    events: [Noted],
    tables: [ledgerRows],
    api: { Note, Later },
    jobs: { Work: { job: Work, onSuccess: Note } },
  })

const layerOf = (Ledger: ReturnType<typeof declare>) =>
  Layer.mergeAll(
    Ledger.toLayer(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const note = (value: string) =>
          Effect.gen(function* () {
            const turn = yield* Ledger.Turn
            const notes = [...turn.state.notes, value]
            yield* turn.state.set({ notes })
            yield* turn.emit(Noted.make({ value }))
            yield* turn.rows(ledgerRows).insert({ id: String(notes.length), value })
            yield* sql`INSERT INTO authority_control VALUES (${turn.id}, 1)
              ON CONFLICT (actor_id) DO UPDATE SET notes = authority_control.notes + 1`.pipe(
              Effect.orDie,
            )
            return notes.length
          })

        return {
          Note: note,
          Later: () =>
            Effect.gen(function* () {
              const turn = yield* Ledger.Turn
              yield* (yield* Ledger.intents(turn.id)).Note("timer").pipe(Intent.after("1 minute"))
              yield* turn.enqueue(Work.make({}))
            }),
        }
      }),
    ),
    Ledger.toJobLayer(Effect.succeed({ Work: () => Effect.succeed("work") })),
  )

const database = <A, E>(
  body: Effect.Effect<A, E, SqlClient.SqlClient | PgClient.PgClient | Scope.Scope | Crypto.Crypto>,
) =>
  runtime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const url = yield* disposableDatabase({ url: yield* Config.Redacted("TEST_DATABASE_URL") })
        const client = yield* Layer.build(Database.postgres({ url, offTurnConnections: 4 }))
        yield* migrate.pipe(Effect.provideContext(client))
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          for (const statement of ddl) yield* sql.unsafe(statement)
        }).pipe(Effect.provideContext(client))

        return yield* body.pipe(Effect.provideContext(client))
      }),
    ),
  )

const Tenanted = declare("tenant")
const Authority = declare("authority")

/** Runs `body` on a runtime serving `Ledger` as `definition` places it, over the test's database. */
const serve = <A, E, R>(definition: ReturnType<typeof declare>, body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const postgres = yield* PgClient.PgClient
    const context = yield* Layer.build(
      layerOf(definition).pipe(
        Layer.provideMerge(ActorTest.layer({ database: postgres.config.url!, maxConnections: 4 })),
      ),
    )

    return yield* body.pipe(Actor.tenant(TENANT), Effect.provideContext(context))
  }).pipe(Effect.scoped)

/** Every row the move rewrites, by table: the per-actor tables and the owned one. */
const ledgerRowKeys = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const found: Record<string, ReadonlyArray<string>> = {}

  for (const table of AUTHORITY_MOVED_TABLES) {
    const column = table.startsWith("actor_subscription") && table !== "actor_subscription_cursors"
    const rows = yield* sql<{ key: string }>`
      SELECT routing_key::text AS key FROM ${sql(table)}
      WHERE ${sql(column ? "source_type" : "actor_type")} = 'Ledger' ORDER BY 1`
    if (rows.length > 0) found[table] = rows.map(({ key }) => key)
  }

  const owned = yield* sql<{ key: string }>`
    SELECT routing_key::text AS key FROM authority_ledger_rows ORDER BY 1`
  found.authority_ledger_rows = owned.map(({ key }) => key)

  return found
})

const tenantKey = routingKey({
  ref: { tenant: TENANT, actor: "Ledger", id: "a" },
  placement: "tenant",
})

const movedKey = authorityKey(tenantKey)

/** Writes rows of two Ledger actors under tenant placement: notes, a pending timer and a job. */
const seed = Effect.gen(function* () {
  const actors = yield* Actors
  const commandId = yield* actors.mintCommandId
  const a = yield* Tenanted.get("a")
  const b = yield* Tenanted.get("b")
  expect(yield* a.Note("first").pipe(Actor.commandId(commandId))).toBe(1)
  yield* a.Later()
  yield* (yield* ActorTest).advance(0)
  yield* b.Note("other")

  return commandId
})

const placementOf = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql<{ placement: string }>`SELECT placement FROM actor_placements WHERE actor_type = 'Ledger'`,
)

const Notes = Schema.Struct({ notes: Schema.Array(Schema.String) })

const notesOf = (handle: { readonly ref: ActorRef }) =>
  Effect.gen(function* () {
    const test = yield* ActorTest
    const { notes } = yield* Schema.decodeUnknownEffect(Notes)(
      (yield* test.inspect(handle.ref)).state,
    )
    return notes
  })

describe("authority placement with Postgres", () => {
  it("keys every authority-placed row in the authority bucket, beside the tenant's key", () => {
    expect(movedKey >> 56n).toBe(BigInt(AUTHORITY_BUCKET))
    expect(movedKey & ((1n << 56n) - 1n)).toBe(tenantKey & ((1n << 56n) - 1n))
    expect(
      routingKey({ ref: { tenant: TENANT, actor: "Other", id: "z" }, placement: "authority" }),
    ).toBe(movedKey)
  })

  it(
    "moves a tenant-placed type's rows to authority keys at its next start, keeping state, pending timers, owned rows and receipts that answer a redelivered command",
    () =>
      database(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const commandId = yield* serve(Tenanted, seed)
          const before = yield* ledgerRowKeys

          expect(Object.keys(before).sort()).toEqual(
            [
              "actor_events",
              "actor_generations",
              "actor_outbox",
              "actor_receipts",
              "actor_state",
              "authority_ledger_rows",
            ].sort(),
          )
          expect(new Set(Object.values(before).flat()).has(String(movedKey))).toBe(false)

          yield* serve(
            Authority,
            Effect.gen(function* () {
              const test = yield* ActorTest
              const after = yield* ledgerRowKeys
              const a = yield* Authority.get("a")
              const b = yield* Authority.get("b")

              expect(yield* placementOf).toEqual([{ placement: "authority" }])
              expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
              for (const [table, keys] of Object.entries(after)) {
                expect(keys).toHaveLength(before[table]!.length)
                expect(new Set(keys)).toEqual(new Set([String(movedKey)]))
              }
              expect(yield* notesOf(a)).toEqual(["first", "work"])

              expect(yield* a.Note("first").pipe(Actor.commandId(commandId))).toBe(1)
              expect(yield* test.receiptsFor(a.ref, "Note")).toBe(2)
              expect(yield* notesOf(a)).toEqual(["first", "work"])

              yield* test.advance("1 minute")
              yield* test.advance(0)
              expect(yield* notesOf(a)).toEqual(["first", "work", "timer"])
              expect(yield* b.Note("again")).toBe(2)
              expect(
                yield* sql`SELECT actor_id, notes FROM authority_control ORDER BY actor_id`,
              ).toEqual([
                { actor_id: "a", notes: 3 },
                { actor_id: "b", notes: 2 },
              ])
              expect(
                yield* sql`SELECT actor_id, id, value FROM authority_projection ORDER BY actor_id, id`,
              ).toEqual([
                { actor_id: "a", id: "1", value: "first" },
                { actor_id: "a", id: "2", value: "work" },
                { actor_id: "a", id: "3", value: "timer" },
                { actor_id: "b", id: "1", value: "other" },
                { actor_id: "b", id: "2", value: "again" },
              ])
              expect(new Set(Object.values(yield* ledgerRowKeys).flat())).toEqual(
                new Set([String(movedKey)]),
              )
            }),
          )

          yield* serve(
            Authority,
            Effect.gen(function* () {
              expect(yield* notesOf(yield* Authority.get("a"))).toEqual(["first", "work", "timer"])
            }),
          )

          const refused = yield* serve(Tenanted, Effect.void).pipe(Effect.exit)
          expect(Cause.pretty((refused as Exit.Failure<unknown, unknown>).cause)).toContain(
            "Actor Ledger placement differs from the deployment; migrate explicitly",
          )
        }),
      ),
    60_000,
  )

  it("rolls back a move that fails part way, then moves once on the next start", () =>
    database(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* serve(Tenanted, seed)
        const before = yield* ledgerRowKeys

        yield* sql`CREATE FUNCTION authority_fault() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'injected move failure'; END $$`
        yield* sql`CREATE TRIGGER authority_fault BEFORE UPDATE OF routing_key ON authority_ledger_rows
          FOR EACH ROW EXECUTE FUNCTION authority_fault()`

        const failed = yield* serve(Authority, Effect.void).pipe(Effect.exit)
        expect(Exit.isFailure(failed)).toBe(true)
        expect(Cause.pretty((failed as Exit.Failure<unknown, unknown>).cause)).toContain(
          "injected move failure",
        )
        expect(yield* placementOf).toEqual([{ placement: "tenant" }])
        expect(yield* ledgerRowKeys).toEqual(before)

        yield* sql`DROP TRIGGER authority_fault ON authority_ledger_rows`

        yield* serve(
          Authority,
          Effect.gen(function* () {
            expect(yield* placementOf).toEqual([{ placement: "authority" }])
            expect(yield* notesOf(yield* Authority.get("a"))).toEqual(["first", "work"])
            for (const [table, keys] of Object.entries(yield* ledgerRowKeys)) {
              expect(keys).toHaveLength(before[table]!.length)
              expect(new Set(keys)).toEqual(new Set([String(movedKey)]))
            }
          }),
        )
      }),
    ))

  it("moves once when two starts race, and refuses to move once the map names a data shard", () =>
    database(
      Effect.gen(function* () {
        yield* serve(Tenanted, seed)
        const before = yield* ledgerRowKeys
        const move = checkPlacement({ name: "Ledger", placement: "authority" })

        const routed = yield* move.pipe(
          Effect.provideService(ShardMap, [{ first: -128, last: 127, shard: "sh2" }]),
          Effect.exit,
        )
        expect(Cause.pretty((routed as Exit.Failure<unknown, unknown>).cause)).toContain(
          "deploy it before the database routes any table",
        )
        expect(yield* placementOf).toEqual([{ placement: "tenant" }])
        expect(yield* ledgerRowKeys).toEqual(before)

        const raced = yield* Effect.all([move, move], { concurrency: 2 }).pipe(Effect.exit)
        expect(Exit.isSuccess(raced)).toBe(true)
        expect(yield* placementOf).toEqual([{ placement: "authority" }])
        for (const [table, keys] of Object.entries(yield* ledgerRowKeys)) {
          expect(keys).toHaveLength(before[table]!.length)
          expect(new Set(keys)).toEqual(new Set([String(movedKey)]))
        }
      }),
    ))
})
