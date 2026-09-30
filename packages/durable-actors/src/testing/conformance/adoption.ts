import { PGlite } from "@electric-sql/pglite"
import { customType, integer, pgTable, text, uuid } from "drizzle-orm/pg-core"
import { Cause, Clock, Crypto, Effect, Exit, Layer, Redacted, Schema, type Scope } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { Actor, type Actors } from "../../index.ts"
import type { InternalActors } from "../../runtime/actors.ts"
import { backfillAdoption } from "../../runtime/adoption/backfill.ts"
import { enforceAdoption, releaseAdoption } from "../../runtime/adoption/enforce.ts"
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

const runtimeOn = (
  target: Target,
  options: {
    readonly adoption?: { readonly role: string }
    readonly rowLevelSecurity?: { readonly role: string }
  } = {},
) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto

    return yield* Layer.build(
      Layer.fresh(
        live.pipe(
          Layer.provideMerge(
            ActorTest.layer({
              database: Redacted.isRedacted(target) ? target : { liveClient: target.liveClient },
              ...options,
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

const TENANT = "adopt-tenant"

const QUIET_MS = 7 * 86_400_000

interface Roles {
  readonly owner: string
  readonly writer: string
  readonly legacy: string
  readonly batch: string
}

/** The login a legacy application would use: `role`, with an application name of its own. */
const loginAs = <A, E>(
  target: Redacted.Redacted<string>,
  role: string,
  effect: Effect.Effect<A, E, SqlClient.SqlClient>,
) => {
  const url = new URL(Redacted.value(target))
  url.username = role
  url.password = "legacy"
  url.searchParams.set("application_name", "legacy-app")

  return onDatabase(Redacted.make(url.href), effect)
}

/**
 * The roles of a brownfield deployment: an owner no login can act as, a writer
 * the runtime takes, and two logins that write the table directly. The owner
 * takes the invoices table, and every role is dropped when the scope closes.
 */
const provisionRoles = (target: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const suffix = (yield* crypto.randomUUIDv4.pipe(Effect.orDie)).replaceAll("-", "").slice(0, 12)

    const roles: Roles = {
      owner: `adopt_owner_${suffix}`,
      writer: `adopt_writer_${suffix}`,
      legacy: `adopt_legacy_${suffix}`,
      batch: `adopt_batch_${suffix}`,
    }

    yield* onDatabase(
      target,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient

        for (const statement of [
          `CREATE ROLE ${roles.owner} NOLOGIN`,
          `CREATE ROLE ${roles.writer} NOLOGIN`,
          `CREATE ROLE ${roles.legacy} LOGIN PASSWORD 'legacy'`,
          `CREATE ROLE ${roles.batch} LOGIN PASSWORD 'legacy'`,
          `GRANT ${roles.writer} TO CURRENT_USER`,
          `GRANT USAGE ON SCHEMA public TO ${roles.writer}, ${roles.legacy}, ${roles.batch}`,
          `GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO ${roles.writer}`,
          `GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON conformance_invoices TO ${roles.legacy}`,
          `GRANT SELECT, INSERT, UPDATE, DELETE ON conformance_invoices TO ${roles.batch}`,
          `ALTER TABLE conformance_invoices OWNER TO ${roles.owner}`,
        ])
          yield* sql.unsafe(statement)
      }),
    )

    yield* Effect.addFinalizer(() =>
      onDatabase(
        target,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient

          for (const role of Object.values(roles)) {
            yield* sql.unsafe(`REASSIGN OWNED BY ${role} TO CURRENT_USER`)
            yield* sql.unsafe(`DROP OWNED BY ${role}`)
            yield* sql.unsafe(`DROP ROLE ${role}`)
          }
        }),
      ),
    )

    return roles
  })

/** A Postgres database with the roles and two legacy rows written by the legacy login while the table was observed. */
const observedWithRoles = (environment: ConformanceEnvironment) =>
  Effect.gen(function* () {
    const target = yield* prepared(environment, { observe: true })

    if (!Redacted.isRedacted(target))
      return yield* Effect.die(new Error("Enforcement cases need Postgres roles and logins"))

    const roles = yield* provisionRoles(target)

    yield* loginAs(
      target,
      roles.legacy,
      legacyInsert([
        { id: "inv-1", org: TENANT, account: "acct-a", amount: 10 },
        { id: "inv-2", org: TENANT, account: "acct-b", amount: 20 },
      ]),
    )

    return { target, roles }
  })

/** Backfills, clears what the legacy login wrote, ages the observation past the quiet window, and enforces. */
const enforceTable = (roles: Roles, allow: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    yield* backfillAdoption(adopting, { only: "conformance_invoices" })
    yield* adoptionWriters(adopting, { only: "conformance_invoices", clear: true })
    yield* sql`UPDATE actor_adoptions SET changed_at_ms = changed_at_ms - ${QUIET_MS + 86_400_000}`

    return yield* enforceAdoption(adopting, {
      only: "conformance_invoices",
      writerRole: roles.writer,
      allowedRoles: allow,
      quietMs: QUIET_MS,
      nowMs: yield* Clock.currentTimeMillis,
    })
  })

