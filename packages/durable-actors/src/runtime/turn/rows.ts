import { PgClient } from "@effect/sql-pg"
import { PgliteClient } from "@effect/sql-pglite"
import {
  and,
  Column,
  count,
  entityKind,
  eq,
  getTableColumns,
  is,
  Param,
  Placeholder,
  relationsFilterToSQL,
  relationsOrderToSQL,
  SQL,
  sql as fragment,
  StringChunk,
  Table,
  type SQLChunk,
} from "drizzle-orm"
import * as PostgresDrizzle from "drizzle-orm/effect-postgres"
import * as PgliteDrizzle from "drizzle-orm/effect-pglite"
import { PgSelectBase, type PgSelectConfig } from "drizzle-orm/pg-core"
import { Cause, Effect, Option, Predicate } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { routingKey as routingKeyOf } from "../storage/codec.ts"
import {
  OWNERSHIP,
  ownership,
  type Group,
  type GroupDatabase,
  type Filter,
  type Filtered,
  type Insert,
  type ListOptions,
  type Order,
  type AnyOwnedTable,
  type Ownership,
  type ReadOptions,
  type ScopedRead,
  type ScopedRows,
  type TableAccess,
  type TableScope,
} from "../../tables/owned.ts"

type Database = PostgresDrizzle.EffectPgDatabase

/** Drizzle bound to the runtime's own client, so it shares the turn connection. */
export const rowsDatabase = Effect.gen(function* () {
  const pglite = yield* Effect.serviceOption(PgliteClient.PgliteClient)

  if (Option.isSome(pglite)) {
    const database: Database = yield* PgliteDrizzle.makeWithDefaults().pipe(
      Effect.provideService(PgliteClient.PgliteClient, pglite.value),
    )

    return Option.some(database)
  }

  const postgres = yield* Effect.serviceOption(PgClient.PgClient)

  if (Option.isNone(postgres)) return Option.none<Database>()

  return Option.some(
    yield* PostgresDrizzle.makeWithDefaults().pipe(
      Effect.provideService(PgClient.PgClient, postgres.value),
    ),
  )
})

/** A value application code may place in a row or filter; SQL is never one. */
type Operand =
  | string
  | number
  | bigint
  | boolean
  | Date
  | Uint8Array
  | null
  | undefined
  | ReadonlyArray<Operand>
  | OperandRecord

interface OperandRecord {
  readonly [key: string]: Operand
}

/** A Drizzle expression tree as a group query holds it. */
type Expression = SQLChunk | ReadonlyArray<Expression> | undefined

interface Selection {
  readonly [key: string]: SQLChunk | Selection
}

const isEntity = (value: Operand | Expression | Selection): boolean =>
  value instanceof Object && entityKind in value.constructor

const isRecord = (value: Operand | Selection | SQLChunk): value is OperandRecord => {
  const prototype = value === null || value === undefined ? undefined : Object.getPrototypeOf(value)

  return prototype === Object.prototype || prototype === null
}

const reject = (message: string): never => {
  throw new Error(message)
}

const reserved: ReadonlyArray<string> = OWNERSHIP

const checkColumn = (info: Ownership, key: string) => {
  if (reserved.includes(key))
    reject(`Ownership column ${key} of ${info.name} comes from the turn, not the application`)

  if (!info.columns.includes(key)) reject(`Unknown column ${key} of ${info.name}`)
}

const checkValues = (info: Ownership, values: OperandRecord) => {
  if (!isRecord(values)) reject(`Rows of ${info.name} are plain objects`)

  for (const [key, value] of Object.entries(values)) {
    checkColumn(info, key)

    if (isEntity(value)) reject(`Column ${key} of ${info.name} takes a value, not SQL`)
  }
}

const checkOperand = (info: Ownership, value: Operand): void => {
  if (isEntity(value)) reject(`Filters on ${info.name} take values, not SQL`)

  if (Array.isArray(value)) for (const item of value) checkOperand(info, item)
  else if (isRecord(value))
    for (const [key, item] of Object.entries(value)) {
      if (key === "RAW") reject(`RAW filters on ${info.name} are not supported`)

      checkOperand(info, item)
    }
}

