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
import { SqlClient, SqlError } from "effect/sql"
import { checkAdoptedTable, checkOwnedTable, inTenant, TenantScope } from "../database/tenancy.ts"
import { checkEnforcedTable, checkWriterRole } from "../adoption/startup.ts"
import { ownerIndexExists, ownerIndexSql } from "../adoption/plan.ts"
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

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const reject = (message: string): never => {
  throw new Error(message)
}

const checkColumn = (info: Ownership, key: string, write: boolean) => {
  if (info.ownerKeys.includes(key) && (write || !info.adopted || key === info.routingKey))
    reject(`Ownership column ${key} of ${info.name} comes from the turn, not the application`)

  if (!info.columns.includes(key)) reject(`Unknown column ${key} of ${info.name}`)
}

/**
 * Copies an application value into fresh primitives, dates, bytes, arrays, and
 * plain records. Drizzle renders anything with `getSQL` as SQL, so a function,
 * class instance, or SQL wrapper anywhere inside is rejected, and the copy
 * means a getter cannot change the value after it was checked. Dates are
 * structured-cloned so own properties such as `getSQL` are dropped.
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

  for (const key of Object.keys(values)) checkColumn(info, key, true)

  return copyOperand(info, values) as OperandRecord
}

/**
 * Copies a filter, rejecting `RAW` and reserved columns. A bare date or byte
 * string as a column's value is refused because Drizzle reads any object there
 * as an operator map and would match every row instead of one.
 */
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
      checkColumn(info, key, false)
      const operand = copyOperand(info, value)

      if (operand instanceof Date || operand instanceof Uint8Array)
        reject(`Compare ${key} of ${info.name} with { eq: value }`)

      copy[key] = operand
    }
  }

  return copy
}

/**
 * Renders an application filter on `table` as SQL after `copyFilter` has
 * checked and copied it, for reads the framework builds outside a turn.
 */
export const filterSql = ({
  table,
  filter,
}: {
  readonly table: AnyOwnedTable
  readonly filter: Filter<AnyOwnedTable>
}) => {
  const info = ownership(table)

  if (info === undefined) return reject("Filters apply to owned tables")

  return relationsFilterToSQL(table, copyFilter(info, filter as Operand) as Filter<AnyOwnedTable>)
}

const checkOrder = (info: Ownership, order: Order<AnyOwnedTable>) => {
  for (const [key, direction] of Object.entries(order)) {
    checkColumn(info, key, false)

    if (direction !== "asc" && direction !== "desc")
      reject(`Order on ${info.name} is "asc" or "desc"`)
  }
}

/**
 * The words Drizzle's comparison, boolean, pattern, and aggregate operators
 * emit; any other SQL text in a group query is rejected so raw fragments
 * cannot name other tables, subqueries, or comments.
 */
const OPERATOR_TEXT =
  /^(?:\s+|[(),*=<>!~@&|]+|and|or|not|in|is|null|like|ilike|between|asc|desc|nulls|first|last|distinct|true|false|count|sum|avg|min|max|lower|upper|coalesce)*$/i

const GROUP: Ownership = {
  name: "a group query",
  schema: undefined,
  table: "",
  columns: [],
  primaryKey: [],
  owner: undefined,
  adopted: false,
  access: "read",
  ownerKeys: [],
  ownerColumns: [],
  routingKey: undefined,
  tenantKey: "",
  actorKey: "",
  tenantKind: "text",
  actorKind: "text",
  placement: undefined,
}

type Decoded = SQL & { decoder: DriverValueDecoder<unknown, unknown> }

/**
 * Rebuilds a group query's expressions from values read once, so what was
 * checked is exactly what renders: getters, proxies, and hidden `getSQL`
 * members on the caller's objects never reach Drizzle. Columns resolve to the
 * real columns of the query's owned tables, text must be operator words with
 * balanced parentheses (the scope predicate is parenthesized beside it), and
 * parameters carry copied plain data. A decoder only maps result values in
 * JavaScript, so it is rebound rather than trusted; a column decoder resolves
 * like any other column.
 */
