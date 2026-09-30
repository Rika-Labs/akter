import { connect, createServer, type AddressInfo, type Socket } from "node:net"
import { bigint, boolean, pgTable, text } from "drizzle-orm/pg-core"
import {
  Cause,
  Equal,
  Crypto,
  Option,
  Stream,
  Effect,
  Exit,
  Fiber,
  Layer,
  Redacted,
  Schedule,
  Schema,
  type Scope,
} from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor, Fleet, User } from "../../index.ts"
import type { AnyFleetView } from "../../tables/fleet.ts"
import { Database } from "../../runtime/layer.ts"
import { checkFleet } from "../../runtime/fleet/checks.ts"
import { rebuildFleetView, setupFleet } from "../../runtime/fleet/setup.ts"
import { FLEET_SLOT, LOCK_RETRY } from "../../runtime/fleet/maintainer.ts"
import { tenantRoutingKey } from "../../runtime/storage/codec.ts"
import { backfillAdoption } from "../../runtime/adoption/backfill.ts"
import { observeAdoption } from "../../runtime/adoption/observe.ts"
import { migrate } from "../../runtime/database/migrations.ts"
import { TurnPoolSettings } from "../../runtime/turn/pipeline.ts"
import { ActorTest } from "../actor-test.ts"
import { ActorCluster } from "../cluster.ts"
import type { ConformanceCase, ConformanceEnvironment, ConformanceExpect } from "../conformance.ts"

/** The source table every fleet case reads. */
export const fleetOrders = Actor.table(
  pgTable("fleet_orders", {
    id: text("id").primaryKey(),
    status: text("status").notNull(),
    region: text("region").notNull(),
    amountCents: bigint("amount_cents", { mode: "bigint" }).notNull(),
    archived: boolean("archived").notNull(),
  }),
)

const legacyInvoices = pgTable("fleet_legacy_invoices", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  accountId: text("account_id").notNull(),
  status: text("status").notNull(),
  amount: bigint("amount", { mode: "bigint" }).notNull(),
})

const invoiceRows = Actor.table(legacyInvoices, {
  owner: { tenant: legacyInvoices.orgId, actor: legacyInvoices.accountId },
})

const LegacyAccount = Actor.make("FleetLegacyAccount", {
  key: Schema.String,
  tables: [invoiceRows],
  api: {},
})

/** Invoices of an adopted table, by status. */
const InvoicesByStatus = Fleet.view("InvoicesByStatus", {
  from: invoiceRows,
  groupBy: ["status"],
  select: { invoices: Fleet.count(), total: Fleet.sum("amount") },
})

const spread = Actor.table(
  pgTable("fleet_spread", { id: text("id").primaryKey(), kind: text("kind").notNull() }),
)

/** Orders not archived, by status, with every aggregate kind. */
export const OrdersByStatus = Fleet.view("OrdersByStatus", {
  from: fleetOrders,
  where: { archived: false },
  groupBy: ["status"],
  select: {
    orders: Fleet.count(),
    total: Fleet.sum("amountCents"),
    low: Fleet.min("amountCents"),
    high: Fleet.max("amountCents"),
    mean: Fleet.avg("amountCents"),
  },
})

/** Every order, archived or not, by region and status. */
export const OrdersByRegion = Fleet.view("OrdersByRegion", {
  from: fleetOrders,
  groupBy: ["region", "status"],
  select: { orders: Fleet.count(), total: Fleet.sum("amountCents") },
})

/** The views an entry module exports for `durable fleet setup`. */
export const fleet = [OrdersByStatus, OrdersByRegion]

/** `OrdersByStatus` with its filter dropped: the same table, another definition. */
const OrdersByStatusAll = Fleet.view("OrdersByStatus", {
  from: fleetOrders,
  groupBy: ["status"],
  select: {
    orders: Fleet.count(),
    total: Fleet.sum("amountCents"),
    low: Fleet.min("amountCents"),
    high: Fleet.max("amountCents"),
    mean: Fleet.avg("amountCents"),
  },
})

const SpreadByKind = Fleet.view("SpreadByKind", {
  from: spread,
  groupBy: ["kind"],
  select: { rows: Fleet.count() },
})

const Order = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  region: Schema.String,
  amountCents: Schema.BigInt,
  archived: Schema.Boolean,
})

type Order = typeof Order.Type

class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}

const Put = Actor.command("Put", { input: Order })

const Remove = Actor.command("Remove", { input: Schema.String })

const PutThenRefuse = Actor.command("PutThenRefuse", { input: Order, errors: [Refused] })

/** A tenant-placed actor owning `fleet_orders`. */
const FleetOrder = Actor.make("FleetOrder", {
  key: Schema.String,
  tables: [fleetOrders],
  api: { Put, Remove, PutThenRefuse },
})

Actor.make("FleetSpread", { key: Schema.String, placement: "actor", tables: [spread], api: {} })

const put = (order: Order) =>
  Effect.gen(function* () {
    yield* (yield* FleetOrder.Turn).rows(fleetOrders).upsert(order)
  })

/** The command layer of `FleetOrder`. */
export const FleetOrderLive = FleetOrder.toLayer(
  Effect.succeed({
    Put: put,
    Remove: (id: string) =>
      Effect.gen(function* () {
        yield* (yield* FleetOrder.Turn).rows(fleetOrders).delete().where({ id })
      }),
    PutThenRefuse: (order: Order) => put(order).pipe(Effect.andThen(Refused.make({}))),
  }),
)

