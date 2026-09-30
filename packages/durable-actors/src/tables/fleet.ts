import { getTableColumns, sql } from "drizzle-orm"
import { Predicate } from "effect"
import {
  bigint,
  customType,
  doublePrecision,
  numeric,
  pgPolicy,
  pgSchema,
  pgTable,
  primaryKey,
  text,
  type PgColumn,
  type PgTableWithColumns,
} from "drizzle-orm/pg-core"
import { OWNERSHIP, ownership, type AnyOwnedTable, type Filter, type Ownership } from "./owned.ts"

/** The aggregate functions a fleet view may select. */
export type AggregateKind = "count" | "sum" | "avg" | "min" | "max"

/** One selected aggregate: `Fleet.count()` or a function of one source column. */
export interface Aggregate<
  Kind extends AggregateKind = AggregateKind,
  Key extends string = string,
> {
  readonly kind: Kind
  readonly column: Key | undefined
}

type SourceColumns<T extends AnyOwnedTable> = Omit<T["_"]["columns"], (typeof OWNERSHIP)[number]>

type Business<T extends AnyOwnedTable> = keyof SourceColumns<T> & string

type NumericKey<T extends AnyOwnedTable> = {
  [K in Business<T>]: SourceColumns<T>[K]["_"]["data"] extends number | bigint ? K : never
}[Business<T>]

type ColumnData<T extends AnyOwnedTable, K extends string> =
  K extends Business<T> ? SourceColumns<T>[K]["_"]["data"] : never

type Builder<X> = ReturnType<ReturnType<typeof customType<{ data: X; notNull: true }>>>

type NullableBuilder<X> = ReturnType<ReturnType<typeof customType<{ data: X }>>>

type AggregateBuilder<T extends AnyOwnedTable, A> =
  A extends Aggregate<"count" | "sum" | "avg", string>
    ? Builder<number>
    : A extends Aggregate<"min" | "max", infer K>
      ? NullableBuilder<ColumnData<T, K>>
      : never

/** The columns of a view's derived table, as Drizzle builders. */
export type DerivedColumns<
  T extends AnyOwnedTable,
  G extends ReadonlyArray<string>,
  S extends Record<string, Aggregate>,
> = { readonly tenant_id: Builder<string> } & {
  readonly [K in G[number]]: Builder<ColumnData<T, K>>
} & { readonly [K in keyof S]: AggregateBuilder<T, S[K]> } & {
  readonly as_of: Builder<string>
}

/** A view's derived table: `tenant_id`, the group columns, the aggregates, and `as_of`. */
export type DerivedTable<
  Name extends string,
  T extends AnyOwnedTable,
  G extends ReadonlyArray<string>,
  S extends Record<string, Aggregate>,
> = PgTableWithColumns<{
  name: Name
  schema: T["_"]["schema"]
  columns: ReturnType<typeof pgTable<Name, DerivedColumns<T, G, S>>>["_"]["columns"]
  dialect: "pg"
  isAlias: false
}>

/** What the maintainer needs to know about one selected aggregate. */
export interface SelectedAggregate {
  readonly key: string
  readonly kind: AggregateKind
  /** The source column's SQL name, or undefined for `count`. */
  readonly column: string | undefined
}

/** A declared fleet view: one group-by over one owned table, kept in `table`. */
export interface FleetView<
  Name extends string = string,
  T extends AnyOwnedTable = AnyOwnedTable,
  G extends ReadonlyArray<string> = ReadonlyArray<string>,
  S extends Record<string, Aggregate> = Record<string, Aggregate>,
> {
  readonly name: Name
  readonly from: T
  readonly source: Ownership
  readonly where: Filter<T> | undefined
  /** Group column keys of `from`, in key order. */
  readonly groupBy: G
  /** Group column SQL names, in key order. */
  readonly groupColumns: ReadonlyArray<string>
  /** The source's SQL names of its tenant and routing key columns. */
  readonly tenantColumn: string
  readonly routingColumn: string
  readonly select: S
  readonly aggregates: ReadonlyArray<SelectedAggregate>
  readonly table: DerivedTable<`fleet_${string}`, T, G, S>
  /** The derived table's name, qualified by its schema when it has one. */
  readonly tableName: string
  /** Changes when anything that decides the view's rows changes. */
  readonly definitionHash: string
}

/** Any fleet view, whatever its source and selection. */
export type AnyFleetView = FleetView<string, any, any, any>

const INTEGER = new Set(["smallint", "integer", "bigint"])

