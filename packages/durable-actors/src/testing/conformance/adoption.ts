import { PGlite } from "@electric-sql/pglite"
import { customType, integer, pgTable, text, uuid } from "drizzle-orm/pg-core"
import { Cause, Crypto, Effect, Exit, Layer, Redacted, Schema, type Scope } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor, type Actors, User } from "../../index.ts"
import type { InternalActors } from "../../runtime/actors.ts"
import { backfillAdoption } from "../../runtime/adoption/backfill.ts"
import { adoptionWriters, observeAdoption } from "../../runtime/adoption/observe.ts"
import { ownerIndexSql, planAdoption } from "../../runtime/adoption/plan.ts"
import { AdoptionRefused } from "../../runtime/adoption/target.ts"
import { migrate } from "../../runtime/database/migrations.ts"
import { Database } from "../../runtime/layer.ts"
import { ActorTest } from "../actor-test.ts"
import type {
  ConformanceCase,
  ConformanceDatabase,
  ConformanceEnvironment,
} from "../conformance.ts"

const invoices = pgTable("conformance_invoices", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  accountId: text("account_id").notNull(),
  amount: integer("amount").notNull().default(0),
  note: text("note"),
})

const invoiceRows = Actor.table(invoices, {
  owner: { tenant: invoices.orgId, actor: invoices.accountId },
})

const contacts = pgTable("conformance_contacts", {
  id: text("id").primaryKey(),
  tenant: text("tenant").notNull(),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
})

const contactRows = Actor.table(contacts, {
  owner: { tenant: contacts.tenant, actor: contacts.owner },
  access: "read",
})

const shipments = pgTable("conformance_shipments", {
  id: text("id").primaryKey(),
  tenantUuid: uuid("tenant_uuid").notNull(),
  actorUuid: uuid("actor_uuid").notNull(),
  label: text("label").notNull(),
})

const shipmentRows = Actor.table(shipments, {
  owner: { tenant: shipments.tenantUuid, actor: shipments.actorUuid },
})

const legacyDdl = [
  `CREATE TABLE conformance_invoices (
    id text PRIMARY KEY,
    org_id text NOT NULL,
    account_id text NOT NULL,
    amount integer NOT NULL DEFAULT 0,
    note text)`,
  `CREATE TABLE conformance_contacts (
    id text PRIMARY KEY,
    tenant text NOT NULL,
    owner text NOT NULL,
    name text NOT NULL)`,
  `CREATE INDEX conformance_contacts_owner ON conformance_contacts (tenant, owner)`,
  `CREATE TABLE conformance_shipments (
    id text PRIMARY KEY,
    tenant_uuid uuid NOT NULL,
    actor_uuid uuid NOT NULL,
    label text NOT NULL)`,
]

const Line = Schema.Struct({
  id: Schema.String,
  amount: Schema.Int,
  note: Schema.NullOr(Schema.String),
})

const Add = Actor.command("Add", {
  input: Schema.Struct({ id: Schema.String, amount: Schema.Int }),
})

const Put = Actor.command("Put", {
  input: Schema.Array(Schema.Struct({ id: Schema.String, amount: Schema.Int })),
})

const Bump = Actor.command("Bump", {
  input: Schema.Struct({ id: Schema.String, amount: Schema.Int }),
})

const Remove = Actor.command("Remove", { input: Schema.String })

const Lines = Actor.query("Lines", { output: Schema.Array(Line) })

const Find = Actor.query("Find", { input: Schema.String, output: Schema.Array(Line) })

const Account = Actor.make("Account", {
  key: Schema.String,
  tables: [invoiceRows],
  api: { Add, Put, Bump, Remove, Lines, Find },
})

const Names = Actor.query("Names", { output: Schema.Array(Schema.String) })

const Peek = Actor.command("Peek", { output: Schema.Array(Schema.String) })

const Probe = Actor.command("Probe", { output: Schema.Boolean })

const Grouped = Actor.command("Grouped")

const Directory = Actor.make("Directory", {
  key: Schema.String,
  tables: [contactRows],
  api: { Names, Peek, Probe, Grouped },
})

const Ship = Actor.command("Ship", {
  input: Schema.Struct({ id: Schema.String, label: Schema.String }),
})

const Labels = Actor.query("Labels", { output: Schema.Array(Schema.String) })

