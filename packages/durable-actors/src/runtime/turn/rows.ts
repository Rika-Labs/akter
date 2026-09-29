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
  noopEncoder,
  Param,
  relationsFilterToSQL,
  relationsOrderToSQL,
  SQL,
  sql as fragment,
  StringChunk,
  Table,
  type DriverValueDecoder,
  type SQLChunk,
} from "drizzle-orm"
import * as PostgresDrizzle from "drizzle-orm/effect-postgres"
import * as PgliteDrizzle from "drizzle-orm/effect-pglite"
import {
  PgSelectBase,
  type PgColumn,
  type PgSelectConfig,
  type SelectedFields,
} from "drizzle-orm/pg-core"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import { Cause, Effect, Option, Predicate } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { checkOwnedTable, inTenant, TenantScope } from "../database/tenancy.ts"
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

/**
 * Copies an application value into fresh primitives, dates, bytes, arrays, and
 * plain records. Drizzle renders anything with `getSQL` as SQL, so a function,
 * class instance, or SQL wrapper anywhere inside is rejected, and the copy
 * means a getter cannot change the value after it was checked.
 */
const copyOperand = (info: Ownership, value: Operand): Operand => {
  if (value === null || value === undefined) return value

  if (
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBigInt(value) ||
    Predicate.isBoolean(value)
  )
    return value

  const prototype = Object.getPrototypeOf(value)

  // A structured clone keeps only the time, dropping any own properties such as getSQL.
  if (prototype === Date.prototype) return structuredClone(value as Date)

  if (value instanceof Uint8Array && (prototype === Uint8Array.prototype || Buffer.isBuffer(value)))
    return Uint8Array.from(value)

  if (Array.isArray(value) && prototype === Array.prototype)
    return value.map((item: Operand) => copyOperand(info, item))

  if (!isRecord(value)) return reject(`Values on ${info.name} are plain data, not SQL or objects`)

  const copy: Record<string, Operand> = {}

  for (const key of Object.keys(value)) {
    if (key === "RAW") reject(`RAW filters on ${info.name} are not supported`)

    copy[key] = copyOperand(info, value[key])
  }

  return copy
}

const copyValues = (info: Ownership, values: OperandRecord): OperandRecord => {
  if (!isRecord(values)) reject(`Rows of ${info.name} are plain objects`)

  for (const key of Object.keys(values)) checkColumn(info, key)

  return copyOperand(info, values) as OperandRecord
}