/** What drizzle-kit generates for `fleet_orders` and both derived tables, then the recompute indexes. */
const fleetDdl = [
  `CREATE TABLE "fleet_orders" (
	"routing_key" bigint,
	"tenant_id" text,
	"actor_id" text,
	"id" text,
	"status" text NOT NULL,
	"region" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"archived" boolean NOT NULL,
	CONSTRAINT "fleet_orders_pkey" PRIMARY KEY("routing_key","tenant_id","actor_id","id")
);
`,
  `ALTER TABLE "fleet_orders" ENABLE ROW LEVEL SECURITY;`,
  `CREATE TABLE "fleet_orders_by_status" (
	"tenant_id" text,
	"status" text,
	"orders" bigint NOT NULL,
	"total" bigint NOT NULL,
	"low" bigint,
	"high" bigint,
	"mean" double precision NOT NULL,
	"as_of" numeric NOT NULL,
	CONSTRAINT "fleet_orders_by_status_pkey" PRIMARY KEY("tenant_id","status")
);
`,
  `ALTER TABLE "fleet_orders_by_status" ENABLE ROW LEVEL SECURITY;`,
  `CREATE TABLE "fleet_orders_by_region" (
	"tenant_id" text,
	"region" text,
	"status" text,
	"orders" bigint NOT NULL,
	"total" bigint NOT NULL,
	"as_of" numeric NOT NULL,
	CONSTRAINT "fleet_orders_by_region_pkey" PRIMARY KEY("tenant_id","region","status")
);
`,
  `ALTER TABLE "fleet_orders_by_region" ENABLE ROW LEVEL SECURITY;`,
  `CREATE POLICY "durable_tenant" ON "fleet_orders" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('durable.tenant', true)) WITH CHECK (tenant_id = current_setting('durable.tenant', true));`,
  `CREATE POLICY "durable_tenant" ON "fleet_orders_by_status" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('durable.tenant', true)) WITH CHECK (tenant_id = current_setting('durable.tenant', true));`,
  `CREATE POLICY "durable_tenant" ON "fleet_orders_by_region" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('durable.tenant', true)) WITH CHECK (tenant_id = current_setting('durable.tenant', true));`,
  `CREATE INDEX fleet_orders_by_status_recompute ON fleet_orders (routing_key, tenant_id, status)`,
  `CREATE INDEX fleet_orders_by_region_recompute ON fleet_orders (routing_key, tenant_id, region, status)`,
]

/** Orders by tenant, then id: what a case wrote, so expected views are computed from it, not read back. */
type Model = Map<string, Map<string, Order>>

const record = (model: Model, tenant: string, written: Order) => {
  const orders = model.get(tenant) ?? new Map<string, Order>()
  orders.set(written.id, written)
  model.set(tenant, orders)
}

const forget = (model: Model, tenant: string, id: string) => {
  model.get(tenant)?.delete(id)
}

/** A derived row as the cases compare it: text, integers, and floats. */
type Row = Readonly<Record<string, string | number | null>>

const byValues = (a: Row, b: Row) =>
  JSON.stringify(Object.values(a)) < JSON.stringify(Object.values(b)) ? -1 : 1

const groupRows = (
  model: Model,
  admit: (row: Order) => boolean,
  keyOf: (row: Order) => ReadonlyArray<string>,
  project: (key: ReadonlyArray<string>, orders: ReadonlyArray<Order>) => Row,
) =>
  [...model.entries()]
    .flatMap(([tenant, orders]) => {
      const groups = new Map<string, Array<Order>>()

      for (const row of orders.values())
        if (admit(row)) {
          const key = JSON.stringify([tenant, ...keyOf(row)])
          groups.set(key, [...(groups.get(key) ?? []), row])
        }

      return [...groups.entries()].map(([key, members]) =>
        project(JSON.parse(key) as ReadonlyArray<string>, members),
      )
    })
    .sort(byValues)

/** `OrdersByStatus` recomputed from the model; `archivedToo` drops its filter. */
const expectedByStatus = (model: Model, archivedToo = false) =>
  groupRows(
    model,
    (row) => archivedToo || !row.archived,
    (row) => [row.status],
    ([tenant = "", status = ""], orders) => {
      const amounts = orders.map((row) => row.amountCents)
      const total = amounts.reduce((sum, amount) => sum + amount, 0n)

      return {
        tenant_id: tenant,
        status,
        orders: orders.length,
        total: String(total),
        low: String(amounts.reduce((low, amount) => (amount < low ? amount : low))),
        high: String(amounts.reduce((high, amount) => (amount > high ? amount : high))),
        mean: Number(total) / orders.length,
      }
    },
  )

/** `OrdersByRegion` recomputed from the model. */
const expectedByRegion = (model: Model) =>
  groupRows(
    model,
    () => true,
    (row) => [row.region, row.status],
    ([tenant = "", region = "", status = ""], orders) => ({
      tenant_id: tenant,
      region,
      status,
      orders: orders.length,
      total: String(orders.reduce((sum, row) => sum + row.amountCents, 0n)),
    }),
  )

/** The derived rows of `OrdersByStatus`, in the order `expectedByStatus` sorts. */
const byStatusRows = (sql: SqlClient.SqlClient) =>
  sql<Row>`SELECT tenant_id, status, orders::int AS orders, total::text AS total,
      low::text AS low, high::text AS high, mean
    FROM fleet_orders_by_status`.pipe(Effect.map((rows) => [...rows].sort(byValues)))

/** The derived rows of `OrdersByRegion`, in the order `expectedByRegion` sorts. */
const byRegionRows = (sql: SqlClient.SqlClient) =>
  sql<Row>`SELECT tenant_id, region, status, orders::int AS orders, total::text AS total
    FROM fleet_orders_by_region`.pipe(Effect.map((rows) => [...rows].sort(byValues)))