/** An enforced table, and a runtime whose turns take the writer role. */
const withEnforcement = <A, E>(
  environment: ConformanceEnvironment,
  options: { readonly allow?: ReadonlyArray<string> },
  body: (setup: {
    readonly target: Redacted.Redacted<string>
    readonly roles: Roles
  }) => Effect.Effect<
    A,
    E,
    Actors | InternalActors | ActorTest | SqlClient.SqlClient | Crypto.Crypto | Scope.Scope
  >,
) =>
  environment.run(
    Effect.gen(function* () {
      const { target, roles } = yield* observedWithRoles(environment)
      yield* onDatabase(target, enforceTable(roles, options.allow))

      const context = yield* runtimeOn(target, { adoption: { role: roles.writer } }).pipe(
        Effect.orDie,
      )

      return yield* body({ target, roles }).pipe(Effect.provideContext(context))
    }),
  )

/** What a statement did: `succeeded`, the SQL error class, or `other`, with the message the server gave. */
const outcome = <A>(effect: Effect.Effect<A, SqlError.SqlError, SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)

    if (Exit.isSuccess(exit)) return { reason: "succeeded", text: "" }

    const error = Cause.squash(exit.cause)

    return {
      reason: SqlError.isSqlError(error) ? error.reason._tag : "other",
      text: Cause.pretty(exit.cause),
    }
  })

const account = (id: string) => Account.get(id).pipe(Actor.tenant(TENANT))

/** Runs `effect` inside a transaction as `role`, the way a turn takes the writer role. */
const asRole = <A, E>(role: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return yield* Effect.andThen(sql`SELECT set_config('role', ${role}, true)`, effect).pipe(
      sql.withTransaction,
    )
  })