const copyFilter = (info: Ownership, filter: Operand): OperandRecord => {
  if (!isRecord(filter)) return reject(`Filters on ${info.name} are plain objects`)

  const copy: Record<string, Operand> = {}

  for (const key of Object.keys(filter)) {
    const value = filter[key]

    if (key === "RAW") reject(`RAW filters on ${info.name} are not supported`)
    else if (key === "AND" || key === "OR") {
      if (!Array.isArray(value)) return reject(`${key} on ${info.name} takes an array`)

      copy[key] = value.map((item: Operand) => copyFilter(info, item))
    } else if (key === "NOT") copy[key] = copyFilter(info, value)
    else {
      checkColumn(info, key)
      const operand = copyOperand(info, value)

      // Drizzle reads any object here as an operator map, so a bare date or
      // byte string would match every row instead of one.
      if (operand instanceof Date || operand instanceof Uint8Array)
        reject(`Compare ${key} of ${info.name} with { eq: value }`)

      copy[key] = operand
    }
  }

  return copy
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
// fragments cannot name other tables, subqueries, or comments.
const OPERATOR_TEXT =
  /^(?:\s+|[(),*=<>!~@&|]+|and|or|not|in|is|null|like|ilike|between|asc|desc|nulls|first|last|distinct|true|false|count|sum|avg|min|max|lower|upper|coalesce)*$/i

const GROUP: Ownership = {
  name: "a group query",
  schema: undefined,
  table: "",
  columns: [],
  primaryKey: [],
  owner: undefined,
}

/**
 * Rebuilds a group query's expressions from values read once, so what was
 * checked is exactly what renders: getters, proxies, and hidden `getSQL`
 * members on the caller's objects never reach Drizzle. Columns resolve to the
 * real columns of the query's owned tables, text must be operator words with
 * balanced parentheses (the scope predicate is parenthesized beside it), and
 * parameters carry copied plain data.
 */
type Decoded = SQL & { decoder: DriverValueDecoder<unknown, unknown> }

const groupRebuilder = (tables: ReadonlyArray<AnyOwnedTable>) => {
  const column = (node: Column): PgColumn => {
    const table = (node as PgColumn & { readonly table: AnyOwnedTable }).table
    const name = node.name

    if (!tables.includes(table))
      return reject("Group queries reference columns of the tables they select from or join")

    if (reserved.includes(name))
      return reject("Group queries do not read or filter ownership columns")

    const real = Object.values(getTableColumns(table)).find((candidate) => candidate.name === name)

    return real ?? reject(`Unknown column ${name}`)
  }

  const expression = (root: Expression): Expression => {
    let depth = 0

    const walk = (node: Expression): Expression => {
      if (node === undefined) return undefined

      if (Array.isArray(node)) return node.map(walk)

      if (is(node, StringChunk)) {
        const text = String(node.value)

        if (!OPERATOR_TEXT.test(text))
          reject(`Group queries support Drizzle operators, not raw SQL: ${text}`)

        for (const character of text) {
          if (character === "(") depth += 1
          else if (character === ")") depth -= 1

          if (depth < 0) reject("Group query expressions must balance their parentheses")
        }

        return new StringChunk(text)
      }

      if (is(node, SQL.Aliased)) {
        const alias = String(node.fieldAlias)

        return new SQL.Aliased(walk(node.sql) as SQL, alias)
      }

      if (is(node, SQL)) {
        const decoder = (node as Decoded).decoder
        const rebuilt = new SQL(walk([...node.queryChunks]) as Array<SQLChunk>) as Decoded

        // A decoder only maps result values in JavaScript; a column decoder is resolved.
        rebuilt.decoder = is(decoder, Column)
          ? column(decoder)
          : { mapFromDriverValue: decoder.mapFromDriverValue.bind(decoder) }

        return rebuilt
      }

      if (is(node, Column)) return column(node)

      if (is(node, Param)) {
        const encoder = node.encoder
        const value = copyOperand(GROUP, node.value as Operand)

        if (encoder === noopEncoder) return new Param(value)

        if (is(encoder, Column)) return new Param(value, column(encoder))

        return reject("Group query parameters are plain values")
      }

      if (isEntity(node))
        return reject("Group queries cannot reference tables, subqueries, names, or placeholders")

      return copyOperand(GROUP, node as Operand) as Expression
    }

    const rebuilt = walk(root)

    if (depth !== 0) reject("Group query expressions must balance their parentheses")

    return rebuilt
  }

  const selection = (fields: SQLChunk | Selection): SQLChunk | Selection => {
    if (is(fields, Column)) return column(fields)

    if (is(fields, SQL) || is(fields, SQL.Aliased)) return expression(fields) as SQLChunk

    if (isEntity(fields) || !isRecord(fields))
      return reject("Group queries select columns and Drizzle expressions")

    const copy: Record<string, SQLChunk | Selection> = {}

    for (const key of Object.keys(fields)) copy[key] = selection((fields as Selection)[key]!)

    return copy
  }

  return { expression, selection }
}

export const bindTables = Effect.fnUntraced(function* (
  database: Option.Option<Database>,
  scope: TableScope,
  write: boolean,
  checked: ReadonlySet<AnyOwnedTable>,
) {
  const sql = yield* SqlClient.SqlClient
  const connection = yield* Effect.serviceOption(sql.transactionService)
  const { role } = yield* TenantScope

  // Writes join the turn's transaction or do not run at all.
  if (write && Option.isNone(connection))
    return yield* Effect.die(new Error("Owned rows need the turn transaction"))

  const db = Option.getOrUndefined(database)!

  const run = <A, E>(build: () => Effect.Effect<A, E>): Effect.Effect<A> =>
    Effect.andThen(scope.guard, () =>
      Option.isNone(database)
        ? Effect.die(new Error("Owned tables need a PgClient or PgliteClient database"))
        : Effect.suspend(build).pipe(
            // Reads outside a transaction, as in a stream handler, take their own tenant transaction.
            (effect) =>
              Option.isSome(connection)
                ? Effect.provideService(effect, sql.transactionService, connection.value)
                : inTenant({ sql, role, tenant: scope.ref.tenant })(effect),
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

      const copy = filter === undefined ? {} : copyFilter(info, filter as OperandRecord)

      return and(
        eq(columns["routing_key"]!, routingKey),
        eq(columns["tenant_id"]!, ref.tenant),
        eq(columns["actor_id"]!, ref.id),
        relationsFilterToSQL(table, copy as Filter<AnyOwnedTable>),
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

      return {
        info,
        list: list.map((value) => ({ ...copyValues(info, value as OperandRecord), ...owner })),
      }
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
          const copy = copyValues(check(), values as OperandRecord)

          if (Object.keys(copy).length === 0)
            reject(`An update of ${check().name} sets at least one column`)

          return db.update(table).set(copy).where(where(filter))
        }),
      delete: () => filtered((filter) => db.delete(table).where(where(filter))),
    } satisfies ScopedRows<AnyOwnedTable> as ScopedRows<AnyOwnedTable>
  }

  const inGroup = (table: AnyOwnedTable) => {
    const columns = getTableColumns(table)

    return and(eq(columns["routing_key"]!, routingKey), eq(columns["tenant_id"]!, ref.tenant))
  }

  const ownedTable = (table: PgSelectConfig["table"]): AnyOwnedTable =>
    is(table, Table) && checked.has(table as AnyOwnedTable)
      ? (table as AnyOwnedTable)
      : reject("Group queries read tables registered by an actor type, not aliases or subqueries")

  const bound = (value: PgSelectConfig["limit"]) => {
    if (value === undefined) return undefined

    if (!Predicate.isNumber(value)) return reject("Group query limits are numbers")

    return value
  }

  // The caller's select is only read, once per part; the query that runs is
  // built fresh from the framework's own client.
  const group: Group = <A>(build: Parameters<Group>[0]) =>
    run((): Effect.Effect<A, EffectDrizzleQueryError> => {
      const query = build({
        select: db.select.bind(db),
        selectDistinct: db.selectDistinct.bind(db),
      } as GroupDatabase)

      if (!is(query, PgSelectBase)) return reject("A group query is a Drizzle select")

      const config: PgSelectConfig = {
        ...(query as typeof query & { readonly config: PgSelectConfig }).config,
      }

      if ((config.withList?.length ?? 0) > 0) reject("Group queries cannot use WITH")

      if (config.setOperators.length > 0) reject("Group queries cannot use set operators")

      if (config.lockingClause !== undefined)
        reject("Group queries are read-only and take no locks")

      if (config.comment !== undefined) reject("Group queries take no SQL comments")

      if (config.distinct !== undefined && config.distinct !== false && config.distinct !== true)
        reject("Group queries support selectDistinct, not DISTINCT ON")

      const from = ownedTable(config.table)

      const joins = [...(config.joins ?? [])].map((join) => {
        const joinType = join.joinType
        const lateral = join.lateral

        if ((joinType !== "inner" && joinType !== "left") || lateral === true)
          reject("Group queries support inner and left joins")

        return { joinType, table: ownedTable(join.table), on: join.on }
      })

      const rebuild = groupRebuilder([from, ...joins.map((join) => join.table)])
      const fields = rebuild.selection(config.fields as Selection) as SelectedFields
      const where = rebuild.expression(config.where) as SQL | undefined
      const having = rebuild.expression(config.having) as SQL | undefined
      const orderBy = rebuild.expression([...(config.orderBy ?? [])]) as Array<SQL>
      const groupBy = rebuild.expression([...(config.groupBy ?? [])]) as Array<SQL>
      const limit = bound(config.limit)
      const offset = bound(config.offset)

      let fresh = (config.distinct === true ? db.selectDistinct(fields) : db.select(fields))
        .from(from)
        .$dynamic()

      for (const join of joins) {
        const on = and(rebuild.expression(join.on) as SQL | undefined, inGroup(join.table))

        fresh =
          join.joinType === "inner"
            ? fresh.innerJoin(join.table, on)
            : fresh.leftJoin(join.table, on)
      }

      fresh = fresh.where(and(inGroup(from), where))

      if (groupBy.length > 0) fresh = fresh.groupBy(...groupBy)

      if (having !== undefined) fresh = fresh.having(having)

      if (orderBy.length > 0) fresh = fresh.orderBy(...orderBy)

      if (limit !== undefined) fresh = fresh.limit(limit)

      if (offset !== undefined) fresh = fresh.offset(offset)

      const rows: Effect.Effect<unknown, EffectDrizzleQueryError> = fresh

      return rows as Effect.Effect<A, EffectDrizzleQueryError>
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
  role: string | undefined,
) {
  const sql = yield* SqlClient.SqlClient

  for (const table of tables) {
    const info = ownership(table)!

    const schema =
      info.schema ?? (yield* sql<{ schema: string }>`SELECT current_schema() AS schema`)[0]!.schema

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

    if (role !== undefined) yield* checkOwnedTable(schema, info.table, role)

    yield* sql`INSERT INTO actor_tables (table_schema, table_name, actor_type)
      VALUES (${schema}, ${info.table}, ${actor}) ON CONFLICT DO NOTHING`

    const [recorded] = yield* sql<{ actor_type: string }>`
      SELECT actor_type FROM actor_tables WHERE table_schema = ${schema} AND table_name = ${info.table}`

    if (recorded?.actor_type !== actor)
      return yield* Effect.die(
        new Error(`Table ${info.name} is owned by actor ${recorded?.actor_type}, not ${actor}`),
      )
  }
})