/** Waits until `read` returns `expected`, then asserts it, so a timeout still shows the difference. */
const settle = <A, E>(
  expect: ConformanceExpect,
  read: Effect.Effect<A, E>,
  expected: A,
  duration: `${number} seconds` = "20 seconds",
) =>
  Effect.gen(function* () {
    const last = yield* read.pipe(
      Effect.orDie,
      Effect.repeat({
        schedule: Schedule.spaced("50 millis"),
        until: (value) => Equal.equals(value, expected),
      }),
      Effect.timeoutOption(duration),
    )

    expect(Option.isSome(last) ? last.value : yield* Effect.orDie(read)).toEqual(expected)
  })

interface ViewState {
  readonly view_name: string
  readonly status: string
  readonly applied_lsn: string | null
  readonly last_error: string | null
}

const viewStates = (sql: SqlClient.SqlClient) =>
  sql<ViewState>`SELECT view_name, status, applied_lsn::text AS applied_lsn, last_error
    FROM actor_fleet_views ORDER BY view_name`.pipe(Effect.orDie)

/** Drops the slot, retrying while a peek holds it, so the database can be dropped. */
const dropSlot = (sql: SqlClient.SqlClient) =>
  sql`SELECT count(*)::int AS dropped FROM (SELECT pg_drop_replication_slot(slot_name)
    FROM pg_replication_slots WHERE slot_name = ${FLEET_SLOT} AND database = current_database()) d`.pipe(
    Effect.retry({ times: 200, schedule: Schedule.spaced("50 millis") }),
    Effect.orDie,
  )

/**
 * A fresh database with the fleet tables and their indexes, set up with
 * `durable fleet setup` unless `setup` is false, and an administrative client
 * to it. The slot is dropped when the scope closes, before the backend drops
 * the database, which a logical slot would block.
 */
const fleetDatabase = (
  environment: ConformanceEnvironment,
  options: { readonly setup?: boolean } = {},
) =>
  Effect.gen(function* () {
    const database = yield* environment.freshDatabase

    if (!Redacted.isRedacted(database))
      return yield* Effect.die(new Error("Fleet cases need a Postgres database"))

    const context = yield* Layer.build(Database.postgres({ url: database, maxConnections: 2 }))
    const admin = SqlClient.SqlClient.pipe(Effect.provideContext(context), Effect.runSync)

    for (const statement of fleetDdl) yield* admin.unsafe(statement).pipe(Effect.orDie)

    yield* Effect.addFinalizer(() => dropSlot(admin))

    if (options.setup !== false)
      yield* setupFleet([OrdersByStatus, OrdersByRegion]).pipe(
        Effect.provideService(SqlClient.SqlClient, admin),
        Effect.orDie,
      )

    return { database, admin }
  })

/** Runs `body` on a cluster of `runners` maintaining `views` over a fleet database. */
const withFleet = <A, E>(
  environment: ConformanceEnvironment,
  options: { readonly runners?: number; readonly views?: ReadonlyArray<AnyFleetView> },
  body: (admin: SqlClient.SqlClient) => Effect.Effect<A, E, ActorCluster | Scope.Scope>,
) =>
  environment.run(
    Effect.gen(function* () {
      const { database, admin } = yield* fleetDatabase(environment)

      const context = yield* Layer.build(
        ActorTest.cluster({
          database,
          runners: options.runners ?? 1,
          shardLockExpiration: "3 seconds",
          actors: FleetOrderLive,
          as: User.make({ subject: "alice" }),
          fleet: options.views ?? [OrdersByStatus, OrdersByRegion],
        }),
      )

      return yield* body(admin).pipe(Effect.provideContext(context))
    }),
  )

type OrderHandle = Effect.Success<ReturnType<typeof FleetOrder.get>>

const call = <A, E>(
  runner: number,
  tenant: string | undefined,
  id: string,
  use: (handle: OrderHandle) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const cluster = yield* ActorCluster
    const handle = FleetOrder.get(id).pipe(Effect.flatMap(use))

    return yield* cluster.on(runner)(tenant === undefined ? handle : Actor.tenant(tenant)(handle))
  })

/** Puts `row` through a turn of `tenant` (the cluster's own when undefined) and records it. */
const place = (model: Model, row: Order, tenant?: string, runner = 0) =>
  Effect.gen(function* () {
    const cluster = yield* ActorCluster
    yield* call(runner, tenant, row.id, (handle) => handle.Put(row)).pipe(Effect.orDie)
    record(model, tenant ?? cluster.tenant, row)
  })

const remove = (model: Model, id: string, tenant?: string) =>
  Effect.gen(function* () {
    const cluster = yield* ActorCluster
    yield* call(0, tenant, id, (handle) => handle.Remove(id)).pipe(Effect.orDie)
    forget(model, tenant ?? cluster.tenant, id)
  })

const order = (
  id: string,
  status: string,
  amount: number | bigint,
  extra: Partial<Order> = {},
): Order => ({
  id,
  status,
  region: "eu",
  amountCents: BigInt(amount),
  archived: false,
  ...extra,
})

const settleBoth = (expect: ConformanceExpect, admin: SqlClient.SqlClient, model: Model) =>
  Effect.gen(function* () {
    yield* settle(expect, byStatusRows(admin), expectedByStatus(model))
    yield* settle(expect, byRegionRows(admin), expectedByRegion(model))
  })