const Carrier = Actor.make("Carrier", {
  key: Schema.String,
  tables: [shipmentRows],
  api: { Ship, Labels },
})

const adopting = [Account, Directory, Carrier]

const accountLayer = Layer.mergeAll(
  Account.toLayer(
    Effect.succeed({
      Add: Effect.fnUntraced(function* (input: { readonly id: string; readonly amount: number }) {
        const turn = yield* Account.Turn
        yield* turn.rows(invoiceRows).insert(input)
      }),
      Put: Effect.fnUntraced(function* (
        input: ReadonlyArray<{ readonly id: string; readonly amount: number }>,
      ) {
        const turn = yield* Account.Turn
        yield* turn.rows(invoiceRows).upsert(input)
      }),
      Bump: Effect.fnUntraced(function* (input: { readonly id: string; readonly amount: number }) {
        const turn = yield* Account.Turn
        yield* turn.rows(invoiceRows).update({ amount: input.amount }).where({ id: input.id })
      }),
      Remove: Effect.fnUntraced(function* (id: string) {
        const turn = yield* Account.Turn
        yield* turn.rows(invoiceRows).delete().where({ id })
      }),
    }),
  ),
  Account.toQueryLayer(
    Effect.succeed({
      Lines: Effect.fnUntraced(function* () {
        const read = yield* Account.Read

        const found = yield* read.rows(invoiceRows).all({ orderBy: { id: "asc" } })

        return found.map(({ id, amount, note }) => ({ id, amount, note }))
      }),
      Find: Effect.fnUntraced(function* (id: string) {
        const read = yield* Account.Read

        const found = yield* read.rows(invoiceRows).all({ where: { id } })

        return found.map(({ id, amount, note }) => ({ id, amount, note }))
      }),
    }),
  ),
)

const directoryLayer = Layer.mergeAll(
  Directory.toLayer(
    Effect.succeed({
      Peek: Effect.fnUntraced(function* () {
        const turn = yield* Directory.Turn
        const found = yield* turn.rows(contactRows).all({ orderBy: { id: "asc" } })

        return found.map(({ name }) => name)
      }),
      Probe: Effect.fnUntraced(function* () {
        const turn = yield* Directory.Turn

        return "insert" in turn.rows(contactRows) || "update" in turn.rows(contactRows)
      }),
      Grouped: Effect.fnUntraced(function* () {
        const turn = yield* Directory.Turn
        yield* turn.group((database) => database.select().from(contacts))
      }),
    }),
  ),
  Directory.toQueryLayer(
    Effect.succeed({
      Names: Effect.fnUntraced(function* () {
        const read = yield* Directory.Read
        const found = yield* read.rows(contactRows).all({ orderBy: { id: "asc" } })

        return found.map(({ name }) => name)
      }),
    }),
  ),
)

const carrierLayer = Layer.mergeAll(
  Carrier.toLayer(
    Effect.succeed({
      Ship: Effect.fnUntraced(function* (input: { readonly id: string; readonly label: string }) {
        const turn = yield* Carrier.Turn
        yield* turn.rows(shipmentRows).insert(input)
      }),
    }),
  ),
  Carrier.toQueryLayer(
    Effect.succeed({
      Labels: Effect.fnUntraced(function* () {
        const read = yield* Carrier.Read
        const found = yield* read.rows(shipmentRows).all({ orderBy: { id: "asc" } })

        return found.map(({ label }) => label)
      }),
    }),
  ),
)

const live = Layer.mergeAll(accountLayer, directoryLayer, carrierLayer)

type Target = Redacted.Redacted<string> | { readonly liveClient: PGlite }

const databaseLayer = (target: Target) =>
  Redacted.isRedacted(target)
    ? Database.postgres({ url: target, maxConnections: 2, offTurnConnections: 2 })
    : Database.pglite(target)

