import { sql as fragment, type SQL } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import { Cause, Clock, Context, Effect, Schedule } from "effect"
import { SqlClient, type SqlError } from "effect/unstable/sql"
import type { AggregateKind, AnyFleetView } from "../../tables/fleet.ts"
import type { AnyOwnedTable, Filter } from "../../tables/owned.ts"
import { tenantRoutingKey } from "../storage/codec.ts"
import { count, Metrics, record } from "../telemetry/metrics.ts"
import { filterSql } from "../turn/rows.ts"
import { decode, type Relation, type Tuple } from "./pgoutput.ts"

/** The logical replication slot and publication every fleet view reads. */
export const FLEET_SLOT = "durable_fleet"

export const FLEET_PUBLICATION = "durable_fleet"

/** The session-level advisory lock the one maintainer holds. */
const LOCK = "durable-actors/fleet"

/** Changes asked for per peek; the peek still ends on a transaction boundary. */
const PEEK_CHANGES = 500

/** How often an idle maintainer polls the slot. */
const POLL_INTERVAL = "200 millis"

/** How often a runner without the lock tries to take it. */
export const LOCK_RETRY = "2 seconds"

/** Groups a rebuild writes per poll: about 200 a second. */
const REBUILD_GROUPS_PER_POLL = 40

/**
 * Test points of the fleet engine: `afterApply` runs after a batch's derived
 * rows commit and before the slot advances, where a crash replays the batch;
 * `poll` and `page` count a runner's subscription reads.
 */
export const FleetHooks = Context.Reference<{
  readonly afterApply: Effect.Effect<void>
  /** Runs before each read of a view's state by a runner's subscription poller. */
  readonly poll: (view: string) => Effect.Effect<void>
  /** Runs before each page query of a subscription. */
  readonly page: (view: string) => Effect.Effect<void>
}>("durable-actors/FleetHooks", {
  defaultValue: () => ({
    afterApply: Effect.void,
    poll: () => Effect.void,
    page: () => Effect.void,
  }),
})

const dialect = new PgDialect()