const readyViews = (
  expect: ConformanceExpect,
  admin: SqlClient.SqlClient,
  names: ReadonlyArray<string>,
) =>
  settle(
    expect,
    viewStates(admin).pipe(
      Effect.map((rows) => rows.map(({ view_name, status }) => ({ view_name, status }))),
    ),
    names.map((view_name) => ({ view_name, status: "ready" })),
  )

/** The number of sessions holding the fleet maintainer lock on this database. */
const lockHolders = (admin: SqlClient.SqlClient) =>
  admin<{ holders: number }>`
    WITH k AS (SELECT hashtext('durable-actors/fleet')::bigint AS key)
    SELECT count(*)::int AS holders FROM pg_locks, k
    WHERE locktype = 'advisory' AND granted AND objsubid = 1
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND classid = ((key >> 32) & 4294967295)::text::oid
      AND objid = (key & 4294967295)::text::oid`.pipe(
    Effect.map((rows) => rows[0]!.holders),
    Effect.orDie,
  )

/** Writes `row` with plain SQL, as a writer outside any turn would, and records it. */
const write = (admin: SqlClient.SqlClient, model: Model, tenant: string, row: Order) =>
  admin`INSERT INTO fleet_orders (routing_key, tenant_id, actor_id, id, status, region, amount_cents, archived)
    VALUES (${String(tenantRoutingKey(tenant))}::bigint, ${tenant}, ${row.id}, ${row.id}, ${row.status},
      ${row.region}, ${String(row.amountCents)}::bigint, ${row.archived})
    ON CONFLICT (routing_key, tenant_id, actor_id, id) DO UPDATE SET status = EXCLUDED.status,
      region = EXCLUDED.region, amount_cents = EXCLUDED.amount_cents, archived = EXCLUDED.archived`.pipe(
    Effect.orDie,
    Effect.tap(() => Effect.sync(() => record(model, tenant, row))),
  )

/** Starts the maintainer fixture in its own process; the scope SIGKILLs it if it still runs. */
const maintainerProcess = (database: Redacted.Redacted<string>, crash: boolean) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      Bun.spawn(["bun", new URL("./crash/fleet/maintainer.ts", import.meta.url).pathname], {
        env: {
          ...process.env,
          FLEET_DATABASE_URL: Redacted.value(database),
          FLEET_CRASH: crash ? "afterApply" : "none",
        },
        stdout: "pipe",
        stderr: "inherit",
      }),
    ),
    (child) => Effect.sync(() => child.kill("SIGKILL")),
  )

/** Resolves once `child` prints `line`, or dies when it exits first. */
const printed = (child: Bun.Subprocess<"ignore", "pipe", "inherit">, line: string) =>
  Stream.fromReadableStream({ evaluate: () => child.stdout, onError: () => "unreadable" }).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((printedLine) => printedLine === line),
    Stream.take(1),
    Stream.runCollect,
    Effect.map((lines) => lines.length === 1),
    Effect.orElseSucceed(() => false),
    Effect.timeoutOption("30 seconds"),
    Effect.flatMap((found) =>
      Option.isSome(found) && found.value
        ? Effect.void
        : Effect.die(new Error(`The maintainer process never printed ${line}`)),
    ),
  )

const slotPosition = (admin: SqlClient.SqlClient) =>
  admin<{ confirmed: string }>`SELECT (confirmed_flush_lsn - '0/0')::text AS confirmed
    FROM pg_replication_slots WHERE slot_name = ${FLEET_SLOT} AND database = current_database()`.pipe(
    Effect.map((rows) => rows[0]!.confirmed),
    Effect.orDie,
  )

/**
 * A TCP relay in front of Postgres for the turn pool that counts the
 * statements clients send: each Bind of the extended protocol and each simple
 * Query, read from the frontend message framing.
 */
const statementRelay = (url: URL) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly port: number
      readonly statements: () => number
      readonly close: () => void
    }>((resume) => {
      const sockets = new Set<Socket>()
      let statements = 0

      const server = createServer((client) => {
        const upstream = connect({ host: url.hostname, port: Number(url.port || 5432) })
        let pending = Buffer.alloc(0)
        let started = false

        sockets.add(client)
        sockets.add(upstream)
        client.on("data", (chunk: Buffer) => {
          upstream.write(chunk)
          pending = Buffer.concat([pending, chunk])

          for (;;) {
            if (!started) {
              if (pending.length < 8) break
              const length = pending.readInt32BE(0)

              if (pending.length < length) break
              started = pending.readInt32BE(4) !== 80877103
              pending = pending.subarray(length)
              continue
            }

            if (pending.length < 5) break
            const length = pending.readInt32BE(1) + 1

            if (pending.length < length) break

            if (pending[0] === 0x42 || pending[0] === 0x51) statements += 1
            pending = pending.subarray(length)
          }
        })
        upstream.on("data", (chunk: Buffer) => client.write(chunk))

        const end = () => {
          client.destroy()
          upstream.destroy()
        }

        client.on("close", end)
        upstream.on("close", end)
        client.on("error", end)
        upstream.on("error", end)
      })

      server.listen(0, "127.0.0.1", () =>
        resume(
          Effect.succeed({
            port: (server.address() as AddressInfo).port,
            statements: () => statements,
            close: () => {
              for (const socket of sockets) socket.destroy()
              server.close()
            },
          }),
        ),
      )
    }),
    (relay) => Effect.sync(relay.close),
  )