const invoiceIds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  return (yield* sql<{ id: string }>`SELECT id FROM conformance_invoices ORDER BY id`).map(
    ({ id }) => id,
  )
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
    name: "observing still records a legacy role's write that sets durable.backfill, while the runtime's own backfill stays unrecorded",
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

          yield* legacyInsert([{ id: "own", org: test.tenant, account: "acct-a" }])

          const url = new URL(Redacted.value(target))
          url.username = role
          url.password = "legacy"

          yield* onDatabase(
            Redacted.make(url.href),
            Effect.gen(function* () {
              const legacy = yield* SqlClient.SqlClient

              yield* Effect.gen(function* () {
                yield* legacy`SELECT set_config('durable.backfill', 'on', true)`
                yield* legacy`INSERT INTO conformance_invoices (id, org_id, account_id)
                  VALUES ('hidden', ${test.tenant}, 'acct-a')`
              }).pipe(legacy.withTransaction)
            }),
          )

          yield* backfillAdoption(adopting, { only: "conformance_invoices" })

          const writers = yield* adoptionWriters(adopting, { only: "conformance_invoices" })

          expect(
            writers
              .filter((writer) => writer.sessionUser === role)
              .map(({ operation, rows }) => [operation, rows]),
          ).toEqual([["INSERT", 1]])
          expect(writers.filter((writer) => writer.operation === "UPDATE")).toEqual([])
          expect(yield* sql`SELECT 1 FROM conformance_invoices WHERE routing_key IS NULL`).toEqual(
            [],
          )
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
  {
    name: "enforce refuses: unbackfilled rows, a legacy write inside the quiet window, a session_user seen both in and out of turns, an owner the legacy role can act as, and an incoming cascade",
    requiresIndependentConnections: true,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { target, roles } = yield* observedWithRoles(environment)

          yield* onDatabase(
            target,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient

              const refusal = (condition: string) =>
                Effect.gen(function* () {
                  const exit = yield* Effect.exit(
                    enforceAdoption(adopting, {
                      only: "conformance_invoices",
                      writerRole: roles.writer,
                      quietMs: QUIET_MS,
                      nowMs: yield* Clock.currentTimeMillis,
                    }),
                  )

                  if (Exit.isSuccess(exit))
                    return yield* Effect.die(new Error(`enforce passed despite ${condition}`))

                  const refused = Cause.squash(exit.cause)

                  expect(Schema.is(AdoptionRefused)(refused)).toBe(true)

                  return Schema.is(AdoptionRefused)(refused) ? refused.message : ""
                })

              const reset = Effect.gen(function* () {
                yield* backfillAdoption(adopting, { only: "conformance_invoices" })
                yield* adoptionWriters(adopting, { only: "conformance_invoices", clear: true })
                yield* sql`UPDATE actor_adoptions SET changed_at_ms = changed_at_ms - ${QUIET_MS + 86_400_000}`
              })

              const first = yield* refusal("unbackfilled rows")

              expect(first).toContain("2 rows of public.conformance_invoices have no routing_key")
              expect(first).toContain("less than the")
              expect(first).toContain(
                `${roles.legacy} (legacy-app) wrote public.conformance_invoices`,
              )
              expect(
                yield* sql`SELECT mode FROM actor_adoptions WHERE table_name = 'conformance_invoices'`,
              ).toEqual([{ mode: "observe" }])

              yield* reset

              yield* loginAs(
                target,
                roles.legacy,
                legacyInsert([{ id: "inv-3", org: TENANT, account: "acct-a" }]),
              )
              yield* backfillAdoption(adopting, { only: "conformance_invoices" })

              const second = yield* refusal("a legacy write inside the quiet window")

              expect(second).toContain(`${roles.legacy} (legacy-app) wrote`)
              expect(second).toContain("1 INSERT statements inside the quiet window")
              expect(second).not.toContain("no routing_key")

              yield* reset

              yield* loginAs(
                target,
                roles.batch,
                Effect.gen(function* () {
                  const batch = yield* SqlClient.SqlClient

                  yield* batch`SELECT set_config('durable.turn', 'on', false)`
                  yield* batch`INSERT INTO conformance_invoices (id, org_id, account_id) VALUES ('inv-4', ${TENANT}, 'acct-a')`
                  yield* batch`SELECT set_config('durable.turn', 'off', false)`
                  yield* batch`INSERT INTO conformance_invoices (id, org_id, account_id) VALUES ('inv-5', ${TENANT}, 'acct-a')`
                }),
              )
              yield* backfillAdoption(adopting, { only: "conformance_invoices" })
              yield* sql`UPDATE actor_adoption_writes SET observed_at_ms = observed_at_ms - ${QUIET_MS + 86_400_000}`

              expect(yield* refusal("a login that wrote in and out of turns")).toContain(
                `${roles.batch} wrote public.conformance_invoices both inside and outside runtime turns`,
              )

              yield* reset
              yield* sql.unsafe(`ALTER TABLE conformance_invoices OWNER TO ${roles.legacy}`)

              expect(yield* refusal("an owner a login can act as")).toContain(
                `login ${roles.legacy} can act as public.conformance_invoices's owner ${roles.legacy}`,
              )

              yield* sql.unsafe(`ALTER TABLE conformance_invoices OWNER TO ${roles.owner}`)
              yield* sql`CREATE TABLE conformance_parents (id text PRIMARY KEY)`
              yield* sql`INSERT INTO conformance_parents SELECT id FROM conformance_invoices`
              yield* sql`ALTER TABLE conformance_invoices ADD CONSTRAINT conformance_invoices_parent
                FOREIGN KEY (id) REFERENCES conformance_parents (id) ON DELETE CASCADE`

              expect(yield* refusal("an incoming cascade")).toContain(
                "foreign key conformance_invoices_parent of public.conformance_invoices references conformance_parents with ON DELETE CASCADE",
              )

              yield* sql`ALTER TABLE conformance_invoices DROP CONSTRAINT conformance_invoices_parent`
              yield* sql`DROP TABLE conformance_parents`
              yield* sql`UPDATE actor_adoption_writes SET observed_at_ms = observed_at_ms - ${QUIET_MS + 86_400_000}`
              yield* sql`DELETE FROM actor_adoption_writes`

              const [enforced] = yield* enforceAdoption(adopting, {
                only: "conformance_invoices",
                writerRole: roles.writer,
                quietMs: QUIET_MS,
                nowMs: yield* Clock.currentTimeMillis,
              })

              expect(enforced).toMatchObject({
                table: "public.conformance_invoices",
                writerRole: roles.writer,
                allowedRoles: [],
              })
              expect(
                yield* sql`SELECT mode, writer_role FROM actor_adoptions WHERE table_name = 'conformance_invoices'`,
              ).toEqual([{ mode: "enforce", writer_role: roles.writer }])
            }),
          )
        }),
      ),
  },
  {
    name: "enforced: a second pool, raw SQL, COPY, an updatable view, a SECURITY INVOKER function, a cascade, and TRUNCATE are rejected with 42501, and a mixed statement changes no row (A4)",
    requiresIndependentConnections: true,
    run: ({ expect, environment }) =>
      withEnforcement(environment, {}, ({ target, roles }) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const a = yield* account("acct-a")
          const b = yield* account("acct-b")

          yield* a.Add({ id: "inv-3", amount: 30 })
          yield* b.Put([{ id: "inv-2", amount: 21 }])
          expect((yield* a.Lines()).map(({ id }) => id)).toEqual(["inv-1", "inv-3"])
          expect((yield* b.Lines()).map(({ amount }) => amount)).toEqual([21])

          const before = yield* sql<{ id: string; amount: number }>`
            SELECT id, amount FROM conformance_invoices ORDER BY id`

          const rejected = (result: { readonly reason: string; readonly text: string }) => {
            expect(result.reason).toBe("AuthorizationError")

            return result.text
          }

          yield* onDatabase(
            target,
            Effect.gen(function* () {
              const owner = yield* SqlClient.SqlClient

              yield* owner.unsafe(
                `CREATE VIEW conformance_invoice_view AS SELECT * FROM conformance_invoices`,
              )
              yield* owner.unsafe(`GRANT ALL ON conformance_invoice_view TO ${roles.legacy}`)
              yield* owner.unsafe(
                `CREATE FUNCTION conformance_invoice_write() RETURNS void LANGUAGE sql SECURITY INVOKER AS $$
                   INSERT INTO conformance_invoices (id, org_id, account_id, routing_key) VALUES ('fn', 't', 'a', 1) $$`,
              )
              yield* owner.unsafe(
                `GRANT EXECUTE ON FUNCTION conformance_invoice_write() TO ${roles.legacy}`,
              )
              yield* owner.unsafe(`CREATE TABLE conformance_parents (id text PRIMARY KEY)`)
              yield* owner.unsafe(
                `INSERT INTO conformance_parents SELECT id FROM conformance_invoices`,
              )
              yield* owner.unsafe(
                `ALTER TABLE conformance_invoices ADD CONSTRAINT conformance_invoices_parent
                 FOREIGN KEY (id) REFERENCES conformance_parents (id) ON DELETE CASCADE`,
              )
            }),
          )

          yield* loginAs(
            target,
            roles.legacy,
            Effect.gen(function* () {
              const legacy = yield* SqlClient.SqlClient

              for (const [statement, message] of [
                [
                  `INSERT INTO conformance_invoices (id, org_id, account_id, routing_key) VALUES ('raw', 't', 'a', 1)`,
                  "permission denied",
                ],
                [`UPDATE conformance_invoices SET amount = 0`, "permission denied"],
                [`DELETE FROM conformance_invoices`, "permission denied"],
                [`TRUNCATE conformance_invoices`, "permission denied"],
                [
                  `INSERT INTO conformance_invoice_view (id, org_id, account_id, routing_key) VALUES ('view', 't', 'a', 1)`,
                  "belongs to actor Account",
                ],
                [`SELECT conformance_invoice_write()`, "permission denied"],
              ] as const)
                expect(rejected(yield* outcome(legacy.unsafe(statement)))).toContain(message)
            }),
          )

          expect(
            rejected(
              yield* outcome(
                sql`INSERT INTO conformance_invoices (id, org_id, account_id, routing_key) VALUES ('raw', ${TENANT}, 'acct-a', 1)`,
              ),
            ),
          ).toContain("public.conformance_invoices belongs to actor Account")

          expect(
            rejected(yield* outcome(sql`UPDATE conformance_invoices SET amount = 0`)),
          ).toContain("belongs to actor Account")

          expect(
            rejected(
              yield* outcome(
                sql`INSERT INTO conformance_invoices (id, org_id, account_id, routing_key) VALUES
                  ('mix-own', ${TENANT}, 'acct-a', 1), ('mix-other', ${TENANT}, 'acct-b', 1)`,
              ),
            ),
          ).toContain("belongs to actor Account")

          expect(
            rejected(
              yield* outcome(
                sql`COPY conformance_invoices (id, org_id, account_id, routing_key) FROM PROGRAM 'printf "copied\tt\ta\t1\n"'`,
              ),
            ),
          ).toContain("belongs to actor Account")

          expect(
            rejected(yield* outcome(asRole(roles.writer, sql`TRUNCATE conformance_invoices`))),
          ).toContain("belongs to actor Account")

          expect(
            rejected(yield* outcome(sql`DELETE FROM conformance_parents WHERE id = 'inv-1'`)),
          ).toContain("permission denied")

          expect(
            yield* sql<{
              id: string
              amount: number
            }>`SELECT id, amount FROM conformance_invoices ORDER BY id`,
          ).toEqual(before)
        }),
      ),
  },
  {
    name: "enforced: the table owner's write is rejected by the guard when privileges are granted back",
    requiresIndependentConnections: true,
    run: ({ expect, environment }) =>
      withEnforcement(environment, {}, ({ target, roles }) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient

          yield* onDatabase(
            target,
            SqlClient.SqlClient.pipe(
              Effect.flatMap((admin) =>
                admin.unsafe(
                  `GRANT INSERT, UPDATE, DELETE ON conformance_invoices TO ${roles.owner}, ${roles.legacy}`,
                ),
              ),
            ),
          )

          const insert = sql`INSERT INTO conformance_invoices (id, org_id, account_id, routing_key)
            VALUES ('granted', ${TENANT}, 'acct-a', 1)`

          for (const role of [roles.owner]) {
            const result = yield* outcome(asRole(role, insert))

            expect(result.reason).toBe("AuthorizationError")
            expect(result.text).toContain("belongs to actor Account")
          }

          const legacy = yield* loginAs(
            target,
            roles.legacy,
            outcome(
              Effect.flatMap(
                SqlClient.SqlClient,
                (session) => session`INSERT INTO conformance_invoices
                (id, org_id, account_id, routing_key) VALUES ('granted', ${TENANT}, 'acct-a', 1)`,
              ),
            ),
          )

          expect(legacy.reason).toBe("AuthorizationError")
          expect(legacy.text).toContain("belongs to actor Account")
          expect(yield* invoiceIds).toEqual(["inv-1", "inv-2"])
        }),
      ),
  },
  {
    name: "an --allow role's write passes, is recorded as allowed, and still needs routing_key",
    requiresIndependentConnections: true,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { target, roles } = yield* observedWithRoles(environment)
          yield* onDatabase(target, enforceTable(roles, [roles.batch]))

          const context = yield* runtimeOn(target, { adoption: { role: roles.writer } }).pipe(
            Effect.orDie,
          )

          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient

            const insert = (id: string, key: string) =>
              loginAs(
                target,
                roles.batch,
                outcome(
                  Effect.flatMap(SqlClient.SqlClient, (session) =>
                    session.unsafe(
                      `INSERT INTO conformance_invoices (id, org_id, account_id, routing_key) VALUES ('${id}', '${TENANT}', 'acct-a', ${key})`,
                    ),
                  ),
                ),
              )

            expect((yield* insert("batch-1", "7")).reason).toBe("succeeded")

            const missing = yield* insert("batch-2", "NULL")

            expect(missing.reason).toBe("ConstraintError")
            expect(missing.text).toContain("needs routing_key")
            expect(yield* invoiceIds).toEqual(["batch-1", "inv-1", "inv-2"])

            const writers = yield* adoptionWriters(adopting, { only: "conformance_invoices" })

            expect(
              writers.map(({ sessionUser, operation, allowed, inTurn, statements }) => ({
                sessionUser,
                operation,
                allowed,
                inTurn,
                statements,
              })),
            ).toEqual([
              {
                sessionUser: roles.batch,
                operation: "INSERT",
                allowed: true,
                inTurn: false,
                statements: 1,
              },
            ])
            expect(
              yield* sql`SELECT allowed_roles FROM actor_adoptions WHERE table_name = 'conformance_invoices'`,
            ).toEqual([{ allowed_roles: [roles.batch] }])
          }).pipe(Effect.provideContext(context))
        }),
      ),
  },
  {
    name: "changing either mapped column of a row is rejected for every role",
    requiresIndependentConnections: true,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { target, roles } = yield* observedWithRoles(environment)
          yield* onDatabase(target, enforceTable(roles, [roles.batch]))

          const context = yield* runtimeOn(target, { adoption: { role: roles.writer } }).pipe(
            Effect.orDie,
          )

          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient

            for (const column of ["org_id", "account_id"]) {
              const move = sql.unsafe(
                `UPDATE conformance_invoices SET ${column} = 'elsewhere' WHERE id = 'inv-1'`,
              )

              for (const result of [
                yield* outcome(asRole(roles.writer, move)),
                yield* outcome(move),
                yield* loginAs(target, roles.batch, outcome(move)),
              ]) {
                expect(result.reason).toBe("AuthorizationError")
                expect(result.text).toContain("cannot move to another tenant or actor")
              }
            }

            expect(yield* invoiceRow("inv-1")).toMatchObject([
              { org_id: TENANT, account_id: "acct-a" },
            ])
          }).pipe(Effect.provideContext(context))
        }),
      ),
  },
  {
    name: "startup refuses an enforced table whose trigger is disabled, whose privileges were granted back, or whose mapping changed",
    requiresIndependentConnections: true,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { target, roles } = yield* observedWithRoles(environment)
          yield* onDatabase(target, enforceTable(roles))

          const start = (options: { readonly adoption?: { readonly role: string } }) =>
            runtimeOn(target, options).pipe(
              Effect.scoped,
              Effect.exit,
              Effect.map((exit) => defect(exit)),
            )

          const admin = (statement: string) =>
            onDatabase(
              target,
              Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement)),
            )

          expect(yield* start({})).toContain(
            `is enforced for writer role ${roles.writer}; start the runtime with adoption: { role: "${roles.writer}" }`,
          )
          expect(yield* start({ adoption: { role: roles.legacy } })).toContain(
            `is enforced for writer role ${roles.writer}, but the runtime takes ${roles.legacy}`,
          )

          yield* admin(`ALTER TABLE conformance_invoices DISABLE TRIGGER actor_adoption_guard`)
          expect(yield* start({ adoption: { role: roles.writer } })).toContain(
            "guard trigger actor_adoption_guard is not enabled always",
          )
          yield* admin(
            `ALTER TABLE conformance_invoices ENABLE ALWAYS TRIGGER actor_adoption_guard`,
          )

          yield* admin(`GRANT INSERT ON conformance_invoices TO ${roles.legacy}`)
          expect(yield* start({ adoption: { role: roles.writer } })).toContain(
            `${roles.legacy} hold write privileges again`,
          )
          yield* admin(`REVOKE INSERT ON conformance_invoices FROM ${roles.legacy}`)

          yield* admin(
            `UPDATE actor_adoptions SET actor_column = 'org_id', tenant_column = 'account_id' WHERE table_name = 'conformance_invoices'`,
          )
          expect(yield* start({ adoption: { role: roles.writer } })).toContain(
            "was adopted with columns (account_id, org_id) but declares (org_id, account_id)",
          )
          yield* admin(
            `UPDATE actor_adoptions SET actor_column = 'account_id', tenant_column = 'org_id' WHERE table_name = 'conformance_invoices'`,
          )

          yield* admin(`DROP TRIGGER actor_adoption_guard_truncate ON conformance_invoices`)
          expect(yield* start({ adoption: { role: roles.writer } })).toContain(
            "guard trigger actor_adoption_guard_truncate is missing",
          )
        }),
      ),
  },
  {
    name: "release returns an enforced table to observing: the guard is gone, privileges are back, and legacy writes are recorded again",
    requiresIndependentConnections: true,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { target, roles } = yield* observedWithRoles(environment)

          yield* onDatabase(
            target,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient

              expect(
                (yield* releaseAdoption(adopting, { only: "conformance_invoices" }).pipe(
                  Effect.flip,
                )).message,
              ).toBe("public.conformance_invoices is not enforced")

              yield* enforceTable(roles)

              expect(yield* releaseAdoption(adopting, { only: "conformance_invoices" })).toEqual([
                "public.conformance_invoices",
              ])
              expect(
                yield* sql`SELECT mode, writer_role, revoked FROM actor_adoptions WHERE table_name = 'conformance_invoices'`,
              ).toEqual([{ mode: "observe", writer_role: null, revoked: [] }])
              expect(
                yield* sql`SELECT tgname FROM pg_trigger WHERE tgrelid = 'conformance_invoices'::regclass
                  AND NOT tgisinternal ORDER BY tgname`,
              ).toEqual([
                { tgname: "actor_adoption_observe_delete" },
                { tgname: "actor_adoption_observe_insert" },
                { tgname: "actor_adoption_observe_truncate" },
                { tgname: "actor_adoption_observe_update" },
              ])
            }),
          )

          const written = yield* loginAs(
            target,
            roles.legacy,
            outcome(
              Effect.flatMap(
                SqlClient.SqlClient,
                (legacy) =>
                  legacy`INSERT INTO conformance_invoices (id, org_id, account_id) VALUES ('after', ${TENANT}, 'acct-a')`,
              ),
            ),
          )

          expect(written.reason).toBe("succeeded")

          const writers = yield* onDatabase(
            target,
            adoptionWriters(adopting, { only: "conformance_invoices" }),
          )

          expect(
            writers.map(({ sessionUser, operation }) => `${sessionUser} ${operation}`),
          ).toContain(`${roles.legacy} INSERT`)
        }),
      ),
  },
  {
    name: "refuses adoption.role and rowLevelSecurity.role when they name different roles",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const target = yield* prepared(environment, { observe: true })

          const exit = yield* runtimeOn(target, {
            adoption: { role: "one" },
            rowLevelSecurity: { role: "another" },
          }).pipe(Effect.scoped, Effect.exit)

          expect(defect(exit)).toContain("must name the same role: a turn takes one role")
        }),
      ),
  },
]