const groupRebuilder = (tables: ReadonlyArray<AnyOwnedTable>) => {
  const column = (node: Column): PgColumn => {
    const table = (node as PgColumn & { readonly table: AnyOwnedTable }).table
    const name = node.name

    if (!tables.includes(table))
      return reject("Group queries reference columns of the tables they select from or join")

    if (ownership(table)!.ownerColumns.includes(name))
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

/**
 * Binds owned-table reads and, when `write` is set, mutations to one turn's
 * actor. Writes join the turn's transaction or fail; reads outside a
 * transaction, as in a stream handler, run in their own tenant transaction.
 * Drizzle wraps driver failures, so the inner `SqlError` is surfaced to let it
 * decide between a retried turn and a deterministic defect. Off-turn contexts
 * get no mutation methods at all, whatever their static type. A group query is
 * read once per part and re-built from the framework's own client, so the
 * caller's select object never runs.
 */
export const bindTables = Effect.fnUntraced(function* (
  database: Option.Option<Database>,
  scope: TableScope,
  write: boolean,
  checked: ReadonlySet<AnyOwnedTable>,
) {
  const sql = yield* SqlClient.SqlClient
  const connection = yield* Effect.serviceOption(sql.transactionService)
  const { role } = yield* TenantScope

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
                : inTenant({ sql, role, tenant: scope.ref.tenant })(effect),
            Effect.catch((error) => {
              const wrapped = Predicate.hasProperty(error, "cause") ? error.cause : undefined
              const cause = Cause.isCause(wrapped) ? Cause.squash(wrapped) : wrapped

              return Effect.die(SqlError.isSqlError(cause) ? cause : error)
            }),
          ),
    )

  const { ref } = scope
  const routingKey = routingKeyOf({ ref, placement: scope.placement })

  const ownerOf = (info: Ownership) => {
    const owner = { [info.tenantKey]: ref.tenant, [info.actorKey]: ref.id }

    if (info.routingKey === undefined) return owner

    return { ...owner, [info.routingKey]: routingKey }
  }

  /**
   * Off-turn contexts and read-adopted tables get no mutation methods at all,
   * whatever their static type.
   */
  const rows = (table: AnyOwnedTable): ScopedRead<AnyOwnedTable> => {
    const info = ownership(table)

    const check = () => {
      if (info === undefined || !scope.tables.includes(table))
        reject(`${info?.name ?? "This table"} is not an owned table of ${ref.actor}`)

      if (info!.tenantKind === "uuid" && !CANONICAL_UUID.test(ref.tenant))
        reject(
          `${info!.name} maps a uuid tenant column, and tenant ${ref.tenant} is not a lowercase uuid`,
        )

      if (info!.actorKind === "uuid" && !CANONICAL_UUID.test(ref.id))
        reject(
          `${info!.name} maps a uuid actor column, and actor id ${ref.id} is not a lowercase uuid`,
        )

      return info!
    }

    const columns = getTableColumns(table)

    const where = (filter: Filter<AnyOwnedTable> | undefined) => {
      const info = check()

      const copy = filter === undefined ? {} : copyFilter(info, filter as OperandRecord)

      return and(
        info.routingKey === undefined ? undefined : eq(columns[info.routingKey]!, routingKey),
        eq(columns[info.tenantKey]!, ref.tenant),
        eq(columns[info.actorKey]!, ref.id),
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

      const owner = ownerOf(info)

      return {
        info,
        list: list.map((value) => ({ ...copyValues(info, value as OperandRecord), ...owner })),
      }
    }

    const wrote = Effect.sync(() => scope.wrote?.(check().name))

    const filtered = <A, E>(
      mutation: (filter: Filter<AnyOwnedTable>) => Effect.Effect<A, E>,
    ): Filtered<AnyOwnedTable> => ({
      where: (filter) =>
        run(() => mutation(filter)).pipe(
          Effect.tap(() => wrote),
          Effect.asVoid,
        ),
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

    if (!write || info?.access === "read") return read

    return {
      ...read,
      insert: (values) =>
        run(() => {
          const { list } = prepare(values)

          return list.length === 0 ? Effect.void : db.insert(table).values(list)
        }).pipe(
          Effect.tap(() => wrote),
          Effect.asVoid,
        ),
      upsert: (values) =>
        run(() => {
          const { info, list } = prepare(values)

          if (list.length === 0) return Effect.void

          const target = (info.adopted ? info.primaryKey : [...OWNERSHIP, ...info.primaryKey]).map(
            (key) => columns[key]!,
          )

          const set: Record<string, SQL> = Object.fromEntries(
            [...new Set(list.flatMap((value) => Object.keys(value)))].flatMap((key) =>
              info.primaryKey.includes(key) || (info.ownerKeys.includes(key) && !info.adopted)
                ? []
                : [[key, fragment`excluded.${fragment.identifier(columns[key]!.name)}`]],
            ),
          )

          const insert = db.insert(table).values(list)

          if (!info.adopted)
            return Object.keys(set).length === 0
              ? insert.onConflictDoNothing({ target })
              : insert.onConflictDoUpdate({ target, set })

          delete set[info.tenantKey]
          delete set[info.actorKey]

          const first = columns[info.primaryKey[0]!]!

          const applied = insert
            .onConflictDoUpdate({
              target,
              set:
                Object.keys(set).length === 0
                  ? { [info.primaryKey[0]!]: fragment`excluded.${fragment.identifier(first.name)}` }
                  : set,
              setWhere: and(
                eq(columns[info.tenantKey]!, ref.tenant),
                eq(columns[info.actorKey]!, ref.id),
              ),
            })
            .returning({ key: first })

          return applied.pipe(
            Effect.flatMap((written) =>
              written.length === list.length
                ? Effect.void
                : Effect.die(
                    new Error(
                      `An upsert of ${info.name} reached a primary key that belongs to another actor`,
                    ),
                  ),
            ),
          )
        }).pipe(
          Effect.tap(() => wrote),
          Effect.asVoid,
        ),
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
    const info = ownership(table)!

    return and(eq(columns[info.routingKey!]!, routingKey), eq(columns[info.tenantKey]!, ref.tenant))
  }

  const ownedTable = (table: PgSelectConfig["table"]): AnyOwnedTable => {
    if (!is(table, Table) || !checked.has(table as AnyOwnedTable))
      return reject(
        "Group queries read tables registered by an actor type, not aliases or subqueries",
      )

    if (ownership(table)!.access === "read")
      return reject("Group queries cannot read a table adopted for reading only")

    return table as AnyOwnedTable
  }

  const bound = (value: PgSelectConfig["limit"]) => {
    if (value === undefined) return undefined

    if (!Predicate.isNumber(value)) return reject("Group query limits are numbers")

    return value
  }

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
 * Refuses an adopted table whose physical state does not match its
 * declaration: a writable one needs its `actor_adoptions` row (which
 * `durable adopt observe` writes) with the declared type and columns and a
 * bigint `routing_key`; every adopted table needs mapped columns of a mappable
 * type and an index that leads with them. Each message names the fix.
 */
const checkAdoptedDeclaration = Effect.fnUntraced(function* ({
  actor,
  table,
  info,
  schema,
  role,
  adoption,
}: {
  readonly actor: string
  readonly table: AnyOwnedTable
  readonly info: Ownership
  readonly schema: string
  readonly role: string | undefined
  readonly adoption: AdoptionStartup
}) {
  const sql = yield* SqlClient.SqlClient
  const columns = getTableColumns(table)
  const tenantColumn = columns[info.tenantKey]!.name
  const actorColumn = columns[info.actorKey]!.name
  const refuse = (message: string) => Effect.die(new Error(`Adopted table ${info.name} ${message}`))

  const physical = yield* sql<{ name: string; type: string }>`
    SELECT a.attname AS name, t.typname AS type FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t ON t.oid = a.atttypid
    WHERE n.nspname = ${schema} AND c.relname = ${info.table} AND a.attnum > 0 AND NOT a.attisdropped`

  if (physical.length === 0) return yield* refuse("does not exist")

  for (const [column, kind] of [
    [tenantColumn, info.tenantKind],
    [actorColumn, info.actorKind],
  ] as const) {
    const found = physical.find((candidate) => candidate.name === column)

    if (found === undefined) return yield* refuse(`has no column ${column}`)

    if (
      (found.type === "uuid") !== (kind === "uuid") ||
      !["text", "varchar", "uuid"].includes(found.type)
    )
      return yield* refuse(
        `maps ${column}, which is ${found.type}, not the declared ${kind} column`,
      )
  }

  let enforcement:
    | { readonly writerRole: string; readonly allowedRoles: ReadonlyArray<string> }
    | undefined

  if (info.access === "write") {
    const [recorded] = yield* sql<{
      actor_type: string
      tenant_column: string
      actor_column: string
      mode: string
      writer_role: string | null
      allowed_roles: ReadonlyArray<string>
    }>`SELECT actor_type, tenant_column, actor_column, mode, writer_role, allowed_roles
      FROM actor_adoptions WHERE table_schema = ${schema} AND table_name = ${info.table}`

    if (recorded === undefined)
      return yield* refuse(
        `has no adoption record; run durable adopt observe ${info.table} before serving it`,
      )

    if (recorded.actor_type !== actor)
      return yield* refuse(`is adopted by actor ${recorded.actor_type}, not ${actor}`)

    if (recorded.tenant_column !== tenantColumn || recorded.actor_column !== actorColumn)
      return yield* refuse(
        `was adopted with columns (${recorded.tenant_column}, ${recorded.actor_column}) but declares (${tenantColumn}, ${actorColumn}); run durable adopt observe ${info.table} again`,
      )

    if (recorded.mode === "enforce")
      enforcement = { writerRole: recorded.writer_role!, allowedRoles: recorded.allowed_roles }

    const routing = physical.find((candidate) => candidate.name === "routing_key")

    if (routing?.type !== "int8")
      return yield* refuse(`has no bigint routing_key; run durable adopt observe ${info.table}`)
  }

  const target = {
    schema,
    table: info.table,
    access: info.access,
    tenantColumn,
    actorColumn,
  }

  if (!(yield* ownerIndexExists(target)))
    return yield* refuse(
      `needs an index that leads with its owner columns: ${ownerIndexSql(target)}`,
    )

  if (role !== undefined)
    yield* checkAdoptedTable(schema, info.table, role, info.access === "write")

  if (enforcement === undefined || !adoption.writes) return enforcement !== undefined

  if (role !== undefined && role !== enforcement.writerRole)
    return yield* refuse(
      `is enforced for writer role ${enforcement.writerRole}, but row-level security takes ${role}; both options must name the same role`,
    )

  yield* checkEnforcedTable({
    target: { schema, table: info.table, tenantColumn, actorColumn, actor },
    ...enforcement,
    runtimeRole: adoption.role,
    refuse,
  })

  return true
})

/** How a layer registers adopted tables: its writer role, and whether the registering layer writes them. */
export interface AdoptionStartup {
  readonly role: string | undefined
  readonly writes: boolean
}

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
  adoption: AdoptionStartup,
) {
  const sql = yield* SqlClient.SqlClient
  const guarded: Array<{ readonly schema: string; readonly table: string }> = []
  let enforced = false

  for (const table of tables) {
    const info = ownership(table)!

    const schema =
      info.schema ?? (yield* sql<{ schema: string }>`SELECT current_schema() AS schema`)[0]!.schema

    guarded.push({ schema, table: info.table })

    if (info.adopted) {
      const isEnforced = yield* checkAdoptedDeclaration({
        actor,
        table,
        info,
        schema,
        role,
        adoption,
      })

      if (isEnforced && adoption.writes) enforced = true

      yield* sql`INSERT INTO actor_tables (table_schema, table_name, actor_type)
        VALUES (${schema}, ${info.table}, ${actor}) ON CONFLICT DO NOTHING`

      const [claimed] = yield* sql<{ actor_type: string }>`
        SELECT actor_type FROM actor_tables WHERE table_schema = ${schema} AND table_name = ${info.table}`

      if (claimed?.actor_type !== actor)
        return yield* Effect.die(
          new Error(`Table ${info.name} is owned by actor ${claimed?.actor_type}, not ${actor}`),
        )

      continue
    }

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

  if (!enforced) return false

  yield* checkWriterRole({
    role: adoption.role!,
    tables: guarded,
    refuse: (message) => Effect.die(new Error(`Adoption writer role: ${message}`)),
  })

  return true
})