/** The statements the turn pool sends for `turns` Put commands on a runtime maintaining `views`. */
const turnStatements = (
  database: Redacted.Redacted<string>,
  views: ReadonlyArray<AnyFleetView>,
  turns: number,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const relay = yield* statementRelay(new URL(Redacted.value(database)))

      const context = yield* Layer.build(
        FleetOrderLive.pipe(
          Layer.provideMerge(ActorTest.layer({ database, fleet: views })),
          Layer.provide(
            Layer.succeed(TurnPoolSettings, {
              stream: () => connect({ host: "127.0.0.1", port: relay.port, noDelay: true }),
            }),
          ),
        ),
      )

      return yield* Effect.gen(function* () {
        const handle = yield* FleetOrder.get("counted")
        yield* handle.Put(order("counted", "warm", 0)).pipe(Effect.orDie)
        const before = relay.statements()

        for (let index = 0; index < turns; index++)
          yield* handle.Put(order("counted", `s${index}`, index)).pipe(Effect.orDie)

        return relay.statements() - before
      }).pipe(Effect.provideContext(context))
    }),
  )

const refusal = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "no refusal"

const statusOf = (rows: ReadonlyArray<ViewState>, name: string) =>
  rows.find(({ view_name }) => view_name === name)!

/** Fleet views: maintenance from the change feed, failover, rebuilds, poison isolation, freshness, and startup refusals. */
export const fleetConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "fleet: 0025_fleet applies",
    requiresIndependentConnections: true,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient

          const columns = yield* sql<{ column_name: string }>`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'actor_fleet_views' ORDER BY ordinal_position`

          expect(columns.map(({ column_name }) => column_name)).toEqual([
            "view_name",
            "source_schema",
            "source_table",
            "definition_hash",
            "status",
            "applied_lsn",
            "updated_at_ms",
            "last_error",
          ])
          expect(
            yield* sql`SELECT 1 AS applied FROM actor_migrations WHERE migration_id = 25`,
          ).toEqual([{ applied: 1 }])
        }),
      ),
  },
  {
    name: "fleet: every aggregate equals a recompute over the source after inserts, updates, deletes, and the removal of a group's last row, per tenant",
    requiresLogicalDecoding: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withFleet(environment, {}, (admin) =>
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          const other = `${cluster.tenant}-other`
          const model: Model = new Map()

          yield* place(model, order("a", "new", 100))
          yield* place(model, order("b", "new", 250, { region: "us" }))
          yield* place(model, order("c", "paid", 40))
          yield* place(model, order("a", "new", 900), other)
          yield* place(model, order("z", "lost", 7), other)
          yield* settleBoth(expect, admin, model)

          yield* place(model, order("a", "new", 130))
          yield* place(model, order("c", "paid", 40, { archived: true }))
          yield* remove(model, "b")
          yield* remove(model, "z", other)
          yield* settleBoth(expect, admin, model)

          expect(
            (yield* byStatusRows(admin))
              .filter((row) => row["tenant_id"] === other)
              .map((row) => [row["status"], row["orders"]]),
          ).toEqual([["new", 1]])
          yield* readyViews(expect, admin, ["OrdersByRegion", "OrdersByStatus"])
        }),
      ),
  },
  {
    name: "fleet: an update that moves a row between groups changes both groups",
    requiresLogicalDecoding: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withFleet(environment, {}, (admin) =>
        Effect.gen(function* () {
          const model: Model = new Map()

          yield* place(model, order("a", "new", 10))
          yield* place(model, order("b", "new", 20))
          yield* settleBoth(expect, admin, model)

          yield* place(model, order("a", "shipped", 10))
          yield* settleBoth(expect, admin, model)

          expect((yield* byStatusRows(admin)).map((row) => [row["status"], row["orders"]])).toEqual(
            [
              ["new", 1],
              ["shipped", 1],
            ],
          )
        }),
      ),
  },
  {
    name: "fleet: a rolled-back turn changes no view",
    requiresLogicalDecoding: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withFleet(environment, {}, (admin) =>
        Effect.gen(function* () {
          const model: Model = new Map()

          yield* place(model, order("a", "new", 10))
          yield* settleBoth(expect, admin, model)

          const refused = yield* call(0, undefined, "a", (handle) =>
            handle.PutThenRefuse(order("a", "refused", 999)),
          ).pipe(Effect.exit)

          expect(Exit.isFailure(refused)).toBe(true)

          yield* place(model, order("marker", "later", 1))
          yield* settleBoth(expect, admin, model)
          expect((yield* byStatusRows(admin)).map((row) => row["status"])).toEqual(["later", "new"])
        }),
      ),
  },
  {
    name: "fleet: a writer outside any turn changes the source and the view follows",
    requiresLogicalDecoding: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withFleet(environment, {}, (admin) =>
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          const model: Model = new Map()

          yield* place(model, order("a", "new", 10))
          yield* settleBoth(expect, admin, model)

          yield* admin`INSERT INTO fleet_orders (routing_key, tenant_id, actor_id, id, status, region,
              amount_cents, archived)
            VALUES (${String(tenantRoutingKey(cluster.tenant))}::bigint, ${cluster.tenant}, 'legacy',
              'l1', 'new', 'eu', 5, false)`.pipe(Effect.orDie)
          record(model, cluster.tenant, order("l1", "new", 5))

          yield* settleBoth(expect, admin, model)
        }),
      ),
  },
  {
    name: "fleet: a legacy writer's change to an adopted table appears in the view",
    requiresLogicalDecoding: true,
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { database, admin } = yield* fleetDatabase(environment, { setup: false })
          const tenant = "legacy-tenant"
          const on = Effect.provideService(SqlClient.SqlClient, admin)

          yield* admin`CREATE TABLE fleet_legacy_invoices (id text PRIMARY KEY, org_id text NOT NULL,
              account_id text NOT NULL, status text NOT NULL, amount bigint NOT NULL)`.pipe(
            Effect.orDie,
          )
          yield* admin`CREATE TABLE fleet_invoices_by_status (tenant_id text, status text,
              invoices bigint NOT NULL, total bigint NOT NULL, as_of numeric NOT NULL,
              PRIMARY KEY (tenant_id, status))`.pipe(Effect.orDie)
          yield* admin`INSERT INTO fleet_legacy_invoices VALUES
              ('i1', ${tenant}, 'acct-a', 'open', 10), ('i2', ${tenant}, 'acct-b', 'open', 20)`.pipe(
            Effect.orDie,
          )
          yield* migrate.pipe(on, Effect.orDie)
          yield* observeAdoption([LegacyAccount]).pipe(on, Effect.orDie)
          yield* backfillAdoption([LegacyAccount], {}).pipe(on, Effect.orDie)
          yield* admin`CREATE INDEX fleet_legacy_invoices_recompute
              ON fleet_legacy_invoices (routing_key, org_id, status)`.pipe(Effect.orDie)
          yield* setupFleet([InvoicesByStatus]).pipe(on, Effect.orDie)

          yield* Layer.build(ActorTest.layer({ database, fleet: [InvoicesByStatus] }))

          const rows = admin<{
            tenant_id: string
            status: string
            invoices: number
            total: string
          }>`
            SELECT tenant_id, status, invoices::int AS invoices, total::text AS total
            FROM fleet_invoices_by_status ORDER BY status`.pipe(Effect.orDie)

          yield* settle(expect, rows, [
            { tenant_id: tenant, status: "open", invoices: 2, total: "30" },
          ])

          yield* admin`UPDATE fleet_legacy_invoices SET status = 'paid', amount = 25 WHERE id = 'i2'`.pipe(
            Effect.orDie,
          )

          yield* settle(expect, rows, [
            { tenant_id: tenant, status: "open", invoices: 1, total: "10" },
            { tenant_id: tenant, status: "paid", invoices: 1, total: "25" },
          ])
        }),
      ),
  },
  {
    name: "fleet: a maintainer killed between applying a batch and advancing the slot replays it and the view still equals the recompute",
    requiresLogicalDecoding: true,
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { database, admin } = yield* fleetDatabase(environment)
          const model: Model = new Map()
          const before = yield* slotPosition(admin)

          yield* write(admin, model, "t1", order("a", "new", 10))
          yield* write(admin, model, "t1", order("b", "new", 20))
          yield* write(admin, model, "t2", order("a", "paid", 30, { region: "us" }))

          yield* Effect.scoped(
            Effect.gen(function* () {
              const crashing = yield* maintainerProcess(database, true)

              yield* printed(crashing, "APPLIED")

              expect(yield* byStatusRows(admin)).toEqual(expectedByStatus(model))
              expect(yield* slotPosition(admin)).toBe(before)

              crashing.kill("SIGKILL")
              expect(yield* Effect.promise(() => crashing.exited)).not.toBe(0)
              expect(crashing.signalCode).toBe("SIGKILL")
            }),
          )

          yield* write(admin, model, "t1", order("a", "shipped", 10))
          yield* admin`DELETE FROM fleet_orders WHERE tenant_id = 't2'`.pipe(Effect.orDie)
          forget(model, "t2", "a")

          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* maintainerProcess(database, false)
              yield* readyViews(expect, admin, ["OrdersByRegion", "OrdersByStatus"])
              yield* settleBoth(expect, admin, model)
              expect(BigInt(yield* slotPosition(admin)) > BigInt(before)).toBe(true)
            }),
          )
        }),
      ),
  },
  {
    name: "fleet: of two runners exactly one maintains, and the other takes over within the retry interval after the first is killed",
    requiresLogicalDecoding: true,
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment }) =>
      withFleet(environment, { runners: 2 }, (admin) =>
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          const model: Model = new Map()
          const takeover = `${Number(LOCK_RETRY.split(" ")[0]) + 3} seconds` as const

          yield* place(model, order("a", "new", 1))
          yield* settleBoth(expect, admin, model)
          expect(yield* lockHolders(admin)).toBe(1)

          for (const [killed, survivor] of [
            [0, 1],
            [1, 0],
          ] as const) {
            yield* cluster.kill(killed)
            yield* place(model, order(`after-${killed}`, "new", 2), undefined, survivor)
            yield* settle(expect, lockHolders(admin), 1, takeover)
            yield* settle(expect, byStatusRows(admin), expectedByStatus(model), takeover)
            expect(yield* lockHolders(admin)).toBe(1)

            if (killed === 0) {
              yield* cluster.restart(0)
              yield* settle(expect, lockHolders(admin), 1, takeover)
            }
          }
        }),
      ),
  },
  {
    name: "fleet: a lost slot marks every view stale and a rebuild restores them while writes continue",
    requiresLogicalDecoding: true,
    timeoutMs: 90_000,
    run: ({ expect, environment }) =>
      withFleet(environment, {}, (admin) =>
        Effect.gen(function* () {
          const model: Model = new Map()

          yield* place(model, order("a", "new", 10))
          yield* settleBoth(expect, admin, model)

          yield* dropSlot(admin)
          yield* settle(
            expect,
            viewStates(admin).pipe(Effect.map((rows) => rows.map(({ status }) => status))),
            ["stale", "stale"],
          )

          yield* place(model, order("gap", "new", 3))

          const writing = yield* Effect.forEach(
            Array.from({ length: 20 }, (_, index) => index),
            (index) =>
              place(model, order(`w${index % 5}`, index % 2 === 0 ? "new" : "paid", index)),
            { discard: true },
          ).pipe(Effect.forkChild)

          yield* setupFleet([OrdersByStatus, OrdersByRegion]).pipe(
            Effect.provideService(SqlClient.SqlClient, admin),
            Effect.orDie,
          )
          yield* Fiber.join(writing)
          yield* readyViews(expect, admin, ["OrdersByRegion", "OrdersByStatus"])
          yield* settleBoth(expect, admin, model)
        }),
      ),
  },
  {
    name: "fleet: a changed definition marks its view stale, and a new view builds from the existing rows",
    requiresLogicalDecoding: true,
    timeoutMs: 90_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { database, admin } = yield* fleetDatabase(environment)
          const model: Model = new Map()

          const cluster = (views: ReadonlyArray<AnyFleetView>) =>
            Layer.build(
              ActorTest.cluster({
                database,
                runners: 1,
                shardLockExpiration: "3 seconds",
                actors: FleetOrderLive,
                fleet: views,
              }),
            )

          yield* Effect.scoped(
            Effect.gen(function* () {
              const context = yield* cluster([OrdersByStatus])

              yield* Effect.gen(function* () {
                yield* place(model, order("a", "new", 10))
                yield* place(model, order("b", "new", 20, { archived: true, region: "us" }))
                yield* settle(expect, byStatusRows(admin), expectedByStatus(model))
              }).pipe(Effect.provideContext(context))
            }),
          )

          yield* checkFleet([OrdersByStatusAll, OrdersByRegion], undefined).pipe(
            Effect.provideService(SqlClient.SqlClient, admin),
          )
          expect(
            (yield* viewStates(admin)).map(({ view_name, status }) => ({ view_name, status })),
          ).toEqual([
            { view_name: "OrdersByRegion", status: "building" },
            { view_name: "OrdersByStatus", status: "stale" },
          ])

          yield* cluster([OrdersByStatusAll, OrdersByRegion])
          yield* readyViews(expect, admin, ["OrdersByRegion", "OrdersByStatus"])
          yield* settle(expect, byStatusRows(admin), expectedByStatus(model, true))
          yield* settle(expect, byRegionRows(admin), expectedByRegion(model))
        }),
      ),
  },
  {
    name: "fleet: a poisoned view goes stale and the other views keep advancing",
    requiresLogicalDecoding: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withFleet(environment, {}, (admin) =>
        Effect.gen(function* () {
          const model: Model = new Map()

          yield* place(model, order("a", "new", 10))
          yield* settleBoth(expect, admin, model)

          const huge = 5_000_000_000_000_000_000n
          yield* place(model, order("h1", "held", huge, { archived: true }))
          yield* place(model, order("h2", "held", huge, { archived: true }))

          yield* settle(
            expect,
            viewStates(admin).pipe(
              Effect.map((rows) =>
                rows.map(({ view_name, status, last_error }) => ({
                  view_name,
                  status,
                  poisoned: last_error?.includes("out of range") ?? false,
                })),
              ),
            ),
            [
              { view_name: "OrdersByRegion", status: "stale", poisoned: true },
              { view_name: "OrdersByStatus", status: "ready", poisoned: false },
            ],
          )

          const frozen = statusOf(yield* viewStates(admin), "OrdersByRegion").applied_lsn
          const before = BigInt(statusOf(yield* viewStates(admin), "OrdersByStatus").applied_lsn!)

          yield* place(model, order("b", "paid", 5))
          yield* settle(expect, byStatusRows(admin), expectedByStatus(model))
          yield* settle(
            expect,
            viewStates(admin).pipe(
              Effect.map((rows) => BigInt(statusOf(rows, "OrdersByStatus").applied_lsn!) > before),
            ),
            true,
          )
          expect(statusOf(yield* viewStates(admin), "OrdersByRegion").applied_lsn).toBe(frozen)

          yield* remove(model, "h1")
          yield* rebuildFleetView("OrdersByRegion").pipe(
            Effect.provideService(SqlClient.SqlClient, admin),
            Effect.orDie,
          )
          yield* readyViews(expect, admin, ["OrdersByRegion", "OrdersByStatus"])
          yield* settleBoth(expect, admin, model)
        }),
      ),
  },
  {
    name: "fleet: applied_lsn passes a command's durable-version after the view has seen its change, and never moves back",
    requiresLogicalDecoding: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withFleet(environment, {}, (admin) =>
        Effect.gen(function* () {
          const model: Model = new Map()
          yield* readyViews(expect, admin, ["OrdersByRegion", "OrdersByStatus"])
          const seen: Array<bigint> = []

          for (let index = 0; index < 5; index++) {
            yield* place(model, order(`v${index}`, "new", index + 1))

            const [token] = yield* admin<{ version: string }>`
              SELECT (pg_current_wal_insert_lsn() - '0/0')::text AS version`.pipe(Effect.orDie)

            const applied = yield* viewStates(admin).pipe(
              Effect.map((rows) => BigInt(statusOf(rows, "OrdersByStatus").applied_lsn ?? "0")),
              Effect.tap((lsn) => Effect.sync(() => seen.push(lsn))),
              Effect.repeat({
                schedule: Schedule.spaced("25 millis"),
                until: (lsn) => lsn >= BigInt(token!.version),
              }),
              Effect.timeout("20 seconds"),
              Effect.orDie,
            )

            expect(applied >= BigInt(token!.version)).toBe(true)
            expect(
              (yield* byStatusRows(admin)).find((row) => row["status"] === "new")?.["orders"],
            ).toBe(index + 1)
          }

          expect(seen.every((lsn, index) => index === 0 || lsn >= seen[index - 1]!)).toBe(true)
        }),
      ),
  },
  {
    name: "fleet: startup refuses wal_level below logical, no publication or slot, a source without full replica identity, an actor-placed source, a missing index, a login without REPLICATION, and a derived table the tenant role owns",
    requiresLogicalDecoding: true,
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const views = [OrdersByStatus, OrdersByRegion]

          const embedded = yield* Layer.build(Database.pglite())

          const low = yield* checkFleet(views, undefined).pipe(
            Effect.provideContext(embedded),
            Effect.exit,
          )

          expect(refusal(low)).toContain("set wal_level = logical")

          const { database, admin } = yield* fleetDatabase(environment, { setup: false })

          const check = (fleet: ReadonlyArray<AnyFleetView>, role?: string) =>
            checkFleet(fleet, role).pipe(
              Effect.provideService(SqlClient.SqlClient, admin),
              Effect.exit,
            )

          const runtime = yield* Layer.build(ActorTest.layer({ database, fleet: views })).pipe(
            Effect.exit,
          )

          expect(refusal(runtime)).toContain(
            "public.fleet_orders is not in publication durable_fleet; run durable fleet setup",
          )

          yield* admin`CREATE PUBLICATION durable_fleet FOR TABLE fleet_orders`.pipe(Effect.orDie)
          expect(refusal(yield* check(views))).toContain("does not have full replica identity")

          yield* admin`ALTER TABLE fleet_orders REPLICA IDENTITY FULL`.pipe(Effect.orDie)
          expect(refusal(yield* check(views))).toContain(
            `replication slot ${FLEET_SLOT} does not exist`,
          )

          yield* setupFleet(views).pipe(
            Effect.provideService(SqlClient.SqlClient, admin),
            Effect.orDie,
          )
          expect(Exit.isSuccess(yield* check(views))).toBe(true)

          yield* admin`ALTER TABLE fleet_orders REPLICA IDENTITY DEFAULT`.pipe(Effect.orDie)
          expect(refusal(yield* check(views))).toContain("REPLICA IDENTITY FULL")
          yield* admin`ALTER TABLE fleet_orders REPLICA IDENTITY FULL`.pipe(Effect.orDie)

          expect(refusal(yield* check([SpreadByKind]))).toContain('placement: "tenant"')

          yield* admin`DROP INDEX fleet_orders_by_region_recompute`.pipe(Effect.orDie)
          expect(refusal(yield* check(views))).toContain(
            "ON public.fleet_orders (routing_key, tenant_id, region, status)",
          )
          yield* admin.unsafe(fleetDdl.at(-1)!).pipe(Effect.orDie)

          const [random] = yield* admin<{
            id: string
          }>`SELECT substr(md5(random()::text), 1, 12) AS id`.pipe(Effect.orDie)

          const login = `fleet_login_${random!.id}`
          const tenantRole = `fleet_tenant_${random!.id}`

          yield* Effect.acquireRelease(
            admin
              .unsafe(`CREATE ROLE ${login} LOGIN PASSWORD 'fleet' NOREPLICATION`)
              .pipe(Effect.andThen(admin.unsafe(`CREATE ROLE ${tenantRole} NOLOGIN`))),
            () =>
              admin
                .unsafe(`ALTER TABLE fleet_orders_by_status OWNER TO CURRENT_USER`)
                .pipe(
                  Effect.andThen(admin.unsafe(`DROP OWNED BY ${login}, ${tenantRole}`)),
                  Effect.andThen(admin.unsafe(`DROP ROLE ${login}`)),
                  Effect.andThen(admin.unsafe(`DROP ROLE ${tenantRole}`)),
                  Effect.ignore,
                ),
          ).pipe(Effect.orDie)

          const url = new URL(Redacted.value(database))
          url.username = login
          url.password = "fleet"

          const unprivileged = yield* Layer.build(
            Database.postgres({ url: Redacted.make(url.href), maxConnections: 1 }),
          )

          expect(
            refusal(
              yield* checkFleet(views, undefined).pipe(
                Effect.provideContext(unprivileged),
                Effect.exit,
              ),
            ),
          ).toContain(`ALTER ROLE ${login} REPLICATION`)

          yield* admin
            .unsafe(`ALTER TABLE fleet_orders_by_status OWNER TO ${tenantRole}`)
            .pipe(Effect.orDie)
          expect(refusal(yield* check(views, tenantRole))).toContain(
            `the tenant role ${tenantRole} owns public.fleet_orders_by_status`,
          )
        }),
      ),
  },
  {
    name: "fleet: the statements of a turn are unchanged when views are registered",
    requiresLogicalDecoding: true,
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment }) =>
      environment.run(Effect.service(Crypto.Crypto)).then((crypto) =>
        Effect.runPromise(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(environment.stop, () => environment.restart)
            const plain = yield* fleetDatabase(environment, { setup: false })
            const { database } = yield* fleetDatabase(environment)

            const without = yield* turnStatements(plain.database, [], 5)
            const withViews = yield* turnStatements(database, [OrdersByStatus, OrdersByRegion], 5)

            expect(without > 0).toBe(true)
            expect(withViews).toBe(without)
          }).pipe(Effect.scoped, Effect.provideService(Crypto.Crypto, crypto)),
        ),
      ),
  },
  {
    name: "fleet: PGlite refuses Fleet.view at layer build",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const exit = yield* Layer.build(
            ActorTest.layer({ database: {}, fleet: [OrdersByStatus] }),
          ).pipe(Effect.exit)

          expect(refusal(exit)).toContain("PGlite has no logical replication")
        }),
      ),
  },
]