const NUMERIC = new Set(["smallint", "integer", "bigint", "real", "double precision", "numeric"])

const NAME = /^[A-Z][A-Za-z0-9]{0,47}$/

const RESERVED = new Set(["tenant_id", "as_of"])

const snake = (name: string) => name.replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase()

/** A value a view definition holds: plain data, dates, and bigints. */
type Canonical =
  | string
  | number
  | boolean
  | bigint
  | Date
  | null
  | undefined
  | ReadonlyArray<Canonical>
  | { readonly [key: string]: Canonical }

/** Canonical JSON for the definition hash: sorted keys, and bigints and dates as tagged strings. */
const canonical = (value: Canonical): string => {
  if (Predicate.isBigInt(value)) return JSON.stringify(`${value}n`)

  if (Predicate.isDate(value)) return JSON.stringify(`date:${value.toISOString()}`)

  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`

  if (Predicate.isObject(value))
    return `{${Object.entries(value as { readonly [key: string]: Canonical })
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`

  return JSON.stringify(value ?? null)
}

const cloneColumn = (column: PgColumn, name: string) =>
  customType<{ data: unknown }>({
    dataType: () => column.getSQLType(),
    fromDriver: (value) => column.mapFromDriverValue(value),
    toDriver: (value) => column.mapToDriverValue(value),
  })(name)

/**
 * Declares a fleet view: `groupBy` over the rows of one owned table that
 * `where` admits, with `tenant_id` always the first group key, so a view
 * never aggregates across tenants. The runtime maintains its rows in `table`,
 * named `fleet_<snake_case name>` in the source's schema, which the application
 * adds to its drizzle-kit schema like an owned table.
 *
 * Throws for a name that is not PascalCase, a source that is not an owned
 * table, an unknown or nullable group column (a primary key cannot hold
 * null), an ownership column, an empty or overlapping selection, `sum` over a
 * non-integer column, and `avg` over a non-numeric one.
 *
 * @example
 * const OrdersByStatus = Fleet.view("OrdersByStatus", {
 *   from: OrderRows,
 *   where: { archived: false },
 *   groupBy: ["status"],
 *   select: { orders: Fleet.count(), total: Fleet.sum("amountCents") },
 * })
 */
const view = <
  const Name extends string,
  T extends AnyOwnedTable,
  const G extends ReadonlyArray<Business<T>>,
  const S extends Record<string, Aggregate<AggregateKind, Business<T>>>,
>(
  name: Name,
  definition: {
    readonly from: T
    readonly where?: Filter<T>
    readonly groupBy: G
    readonly select: S & {
      readonly [K in keyof S]: S[K] extends Aggregate<"sum" | "avg", infer Key>
        ? Aggregate<S[K]["kind"], Key & NumericKey<T>>
        : S[K]
    }
  },
): FleetView<Name, T, G, S> => {
  if (!NAME.test(name))
    throw new Error(`Fleet view name ${name} is PascalCase, at most 48 characters`)

  const source = ownership(definition.from)

  if (source === undefined) throw new Error(`Fleet view ${name} reads an Actor.table`)

  const columns = getTableColumns(definition.from) as Record<string, PgColumn>
  const reserved: ReadonlyArray<string> = OWNERSHIP

  const business = (key: string, role: string) => {
    if (reserved.includes(key) || source.ownerKeys.includes(key) || !source.columns.includes(key))
      throw new Error(
        `Fleet view ${name}: ${role} ${key} is not a business column of ${source.name}`,
      )

    return columns[key]!
  }

  if (definition.groupBy.length === 0)
    throw new Error(`Fleet view ${name} groups by at least one column`)

  if (new Set(definition.groupBy).size !== definition.groupBy.length)
    throw new Error(`Fleet view ${name} lists a group column twice`)

  const groupColumns = definition.groupBy.map((key) => {
    const column = business(key, "group column")

    if (!column.notNull) throw new Error(`Fleet view ${name}: group column ${key} must be NOT NULL`)

    return column.name
  })

  const selected = Object.entries(definition.select as Record<string, Aggregate>)

  if (selected.length === 0) throw new Error(`Fleet view ${name} selects at least one aggregate`)

  const taken = new Set([...RESERVED, ...groupColumns, ...definition.groupBy])

  const aggregates = selected.map(([key, aggregate]): SelectedAggregate => {
    if (taken.has(key) || !/^[a-z][a-z0-9_]*$/i.test(key))
      throw new Error(
        `Fleet view ${name}: aggregate ${key} clashes with a column or is not a plain name`,
      )

    if (aggregate.kind === "count") return { key, kind: "count", column: undefined }

    const column = business(aggregate.column ?? "", `${aggregate.kind} column`)
    const type = column.getSQLType().replace(/\(.*\)$/, "")

    if (aggregate.kind === "sum" && !INTEGER.has(type))
      throw new Error(`Fleet view ${name}: sum takes an integer column, not ${key} (${type})`)

    if (aggregate.kind === "avg" && !NUMERIC.has(type))
      throw new Error(`Fleet view ${name}: avg takes a numeric column, not ${key} (${type})`)

    return { key, kind: aggregate.kind, column: column.name }
  })

  if (source.routingKey === undefined)
    throw new Error(
      `Fleet view ${name} reads ${source.name}, adopted for reading only; a view recomputes by routing_key, so adopt it with access "write"`,
    )

  const tenantColumn = source.ownerColumns[source.ownerKeys.indexOf(source.tenantKey)]!
  const routingColumn = columns[source.routingKey]!.name
  const tableName = `fleet_${snake(name)}`

  const derived = {
    tenant_id: text("tenant_id").notNull(),
    ...Object.fromEntries(
      definition.groupBy.map((key, index) => [
        key,
        cloneColumn(columns[key]!, groupColumns[index]!).notNull(),
      ]),
    ),
    ...Object.fromEntries(
      aggregates.map(({ key, kind, column }) => [
        key,
        kind === "count" || kind === "sum"
          ? bigint(key, { mode: "number" }).notNull()
          : kind === "avg"
            ? doublePrecision(key).notNull()
            : cloneColumn(
                columns[Object.keys(columns).find((k) => columns[k]!.name === column)!]!,
                key,
              ),
      ]),
    ),
    as_of: numeric("as_of").notNull(),
  }

  const extra = (self: Record<string, PgColumn>) => {
    const scoped = sql`tenant_id = current_setting('durable.tenant', true)`
    const [first, ...rest] = [self["tenant_id"]!, ...definition.groupBy.map((key) => self[key]!)]

    return [
      primaryKey({ columns: [first!, ...rest] }),
      pgPolicy("durable_tenant", { for: "all", using: scoped, withCheck: scoped }),
    ]
  }

  const table = (
    source.schema === undefined
      ? pgTable(tableName, derived, extra)
      : pgSchema(source.schema).table(tableName, derived, extra)
  ) as DerivedTable<`fleet_${string}`, T, G, S>

  const where = definition.where

  const definitionHash = new Bun.CryptoHasher("sha256")
    .update(
      canonical({
        source: source.name,
        owner: [routingColumn, tenantColumn],
        where: (where ?? null) as Canonical,
        groupBy: groupColumns,
        select: aggregates.map(({ key, kind, column }) => ({ key, kind, column })),
        table: tableName,
      }),
    )
    .digest("hex")

  return {
    name,
    from: definition.from,
    source,
    where,
    groupBy: definition.groupBy,
    groupColumns,
    tenantColumn,
    routingColumn,
    select: definition.select,
    aggregates,
    table,
    tableName: source.schema === undefined ? tableName : `${source.schema}.${tableName}`,
    definitionHash,
  }
}

/** Counts the group's rows. */
const count = (): Aggregate<"count", never> => ({ kind: "count", column: undefined })

/** Sums an integer column into a bigint; a sum past its range poisons the view. */
const sum = <const K extends string>(column: K): Aggregate<"sum", K> => ({
  kind: "sum",
  column,
})

/** Averages a numeric column as double precision. */
const avg = <const K extends string>(column: K): Aggregate<"avg", K> => ({
  kind: "avg",
  column,
})

/** The smallest value of a column, in the column's own type. */
const min = <const K extends string>(column: K): Aggregate<"min", K> => ({
  kind: "min",
  column,
})

/** The largest value of a column, in the column's own type. */
const max = <const K extends string>(column: K): Aggregate<"max", K> => ({
  kind: "max",
  column,
})

/**
 * Fleet reads: declared views over one owned table of a tenant-placed actor
 * type, grouped by tenant first and maintained from the change feed, outside
 * every turn.
 */
export const Fleet = {
  /** Declares a fleet view; see `view`. */
  view,
  /** Counts a group's rows. */
  count,
  /** Sums an integer column. */
  sum,
  /** Averages a numeric column. */
  avg,
  /** The smallest value of a column. */
  min,
  /** The largest value of a column. */
  max,
}