const onDatabase = <A, E>(target: Target, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Layer.build(databaseLayer(target)).pipe(
    Effect.flatMap((context) => Effect.provideContext(effect, context)),
    Effect.scoped,
    Effect.orDie,
  )

/** A migrated fresh database holding the application's existing tables, observed unless `observe` is false. */
const prepared = (
  environment: ConformanceEnvironment,
  options: { readonly observe: boolean; readonly index?: boolean } = { observe: true },
) =>
  Effect.gen(function* () {
    const fresh: ConformanceDatabase = yield* environment.freshDatabase

    const target: Target = Redacted.isRedacted(fresh)
      ? fresh
      : {
          liveClient: yield* Effect.acquireRelease(
            Effect.sync(() => new PGlite()).pipe(
              Effect.tap((client) => Effect.promise(() => client.waitReady)),
            ),
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

        for (const statement of legacyDdl) yield* sql.unsafe(statement)

        if (!options.observe) return

        yield* observeAdoption(adopting)

        if (options.index === false) return

        for (const table of ["conformance_invoices", "conformance_shipments"])
          yield* sql.unsafe(
            ownerIndexSql({
              schema: "public",
              table,
              access: "write",
              tenantColumn: table === "conformance_invoices" ? "org_id" : "tenant_uuid",
              actorColumn: table === "conformance_invoices" ? "account_id" : "actor_uuid",
            }).replace("CONCURRENTLY ", ""),
          )
      }),
    )

    return target
  })

const runtimeOn = (target: Target) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto

    return yield* Layer.build(
      Layer.fresh(
        live.pipe(
          Layer.provideMerge(
            ActorTest.layer({
              database: Redacted.isRedacted(target) ? target : { liveClient: target.liveClient },
              as: User.make({ subject: "alice" }),
            }),
          ),
          Layer.provide(Layer.succeed(Crypto.Crypto, crypto)),
        ),
      ),
    )
  })

/** Runs `body` on a runtime over a fresh database that already holds the application's tables. */
const withAdoption = <A, E>(
  environment: ConformanceEnvironment,
  options: { readonly observe: boolean; readonly index?: boolean },
  body: (setup: {
    readonly target: Target
  }) => Effect.Effect<
    A,
    E,
    Actors | InternalActors | ActorTest | SqlClient.SqlClient | Crypto.Crypto | Scope.Scope
  >,
) =>
  environment.run(
    Effect.gen(function* () {
      const target = yield* prepared(environment, options)
      const context = yield* runtimeOn(target).pipe(Effect.orDie)

      return yield* body({ target }).pipe(Effect.provideContext(context))
    }),
  )

const refusal = (declare: () => void) => {
  try {
    declare()

    return "succeeded"
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const defect = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "succeeded"

const legacyInsert = (
  rows: ReadonlyArray<{
    readonly id: string
    readonly org: string
    readonly account: string
    readonly amount?: number
  }>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    for (const row of rows)
      yield* sql`INSERT INTO conformance_invoices (id, org_id, account_id, amount)
        VALUES (${row.id}, ${row.org}, ${row.account}, ${row.amount ?? 0})`
  })

const invoiceRow = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return yield* sql<{
      org_id: string
      account_id: string
      amount: number
      routing_key: string | null
    }>`SELECT org_id, account_id, amount, routing_key::text AS routing_key
      FROM conformance_invoices WHERE id = ${id}`
  })

const actorRoutingKey = (tenant: string, actor: string, id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return (yield* sql<{ routing_key: string }>`
      SELECT routing_key::text AS routing_key FROM actor_generations
      WHERE tenant_id = ${tenant} AND actor_type = ${actor} AND actor_id = ${id}`)[0]?.routing_key
  })