const checkFilter = (info: Ownership, filter: Operand): void => {
  if (!isRecord(filter)) return reject(`Filters on ${info.name} are plain objects`)

  for (const [key, value] of Object.entries(filter)) {
    if (key === "RAW") reject(`RAW filters on ${info.name} are not supported`)
    else if (key === "AND" || key === "OR") {
      if (!Array.isArray(value)) return reject(`${key} on ${info.name} takes an array`)

      for (const item of value) checkFilter(info, item)
    } else if (key === "NOT") checkFilter(info, value)
    else {
      checkColumn(info, key)
      checkOperand(info, value)
    }
  }
}

const checkOrder = (info: Ownership, order: Order<AnyOwnedTable>) => {
  for (const [key, direction] of Object.entries(order)) {
    checkColumn(info, key)

    if (direction !== "asc" && direction !== "desc")
      reject(`Order on ${info.name} is "asc" or "desc"`)
  }
}

// Drizzle's comparison, boolean, pattern, and aggregate operators emit only
// these words; anything else in a group query's SQL text is rejected so raw
// fragments cannot name other tables or subqueries.
const OPERATOR_TEXT =
  /^(?:\s+|[(),*=<>!~@&|]+|and|or|not|in|is|null|like|ilike|between|asc|desc|nulls|first|last|distinct|true|false|count|sum|avg|min|max|lower|upper|coalesce)*$/i

const checkExpression = (chunk: Expression): void => {
  if (Array.isArray(chunk)) for (const item of chunk) checkExpression(item)
  else if (is(chunk, StringChunk)) {
    if (!OPERATOR_TEXT.test(chunk.value))
      reject(`Group queries support Drizzle operators, not raw SQL: ${chunk.value}`)
  } else if (is(chunk, SQL.Aliased)) checkExpression(chunk.sql)
  else if (is(chunk, SQL)) for (const item of chunk.queryChunks) checkExpression(item)
  else if (is(chunk, Column) || is(chunk, Param)) return
  else if (isEntity(chunk))
    reject("Group queries cannot reference tables, subqueries, or placeholders")
}

const checkSelection = (fields: SQLChunk | Selection): void => {
  if (is(fields, Column) || is(fields, SQL) || is(fields, SQL.Aliased)) checkExpression(fields)
  else if (!isEntity(fields) && isRecord(fields))
    for (const value of Object.values(fields as Selection)) checkSelection(value)
  else reject("Group queries select columns and Drizzle expressions")
}