const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`

const qualified = (schema: string, table: string) => `${identifier(schema)}.${identifier(table)}`

/** The SQL of each aggregate over its quoted source column. */
const AGGREGATE_SQL: Readonly<Record<AggregateKind, (column: string) => string>> = {
  count: () => "count(*)",
  sum: (column) => `sum(${column})::bigint`,
  avg: (column) => `avg(${column})::float8`,
  min: (column) => `min(${column})`,
  max: (column) => `max(${column})`,
}

/** A view with the schema names its tables resolve to on this database. */
export interface ResolvedView {
  readonly view: AnyFleetView
  readonly sourceSchema: string
  readonly derivedSchema: string
}

/**
 * The statement that recomputes one tenant's groups of `view` from the source
 * and writes them: an upsert of every group the source still holds, and a
 * delete of the groups among them it no longer does. `group` narrows it to
 * one group, as a change batch does; without it the whole tenant is rebuilt.
 */
const recomputeStatement = (
  resolved: ResolvedView,
  tenant: string,
  group: ReadonlyArray<string> | undefined,
  asOf: string,
) => {
  const { view } = resolved
  const source = qualified(resolved.sourceSchema, view.source.table)
  const derived = qualified(resolved.derivedSchema, view.tableName.split(".").at(-1)!)
  const groupColumns = view.groupColumns.map(identifier)
  const keys = ["tenant_id", ...groupColumns]
  const tenantColumn = identifier(view.tenantColumn)
  const sourceKeys = [`${tenantColumn}::text`, ...groupColumns]
  const grouping = [tenantColumn, ...groupColumns]

  const aggregates = view.aggregates.map(({ kind, column }) =>
    AGGREGATE_SQL[kind](identifier(column ?? "")),
  )

  const columns = [...keys, ...view.aggregates.map(({ key }) => identifier(key)), "as_of"]

  const filter: SQL | undefined =
    view.where === undefined
      ? undefined
      : filterSql({ table: view.from, filter: view.where as Filter<AnyOwnedTable> })

  const equal = (prefix: string) =>
    group === undefined
      ? fragment``
      : fragment.join(
          group.map(
            (value, index) =>
              fragment` AND ${fragment.raw(`${prefix}${groupColumns[index]}`)} = ${value}`,
          ),
        )

  const statement = fragment`WITH fresh AS (
      INSERT INTO ${fragment.raw(derived)} (${fragment.raw(columns.join(", "))})
      SELECT ${fragment.raw(sourceKeys.join(", "))}, ${fragment.raw(aggregates.join(", "))}, ${asOf}::numeric
      FROM ${fragment.raw(source)}
      WHERE ${fragment.raw(identifier(view.routingColumn))} = ${String(tenantRoutingKey(tenant))}::bigint
        AND ${fragment.raw(tenantColumn)} = ${tenant}${equal("")}${
          filter === undefined ? fragment`` : fragment` AND (${filter})`
        }
      GROUP BY ${fragment.raw(grouping.join(", "))}
      ON CONFLICT (${fragment.raw(keys.join(", "))}) DO UPDATE SET ${fragment.raw(
        [...view.aggregates.map(({ key }) => identifier(key)), "as_of"]
          .map((column) => `${column} = EXCLUDED.${column}`)
          .join(", "),
      )}
      RETURNING ${fragment.raw(groupColumns.join(", "))}),
    gone AS (
      DELETE FROM ${fragment.raw(derived)} d WHERE d.tenant_id = ${tenant}${equal("d.")}
        AND NOT EXISTS (SELECT 1 FROM fresh f WHERE ${fragment.raw(
          groupColumns.map((column) => `f.${column} = d.${column}`).join(" AND "),
        )})
      RETURNING 1)
    SELECT (SELECT count(*) FROM fresh)::int + (SELECT count(*) FROM gone)::int AS groups`

  return dialect.sqlToQuery(statement)
}

/** The innermost message of an error's cause chain: the database's own words. */
const innermost = (error: SqlError.SqlError) => {
  let message = error.message
  let current: unknown = error.cause

  while (current instanceof Error) {
    message = current.message
    current = current.cause
  }

  return message
}

interface ViewRow {
  readonly view_name: string
  readonly status: "building" | "ready" | "stale"
  readonly last_error: string | null
}

/** A group a change touched: the tenant and the group values in text form. */
type GroupKey = readonly [tenant: string, ...values: Array<string>]

/**
 * Maintains every registered view while this runner holds the fleet lock:
 * peeks a batch of committed changes, recomputes each touched group in one
 * transaction, commits, and only then advances the slot, so a crash between
 * the two replays a batch whose recompute is idempotent. When no change is
 * waiting it rebuilds `building` and `stale` views a few tenants at a time.
 * A view whose recompute fails is marked stale with its error and skipped
 * until `durable fleet rebuild`, so it never stops the others. A slot that
 * is missing, lost, or moved by anyone else marks every view stale. The
 * runner that cannot take the lock retries every `LOCK_RETRY`.
 */
export const maintain = Effect.fnUntraced(function* (views: ReadonlyArray<ResolvedView>) {
  const sql = yield* SqlClient.SqlClient
  const hooks = yield* FleetHooks

  const holding = Effect.gen(function* () {
    const connection = yield* sql.reserve

    const on = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.provideService(effect, sql.transactionService, [connection, 0])

    const [lock] = yield* on(
      sql<{ locked: boolean }>`SELECT pg_try_advisory_lock(hashtext(${LOCK})) AS locked`,
    )

    if (lock?.locked !== true) return false

    yield* Effect.addFinalizer(() =>
      on(sql`SELECT pg_advisory_unlock(hashtext(${LOCK})) AS unlocked`).pipe(Effect.ignore),
    )

    return yield* run(views, on, hooks.afterApply)
  }).pipe(Effect.scoped)

  yield* holding.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("Fleet maintainer stopped", cause).pipe(Effect.as(false)),
    ),
    Effect.repeat(Schedule.spaced(LOCK_RETRY)),
  )
})

const run = Effect.fnUntraced(function* (
  views: ReadonlyArray<ResolvedView>,
  on: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  afterApply: Effect.Effect<void>,
) {
  const sql = yield* SqlClient.SqlClient
  const relations = new Map<number, Relation>()
  const names = views.map(({ view }) => view.name)
  const cursors = new Map<string, string | undefined>()
  let position: string | undefined

  const now = Clock.currentTimeMillis

  const markAllStale = Effect.gen(function* () {
    const at = yield* now
    yield* on(sql`UPDATE actor_fleet_views SET status = 'stale', updated_at_ms = ${at}
      WHERE view_name IN ${sql.in(names)} AND status <> 'stale'`)
    cursors.clear()
  })

  const statuses = on(
    sql<ViewRow>`SELECT view_name, status, last_error FROM actor_fleet_views
      WHERE view_name IN ${sql.in(names)}`,
  ).pipe(Effect.map((rows) => new Map(rows.map((row) => [row.view_name, row]))))

  const recompute = (
    resolved: ResolvedView,
    tenant: string,
    group: ReadonlyArray<string> | undefined,
    asOf: string,
  ) => {
    const query = recomputeStatement(resolved, tenant, group, asOf)

    return on(sql.unsafe<{ groups: number }>(query.sql, query.params as Array<never>)).pipe(
      Effect.map((rows) => rows[0]?.groups ?? 0),
    )
  }

  /** Runs `body` for one view inside a savepoint; a failure marks the view stale with its error. */
  const isolated = (name: string, body: Effect.Effect<void, SqlError.SqlError>) =>
    on(sql`SAVEPOINT fleet_view`).pipe(
      Effect.andThen(body),
      Effect.andThen(on(sql`RELEASE SAVEPOINT fleet_view`)),
      Effect.as(true),
      Effect.catchTag("SqlError", (error) =>
        Effect.gen(function* () {
          yield* on(sql`ROLLBACK TO SAVEPOINT fleet_view`)
          const at = yield* now
          yield* on(sql`UPDATE actor_fleet_views
            SET status = 'stale', last_error = ${innermost(error)}, updated_at_ms = ${at}
            WHERE view_name = ${name}`)
          cursors.delete(name)

          return false
        }),
      ),
    )

  const inTransaction = <A, E, R>(body: Effect.Effect<A, E, R>) =>
    on(sql`BEGIN`).pipe(
      Effect.andThen(body),
      Effect.tap(() => on(sql`COMMIT`)),
      Effect.onError(() => on(sql`ROLLBACK`).pipe(Effect.ignore)),
    )

  const touchedBy = (
    change: ReturnType<typeof decode>,
    touched: Map<string, Map<string, GroupKey>>,
    truncated: Set<string>,
  ) => {
    if (change.kind === "relation") relations.set(change.relation.id, change.relation)

    if (change.kind === "truncate") {
      for (const id of change.relations) {
        const relation = relations.get(id)

        for (const { view, sourceSchema } of views)
          if (relation?.schema === sourceSchema && relation.table === view.source.table)
            truncated.add(view.name)
      }

      return
    }

    if (change.kind !== "insert" && change.kind !== "update" && change.kind !== "delete") return

    const relation = relations.get(change.relation)

    if (relation === undefined) return

    const before = change.kind === "insert" ? undefined : change.before
    const after = change.kind === "delete" ? undefined : change.after

    for (const { view, sourceSchema } of views) {
      if (relation.schema !== sourceSchema || relation.table !== view.source.table) continue

      const indexes = [view.tenantColumn, ...view.groupColumns].map((column) =>
        relation.columns.indexOf(column),
      )

      const keyOf = (tuple: Tuple | undefined, fallback: Tuple | undefined) => {
        if (tuple === undefined) return undefined

        const values: Array<string> = []

        for (const index of indexes) {
          const value = tuple[index] ?? fallback?.[index]

          if (value === null || value === undefined) return undefined

          values.push(value)
        }

        const [tenant, ...rest] = values

        if (tenant === undefined) return undefined

        const key: GroupKey = [tenant, ...rest]

        return key
      }

      const groups = touched.get(view.name) ?? new Map<string, GroupKey>()

      for (const key of [keyOf(before, undefined), keyOf(after, before)])
        if (key !== undefined) groups.set(JSON.stringify(key), key)

      touched.set(view.name, groups)
    }
  }

  const slot = on(
    sql<{ flush: string; confirmed: string | null; wal_status: string | null }>`
      SELECT (pg_current_wal_flush_lsn() - '0/0')::text AS flush,
        (s.confirmed_flush_lsn - '0/0')::text AS confirmed, s.wal_status
      FROM (SELECT 1) one LEFT JOIN pg_replication_slots s
        ON s.slot_name = ${FLEET_SLOT} AND s.database = current_database()`,
  ).pipe(Effect.map((rows) => rows[0]!))

  /**
   * A new maintainer trusts the slot's position, unless a ready view has
   * applied less than it: the slot then moved without this view seeing the
   * changes between, as when it was dropped and recreated.
   */
  const start = Effect.gen(function* () {
    const found = yield* slot

    if (found.confirmed === null || found.wal_status === "lost") return yield* markAllStale

    position = found.confirmed

    const behind = yield* on(
      sql<{ view_name: string }>`SELECT view_name FROM actor_fleet_views
        WHERE view_name IN ${sql.in(names)} AND status = 'ready'
          AND (applied_lsn IS NULL OR applied_lsn < ${position}::numeric)`,
    )

    if (behind.length > 0) yield* markAllStale
  })

  let drained = yield* now

  /** Sets each view's lag gauges: WAL bytes past what was applied, and time since the feed was last drained. */
  const reportLag = (flush: string) =>
    Effect.gen(function* () {
      const bytes = position === undefined ? 0 : Number(BigInt(flush) - BigInt(position))
      const ms = (yield* now) - drained

      for (const name of names) {
        yield* record(Metrics.fleetLagBytes, { view: name }, bytes)
        yield* record(Metrics.fleetLag, { view: name }, ms)
      }
    })

  const batch = Effect.gen(function* () {
    const found = yield* slot

    if (found.confirmed === null || found.wal_status === "lost") {
      if (position !== undefined) yield* markAllStale
      position = undefined

      return false
    }

    if (position === undefined || BigInt(found.confirmed) > BigInt(position)) {
      if (position !== undefined) yield* markAllStale
      position = found.confirmed
    }

    const rows = yield* on(
      sql<{ data: string }>`
        SELECT encode(data, 'base64') AS data FROM pg_logical_slot_peek_binary_changes(
          ${FLEET_SLOT}, '0/0'::pg_lsn + ${found.flush}::numeric, ${PEEK_CHANGES},
          'proto_version', '1', 'publication_names', ${FLEET_PUBLICATION})`,
    )

    const touched = new Map<string, Map<string, GroupKey>>()
    const truncated = new Set<string>()
    let lastEnd: bigint | undefined

    for (const row of rows) {
      const change = decode(Buffer.from(row.data, "base64"))

      if (change.kind === "commit") lastEnd = change.end
      else touchedBy(change, touched, truncated)
    }

    const target =
      rows.length >= PEEK_CHANGES && lastEnd !== undefined ? String(lastEnd) : found.flush

    if (BigInt(target) <= BigInt(position)) {
      drained = yield* now
      yield* reportLag(found.flush)

      return false
    }

    const status = yield* statuses

    const recomputed = new Map<string, number>()

    yield* inTransaction(
      Effect.gen(function* () {
        const advanced: Array<string> = []

        for (const resolved of views) {
          const name = resolved.view.name
          const row = status.get(name)

          if (row === undefined || row.last_error !== null) continue

          const derived = qualified(
            resolved.derivedSchema,
            resolved.view.tableName.split(".").at(-1)!,
          )

          const groups = [...(touched.get(name)?.values() ?? [])]

          const ok = yield* isolated(
            name,
            Effect.gen(function* () {
              if (truncated.has(name)) {
                const tenants = yield* on(
                  sql<{
                    tenant_id: string
                  }>`SELECT DISTINCT tenant_id FROM ${sql.literal(derived)}`,
                )

                for (const { tenant_id } of tenants)
                  yield* recompute(resolved, tenant_id, undefined, target)
              }

              for (const [tenant, ...values] of groups)
                yield* recompute(resolved, tenant, values, target)
            }),
          )

          if (ok) recomputed.set(name, groups.length)

          if (ok && row.status === "ready") advanced.push(name)
        }

        const at = yield* now

        if (advanced.length > 0)
          yield* on(sql`UPDATE actor_fleet_views SET applied_lsn = ${target}::numeric, updated_at_ms = ${at}
            WHERE view_name IN ${sql.in(advanced)} AND status = 'ready'
              AND (applied_lsn IS NULL OR applied_lsn < ${target}::numeric)`)
      }),
    )

    yield* afterApply

    yield* on(
      sql`SELECT 1 FROM pg_replication_slot_advance(${FLEET_SLOT}, '0/0'::pg_lsn + ${target}::numeric)`,
    )
    position = target

    yield* count(Metrics.fleetBatches, {}, 1)

    for (const [name, groups] of recomputed)
      yield* count(Metrics.fleetGroupsRecomputed, { view: name }, groups)

    if (target === found.flush) drained = yield* now
    yield* reportLag(found.flush)

    return rows.length > 0
  })

  /**
   * Rebuilds `building` and stale views without an error, a few tenants per
   * poll, in keyset order over the tenants of the source and of the derived
   * table, so groups that vanished are deleted. Each recompute reads current
   * data and the maintainer is the only writer, so it converges while writes
   * continue; the view is ready, as of the slot's position, after its last
   * tenant.
   */
  const rebuild = Effect.gen(function* () {
    if (position === undefined) return
    const status = yield* statuses
    let budget = REBUILD_GROUPS_PER_POLL

    for (const resolved of views) {
      const name = resolved.view.name
      const row = status.get(name)

      if (row === undefined || row.status === "ready" || row.last_error !== null) {
        cursors.delete(name)
        continue
      }

      const source = qualified(resolved.sourceSchema, resolved.view.source.table)
      const derived = qualified(resolved.derivedSchema, resolved.view.tableName.split(".").at(-1)!)

      while (budget > 0) {
        const after = cursors.get(name)

        const [next] = yield* on(
          sql<{ tenant_id: string }>`SELECT tenant_id FROM (
              SELECT ${sql.literal(identifier(resolved.view.tenantColumn))}::text AS tenant_id
              FROM ${sql.literal(source)}
              UNION SELECT tenant_id FROM ${sql.literal(derived)}) t
            WHERE ${after === undefined ? sql`true` : sql`tenant_id > ${after}`}
            ORDER BY tenant_id LIMIT 1`,
        )

        if (next === undefined) {
          const at = yield* now
          yield* on(sql`UPDATE actor_fleet_views
            SET status = 'ready', applied_lsn = ${position}::numeric, updated_at_ms = ${at}
            WHERE view_name = ${name} AND status <> 'ready' AND last_error IS NULL`)
          cursors.delete(name)
          break
        }

        const asOf = position

        const written = yield* inTransaction(
          Effect.gen(function* () {
            let groups = 0

            const ok = yield* isolated(
              name,
              recompute(resolved, next.tenant_id, undefined, asOf).pipe(
                Effect.map((count) => {
                  groups = count
                }),
              ),
            )

            return ok ? groups : undefined
          }),
        )

        if (written === undefined) break

        cursors.set(name, next.tenant_id)
        budget -= Math.max(1, written)
      }

      if (budget <= 0) return
    }
  })

  yield* start

  return yield* Effect.gen(function* () {
    const changed = yield* batch

    if (!changed) {
      yield* rebuild
      yield* Effect.sleep(POLL_INTERVAL)
    }
  }).pipe(
    Effect.catchTag("SqlError", (error) =>
      /replication slot|logical decoding/i.test(innermost(error))
        ? Effect.gen(function* () {
            if (position !== undefined) yield* markAllStale
            position = undefined
            yield* Effect.sleep(POLL_INTERVAL)
          })
        : Effect.fail(error),
    ),
    Effect.forever,
  )
})