export const adoptionConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "maps existing tenant and actor columns, reads only the actor's rows, and never shows another tenant's or actor's rows for the same business key",
    run: ({ expect, environment }) =>
      withAdoption(environment, { observe: true }, () =>
        Effect.gen(function* () {
          const test = yield* ActorTest
          const tenant = test.tenant
          const other = `${tenant}-other`

          yield* legacyInsert([
            { id: "inv-1", org: tenant, account: "acct-a", amount: 10 },
            { id: "inv-2", org: tenant, account: "acct-b", amount: 20 },
            { id: "inv-3", org: other, account: "acct-a", amount: 30 },
          ])
          yield* backfillAdoption(adopting, { only: "conformance_invoices" })

          const a = yield* Account.get("acct-a")
          const b = yield* Account.get("acct-b")
          const abroad = yield* Account.get("acct-a").pipe(Actor.tenant(other))

          expect(yield* a.Lines()).toEqual([{ id: "inv-1", amount: 10, note: null }])
          expect(yield* b.Lines()).toEqual([{ id: "inv-2", amount: 20, note: null }])
          expect(yield* abroad.Lines()).toEqual([{ id: "inv-3", amount: 30, note: null }])
          expect(yield* b.Find("inv-1")).toEqual([])
          expect(yield* a.Find("inv-2")).toEqual([])
          expect(yield* a.Find("inv-3")).toEqual([])

          yield* a.Add({ id: "inv-4", amount: 40 })
          yield* a.Bump({ id: "inv-1", amount: 11 })
          yield* b.Bump({ id: "inv-1", amount: 99 })
          yield* b.Remove("inv-1")
          yield* a.Remove("inv-2")

          expect((yield* a.Lines()).map(({ id, amount }) => [id, amount])).toEqual([
            ["inv-1", 11],
            ["inv-4", 40],
          ])
          expect((yield* invoiceRow("inv-2")).map(({ amount }) => amount)).toEqual([20])

          const written = yield* invoiceRow("inv-4")
          const key = yield* actorRoutingKey(tenant, "Account", "acct-a")

          expect(written).toEqual([
            { org_id: tenant, account_id: "acct-a", amount: 40, routing_key: key },
          ])
          expect(key).not.toBe(undefined)
        }),
      ),
  },
  {
    name: "a read-adopted table is readable in a turn and a query, has no mutation methods, and is refused by group",
    run: ({ expect, environment }) =>
      withAdoption(environment, { observe: true }, () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          const tenant = test.tenant

          for (const [id, org, owner, name] of [
            ["c1", tenant, "owner-1", "Ada"],
            ["c2", tenant, "owner-1", "Grace"],
            ["c3", tenant, "owner-2", "Edsger"],
            ["c4", `${tenant}-other`, "owner-1", "Barbara"],
          ] as const)
            yield* sql`INSERT INTO conformance_contacts (id, tenant, owner, name)
              VALUES (${id}, ${org}, ${owner}, ${name})`

          const directory = yield* Directory.get("owner-1")

          expect(yield* directory.Names()).toEqual(["Ada", "Grace"])
          expect(yield* directory.Peek()).toEqual(["Ada", "Grace"])
          expect(yield* directory.Probe()).toBe(false)
          expect(defect(yield* directory.Grouped().pipe(Effect.exit))).toContain(
            "adopted for reading only",
          )
          expect(yield* (yield* Directory.get("owner-2")).Names()).toEqual(["Edsger"])

          const columns = yield* sql<{ name: string }>`
            SELECT column_name AS name FROM information_schema.columns
            WHERE table_name = 'conformance_contacts' ORDER BY ordinal_position`

          expect(columns.map(({ name }) => name)).toEqual(["id", "tenant", "owner", "name"])
          expect(
            yield* sql`SELECT 1 FROM actor_adoptions WHERE table_name = 'conformance_contacts'`,
          ).toEqual([])
          expect(
            yield* sql`SELECT tgname FROM pg_trigger WHERE tgrelid = 'conformance_contacts'::regclass AND NOT tgisinternal`,
          ).toEqual([])
        }),
      ),
  },
  {
    name: "refuses an unsupported mapping: an integer or citext column, a missing column, one column mapped twice, a minted-id actor type",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.sync(() => {
          const numbers = pgTable("conformance_numbers", {
            id: text("id").primaryKey(),
            orgId: integer("org_id").notNull(),
            accountId: text("account_id").notNull(),
          })

          const citext = customType<{ data: string }>({ dataType: () => "citext" })

          const folded = pgTable("conformance_folded", {
            id: text("id").primaryKey(),
            orgId: citext("org_id").notNull(),
            accountId: text("account_id").notNull(),
          })

          const elsewhere = pgTable("conformance_elsewhere", { other: text("other") })

          const plain = pgTable("conformance_plain", {
            id: text("id").primaryKey(),
            orgId: text("org_id").notNull(),
            accountId: text("account_id").notNull(),
          })

          expect(
            refusal(() =>
              Actor.table(numbers, { owner: { tenant: numbers.orgId, actor: numbers.accountId } }),
            ),
          ).toContain("only text, varchar, and uuid columns can be mapped")
          expect(
            refusal(() =>
              Actor.table(folded, { owner: { tenant: folded.orgId, actor: folded.accountId } }),
            ),
          ).toContain("only text, varchar, and uuid columns can be mapped")
          expect(
            refusal(() =>
              Actor.table(plain, {
                owner: { tenant: elsewhere.other as never, actor: plain.accountId },
              }),
            ),
          ).toContain("is not a column of conformance_plain")
          expect(
            refusal(() =>
              Actor.table(plain, { owner: { tenant: plain.orgId, actor: plain.orgId } }),
            ),
          ).toContain("name the same column")

          const routed = pgTable("conformance_routed", {
            id: text("id").primaryKey(),
            routingKey: text("routing_key"),
            orgId: text("org_id"),
            accountId: text("account_id"),
          })

          expect(
            refusal(() =>
              Actor.table(routed, { owner: { tenant: routed.orgId, actor: routed.accountId } }),
            ),
          ).toContain("reserved for ownership")

          const minted = pgTable("conformance_minted", {
            id: text("id").primaryKey(),
            orgId: text("org_id").notNull(),
            accountId: text("account_id").notNull(),
          })

          const mintedRows = Actor.table(minted, {
            owner: { tenant: minted.orgId, actor: minted.accountId },
          })

          const Open = Actor.command("Open")

          expect(
            refusal(() =>
              Actor.make("Minted", {
                tables: [mintedRows],
                api: { Open },
                policy: { createdBy: Open },
              }),
            ),
          ).toContain("mints its ids and cannot adopt table conformance_minted")
        }),
      ),
  },
  {
    name: "refuses a mapping the database contradicts: plan reports it and observe changes nothing",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const target = yield* prepared(environment, { observe: false })

          const mismatched = pgTable("conformance_mismatch", {
            id: text("id").primaryKey(),
            orgId: text("org_id").notNull(),
            accountId: text("account_id").notNull(),
          })

          const rows = Actor.table(mismatched, {
            owner: { tenant: mismatched.orgId, actor: mismatched.accountId },
          })

          const Mismatch = Actor.make("Mismatch", {
            key: Schema.String,
            tables: [rows],
            api: { Add },
          })

          yield* onDatabase(
            target,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient

              yield* sql`CREATE TABLE conformance_mismatch (
                id text PRIMARY KEY, org_id integer NOT NULL, account_id text NOT NULL)`

              const [plan] = yield* planAdoption([Mismatch])

              expect(plan!.problems).toEqual([
                "tenant column org_id is int4; only text, varchar, and uuid columns can be mapped",
              ])

              const refused = yield* observeAdoption([Mismatch]).pipe(Effect.flip)

              expect(refused).toBeInstanceOf(AdoptionRefused)
              expect(refused.message).toContain("conformance_mismatch cannot be adopted")
              expect(yield* sql`SELECT 1 FROM actor_adoptions`).toEqual([])
              expect(
                yield* sql`SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'conformance_mismatch' AND column_name = 'routing_key'`,
              ).toEqual([])
            }),
          )
        }),
      ),
  },
  {
    name: "refuses startup when an adopted table has no actor_adoptions row",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const target = yield* prepared(environment, { observe: false })
          const exit = yield* runtimeOn(target).pipe(Effect.exit)

          expect(defect(exit)).toContain(
            "conformance_invoices has no adoption record; run durable adopt observe conformance_invoices before serving it",
          )
        }),
      ),
  },
  {
    name: "refuses startup when an adopted table has no index leading with its owner columns",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const target = yield* prepared(environment, { observe: true, index: false })
          const exit = yield* runtimeOn(target).pipe(Effect.exit)

          expect(defect(exit)).toContain(
            `needs an index that leads with its owner columns: CREATE INDEX CONCURRENTLY IF NOT EXISTS "conformance_invoices_durable_owner" ON "public"."conformance_invoices" ("routing_key", "org_id", "account_id")`,
          )
        }),
      ),
  },
  {
    name: "maps uuid columns and refuses an actor id that is not a lowercase uuid",
    run: ({ expect, environment }) =>
      withAdoption(environment, { observe: true }, () =>
        Effect.gen(function* () {
          const test = yield* ActorTest
          const sql = yield* SqlClient.SqlClient
          const actor = yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie)

          yield* sql`INSERT INTO conformance_shipments (id, tenant_uuid, actor_uuid, label)
            VALUES ('legacy', ${test.tenant}::uuid, ${actor}::uuid, 'legacy')`
          yield* backfillAdoption(adopting, { only: "conformance_shipments" })

          const carrier = yield* Carrier.get(actor)
          yield* carrier.Ship({ id: "new", label: "new" })

          expect(yield* carrier.Labels()).toEqual(["legacy", "new"])

          const shouting = yield* Carrier.get("NOT-A-UUID")
          expect(
            defect(yield* shouting.Ship({ id: "bad", label: "bad" }).pipe(Effect.exit)),
          ).toContain("is not a lowercase uuid")
          expect(yield* sql`SELECT 1 FROM conformance_shipments WHERE id = 'bad'`).toEqual([])
        }),
      ),
  },
  {
    name: "an insert or upsert on another actor's primary key fails the turn as a defect and changes nothing",
    run: ({ expect, environment }) =>
      withAdoption(environment, { observe: true }, () =>
        Effect.gen(function* () {
          const test = yield* ActorTest
          const tenant = test.tenant

          yield* legacyInsert([{ id: "inv-1", org: tenant, account: "acct-a", amount: 10 }])
          yield* backfillAdoption(adopting, { only: "conformance_invoices" })

          const thief = yield* Account.get("acct-b")
          const owner = yield* Account.get("acct-a")

          expect(defect(yield* thief.Add({ id: "inv-1", amount: 99 }).pipe(Effect.exit))).toContain(
            "conformance_invoices",
          )
          expect(
            defect(
              yield* thief
                .Put([
                  { id: "inv-fresh", amount: 1 },
                  { id: "inv-1", amount: 99 },
                ])
                .pipe(Effect.exit),
            ),
          ).toContain("belongs to another actor")

          expect(yield* invoiceRow("inv-1")).toMatchObject([
            { org_id: tenant, account_id: "acct-a", amount: 10 },
          ])
          expect(yield* invoiceRow("inv-fresh")).toEqual([])
          expect(yield* thief.Lines()).toEqual([])

          yield* owner.Put([
            { id: "inv-1", amount: 12 },
            { id: "inv-5", amount: 5 },
          ])
          expect((yield* owner.Lines()).map(({ id, amount }) => [id, amount])).toEqual([
            ["inv-1", 12],
            ["inv-5", 5],
          ])
        }),
      ),
  },
  {
    name: "observing records a second pool's writes by role, application_name, operation and rows, classes the turn's writes in_turn, and changes no outcome",
    requiresIndependentConnections: true,
    run: ({ expect, environment }) =>
      withAdoption(environment, { observe: true }, ({ target }) =>
        Effect.gen(function* () {
          if (!Redacted.isRedacted(target))
            return yield* Effect.die(new Error("Observation by a second pool needs Postgres"))

          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          const crypto = yield* Crypto.Crypto
          const role = `legacy_${(yield* crypto.randomUUIDv4.pipe(Effect.orDie)).replaceAll("-", "")}`

          yield* sql.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD 'legacy'`)
          yield* sql.unsafe(
            `GRANT SELECT, INSERT, UPDATE, DELETE ON conformance_invoices TO ${role}`,
          )
          yield* Effect.addFinalizer(() =>
            sql
              .unsafe(`DROP OWNED BY ${role}`)
              .pipe(Effect.andThen(sql.unsafe(`DROP ROLE ${role}`)), Effect.orDie),
          )

          const url = new URL(Redacted.value(target))
          url.username = role
          url.password = "legacy"
          url.searchParams.set("application_name", "legacy-app")

          yield* onDatabase(
            Redacted.make(url.href),
            Effect.gen(function* () {
              const legacy = yield* SqlClient.SqlClient
              yield* legacy`INSERT INTO conformance_invoices (id, org_id, account_id) VALUES
                ('l1', ${test.tenant}, 'acct-a'), ('l2', ${test.tenant}, 'acct-a')`
              yield* legacy`UPDATE conformance_invoices SET amount = 5 WHERE id = 'l1'`
              yield* legacy`DELETE FROM conformance_invoices WHERE id = 'l2'`
            }),
          )

          yield* backfillAdoption(adopting, { only: "conformance_invoices" })
          const account = yield* Account.get("acct-a")
          yield* account.Add({ id: "t1", amount: 1 })

          expect((yield* invoiceRow("l1")).map(({ amount }) => amount)).toEqual([5])
          expect(yield* invoiceRow("l2")).toEqual([])
          expect((yield* account.Lines()).map(({ id }) => id)).toEqual(["l1", "t1"])

          const writers = yield* adoptionWriters(adopting, { only: "conformance_invoices" })
          const legacyWriters = writers.filter((writer) => writer.sessionUser === role)

          expect(
            legacyWriters.map(({ operation, applicationName, inTurn, statements, rows }) => ({
              operation,
              applicationName,
              inTurn,
              statements,
              rows,
            })),
          ).toEqual([
            {
              operation: "DELETE",
              applicationName: "legacy-app",
              inTurn: false,
              statements: 1,
              rows: 1,
            },
            {
              operation: "INSERT",
              applicationName: "legacy-app",
              inTurn: false,
              statements: 1,
              rows: 2,
            },
            {
              operation: "UPDATE",
              applicationName: "legacy-app",
              inTurn: false,
              statements: 1,
              rows: 1,
            },
          ])

          const turns = writers.filter((writer) => writer.inTurn)

          expect(
            turns.map(({ operation, rows, sessionUser }) => [
              operation,
              rows,
              sessionUser === role,
            ]),
          ).toEqual([["INSERT", 1, false]])
          expect(writers.every((writer) => !writer.allowed)).toBe(true)
          expect(writers.filter((writer) => !writer.inTurn && writer.sessionUser !== role)).toEqual(
            [],
          )

          const cleared = yield* adoptionWriters(adopting, {
            only: "conformance_invoices",
            clear: true,
          })

          expect(cleared.length).toBe(writers.length)
          expect(yield* adoptionWriters(adopting, { only: "conformance_invoices" })).toEqual([])
        }),
      ),
  },
  {
    name: "backfill fills every row with the key of the actor that writes it and refuses rows with NULL mapped columns",
    run: ({ expect, environment }) =>
      withAdoption(environment, { observe: true }, () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          const tenant = test.tenant

          yield* legacyInsert(
            Array.from({ length: 25 }, (_, index) => ({
              id: `inv-${String(index).padStart(2, "0")}`,
              org: tenant,
              account: `acct-${index % 3}`,
            })),
          )
          yield* sql`ALTER TABLE conformance_invoices ALTER COLUMN account_id DROP NOT NULL`
          yield* sql`INSERT INTO conformance_invoices (id, org_id, account_id) VALUES ('orphan', ${tenant}, NULL), ('blank', ${tenant}, '')`

          const refused = yield* backfillAdoption(adopting, {
            only: "conformance_invoices",
            batch: 10,
          }).pipe(Effect.flip)

          expect(refused.message).toContain("NULL or empty")
          expect(refused.message).toContain("(blank) (orphan)")
          expect(
            yield* sql`SELECT 1 FROM conformance_invoices WHERE routing_key IS NOT NULL`,
          ).toEqual([])

          yield* sql`DELETE FROM conformance_invoices WHERE id IN ('orphan', 'blank')`

          const [result] = yield* backfillAdoption(adopting, {
            only: "conformance_invoices",
            batch: 10,
          })

          expect(result).toEqual({ table: "public.conformance_invoices", filled: 25, passes: 2 })

          for (const account of ["acct-0", "acct-1", "acct-2"]) {
            const handle = yield* Account.get(account)
            yield* handle.Add({ id: `turn-${account}`, amount: 1 })
            const expected = yield* actorRoutingKey(tenant, "Account", account)

            const keys = yield* sql<{ routing_key: string }>`
              SELECT DISTINCT routing_key::text AS routing_key FROM conformance_invoices
              WHERE account_id = ${account}`

            expect(keys.map((row) => row.routing_key)).toEqual([expected])
          }
        }),
      ),
  },
  {
    name: "0024_adoption applies on PGlite and Postgres",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const target = yield* prepared(environment, { observe: false })

          yield* onDatabase(
            target,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient

              expect(
                yield* sql`SELECT to_regclass('actor_adoptions') IS NOT NULL AS adoptions,
                  to_regclass('actor_adoption_writes') IS NOT NULL AS writes,
                  to_regprocedure('actor_adoption_observe()') IS NOT NULL AS observe,
                  to_regprocedure('actor_adoption_guard()') IS NOT NULL AS guard`,
              ).toEqual([{ adoptions: true, writes: true, observe: true, guard: true }])
              expect(yield* migrate).toEqual([])
              expect(
                yield* sql`SELECT count(*)::int AS applied FROM actor_migrations WHERE migration_id = 24`,
              ).toEqual([{ applied: 1 }])
            }),
          )
        }),
      ),
  },
]