export const bindTables = Effect.fnUntraced(function* (
  database: Option.Option<Database>,
  scope: TableScope,
  write: boolean,
) {
  const sql = yield* SqlClient.SqlClient
  const connection = yield* Effect.serviceOption(sql.transactionService)

  // Writes join the turn's transaction or do not run at all.
  if (write && Option.isNone(connection))
    return yield* Effect.die(new Error("Owned rows need the turn transaction"))

  const db = Option.getOrUndefined(database)!

  const run = <A, E>(build: () => Effect.Effect<A, E>): Effect.Effect<A> =>
    Effect.andThen(scope.guard, () =>
      Option.isNone(database)
        ? Effect.die(new Error("Owned tables need a PgClient or PgliteClient database"))
        : Effect.suspend(build).pipe(
            (effect) =>
              Option.isSome(connection)
                ? Effect.provideService(effect, sql.transactionService, connection.value)
                : effect,
            // Drizzle wraps the driver's failure; the SqlError inside decides
            // whether the turn is retried or is a deterministic defect.
            Effect.catch((error) => {
              const wrapped = Predicate.hasProperty(error, "cause") ? error.cause : undefined
              const cause = Cause.isCause(wrapped) ? Cause.squash(wrapped) : wrapped

              return Effect.die(SqlError.isSqlError(cause) ? cause : error)
            }),
          ),
    )

  const { ref } = scope
  const routingKey = routingKeyOf({ ref, placement: scope.placement })

  const owner = { routing_key: routingKey, tenant_id: ref.tenant, actor_id: ref.id }

  const rows = (table: AnyOwnedTable): ScopedRead<AnyOwnedTable> => {
    const info = ownership(table)

    const check = () => {
      if (info === undefined || !scope.tables.includes(table))
        reject(`${info?.name ?? "This table"} is not an owned table of ${ref.actor}`)

      return info!
    }

    const columns = getTableColumns(table)

    const where = (filter: Filter<AnyOwnedTable> | undefined) => {
      const info = check()

      if (filter !== undefined) checkFilter(info, filter as OperandRecord)

      return and(
        eq(columns["routing_key"]!, routingKey),
        eq(columns["tenant_id"]!, ref.tenant),
        eq(columns["actor_id"]!, ref.id),
        relationsFilterToSQL(table, filter ?? {}),
      )
    }

    const fields = () => Object.fromEntries(check().columns.map((key) => [key, columns[key]!]))

    const order = (orderBy: Order<AnyOwnedTable> | undefined) => {
      if (orderBy === undefined) return []

      checkOrder(check(), orderBy)
      const sql = relationsOrderToSQL(table, orderBy)

      return sql === undefined ? [] : [sql]
    }

    const list = (options: ListOptions<AnyOwnedTable>) => {
      const query = db
        .select(fields())
        .from(table)
        .where(where(options.where))
        .orderBy(...order(options.orderBy))
        .$dynamic()

      const limited = options.limit === undefined ? query : query.limit(options.limit)

      return options.offset === undefined ? limited : limited.offset(options.offset)
    }

    const prepare = (values: Insert<AnyOwnedTable> | ReadonlyArray<Insert<AnyOwnedTable>>) => {
      const info = check()
      const list: ReadonlyArray<Insert<AnyOwnedTable>> = Array.isArray(values) ? values : [values]

      for (const value of list) checkValues(info, value as OperandRecord)

      return { info, list: list.map((value) => ({ ...value, ...owner })) }
    }

    const filtered = <A, E>(
      mutation: (filter: Filter<AnyOwnedTable>) => Effect.Effect<A, E>,
    ): Filtered<AnyOwnedTable> => ({
      where: (filter) => run(() => mutation(filter)).pipe(Effect.asVoid),
    })

    const read = {
      one: (options: ReadOptions<AnyOwnedTable> = {}) =>
        run(() => list({ ...options, limit: 1 })).pipe(
          Effect.map((found) => Option.fromNullishOr(found[0])),
        ),
      all: (options: ListOptions<AnyOwnedTable> = {}) => run(() => list(options)),
      count: (options: { readonly where?: Filter<AnyOwnedTable> } = {}) =>
        run(() =>
          db
            .select({ rows: count() })
            .from(table)
            .where(where(options.where))
            .pipe(Effect.map((found) => found[0]?.rows ?? 0)),
        ),
    } satisfies ScopedRead<AnyOwnedTable>

    // Off-turn contexts get no mutation methods at all, whatever their static type.
    if (!write) return read

    return {
      ...read,
      insert: (values) =>
        run(() => {
          const { list } = prepare(values)

          return list.length === 0 ? Effect.void : db.insert(table).values(list)
        }).pipe(Effect.asVoid),
      upsert: (values) =>
        run(() => {
          const { info, list } = prepare(values)

          if (list.length === 0) return Effect.void
          const target = [...OWNERSHIP, ...info.primaryKey].map((key) => columns[key]!)

          const set = Object.fromEntries(
            [...new Set(list.flatMap((value) => Object.keys(value)))].flatMap((key) =>
              info.primaryKey.includes(key) || reserved.includes(key)
                ? []
                : [[key, fragment`excluded.${fragment.identifier(columns[key]!.name)}`]],
            ),
          )

          const insert = db.insert(table).values(list)

          return Object.keys(set).length === 0
            ? insert.onConflictDoNothing({ target })
            : insert.onConflictDoUpdate({ target, set })
        }).pipe(Effect.asVoid),
      update: (values) =>
        filtered((filter) => {
          checkValues(check(), values as OperandRecord)

          if (Object.keys(values).length === 0)
            reject(`An update of ${check().name} sets at least one column`)

          return db.update(table).set(values).where(where(filter))
        }),
      delete: () => filtered((filter) => db.delete(table).where(where(filter))),
    } satisfies ScopedRows<AnyOwnedTable> as ScopedRows<AnyOwnedTable>
  }

  const inGroup = (table: PgSelectConfig["table"]) => {
    if (!is(table, Table) || ownership(table) === undefined)
      return reject("Group queries read owned tables only")

    const columns = getTableColumns(table)

    return and(eq(columns["routing_key"]!, routingKey), eq(columns["tenant_id"]!, ref.tenant))
  }

  const group: Group = (build) =>
    run(() => {
      const query = build({
        select: db.select.bind(db),
        selectDistinct: db.selectDistinct.bind(db),
      } as GroupDatabase)

      if (!is(query, PgSelectBase)) return reject("A group query is a Drizzle select")

      const { config } = query as typeof query & { readonly config: PgSelectConfig }

      if ((config.withList?.length ?? 0) > 0) reject("Group queries cannot use WITH")

      if (config.setOperators.length > 0) reject("Group queries cannot use set operators")

      if (config.lockingClause !== undefined)
        reject("Group queries are read-only and take no locks")

      for (const bound of [config.limit, config.offset])
        if (is(bound, Placeholder)) reject("Group query limits are numbers")

      checkSelection(config.fields as Selection)

      for (const expression of [config.where, config.having]) checkExpression(expression)

      for (const expression of [...(config.orderBy ?? []), ...(config.groupBy ?? [])])
        checkExpression(expression)

      if (config.distinct instanceof Object) checkExpression(config.distinct.on)

      config.where = and(inGroup(config.table), config.where)

      for (const join of config.joins ?? []) {
        if ((join.joinType !== "inner" && join.joinType !== "left") || join.lateral === true)
          reject("Group queries support inner and left joins")
        checkExpression(join.on)
        join.on = and(join.on, inGroup(join.table))
      }

      return query
    })

  return { rows, group } satisfies TableAccess
})

/**
 * Records which actor type owns each declared table and checks that the
 * physical table's primary key leads with the ownership columns. A table
 * claimed by another actor type, missing, or keyed without ownership fails
 * startup instead of running unscoped.
 */
export const checkTables = Effect.fnUntraced(function* (
  actor: string,
  tables: ReadonlyArray<AnyOwnedTable>,
) {
  const sql = yield* SqlClient.SqlClient

  for (const table of tables) {
    const info = ownership(table)!

    const schema =
      info.schema ?? (yield* sql<{ schema: string }>`SELECT current_schema() AS schema`)[0]!.schema

    yield* sql`INSERT INTO actor_tables (table_schema, table_name, actor_type)
      VALUES (${schema}, ${info.table}, ${actor}) ON CONFLICT DO NOTHING`

    const [recorded] = yield* sql<{ actor_type: string }>`
      SELECT actor_type FROM actor_tables WHERE table_schema = ${schema} AND table_name = ${info.table}`

    if (recorded?.actor_type !== actor)
      return yield* Effect.die(
        new Error(`Table ${info.name} is owned by actor ${recorded?.actor_type}, not ${actor}`),
      )

    const key = yield* sql<{ name: string }>`
      SELECT a.attname AS name FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indisprimary AND i.indrelid = (
        SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${schema} AND c.relname = ${info.table})
      ORDER BY array_position(i.indkey::int2[], a.attnum)`

    const columns = getTableColumns(table)
    const expected = [...OWNERSHIP, ...info.primaryKey.map((column) => columns[column]!.name)]

    if (key.map(({ name }) => name).join() !== expected.join())
      return yield* Effect.die(
        new Error(
          `Owned table ${info.name} needs primary key (${expected.join(", ")}); apply its drizzle-kit migration`,
        ),
      )
  }
})
