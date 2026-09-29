import { is, sql, type InferInsertModel, type InferSelectModel, type SQL } from "drizzle-orm"
import {
  bigint,
  ForeignKeyBuilder,
  IndexBuilder,
  pgPolicy,
  PgTable,
  PrimaryKeyBuilder,
  primaryKey,
  text,
  unique,
  UniqueConstraintBuilder,
  type AnyPgTable,
  type ExtraConfigColumn,
  type PgColumn,
  type PgSelectConfig,
  type PgTableExtraConfigValue,
  type PgTableWithColumns,
} from "drizzle-orm/pg-core"
import type { BuildColumns } from "drizzle-orm/column-builder"
import type { RelationsOrder, TableFilter } from "drizzle-orm/relations"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres"
import type { Effect, Option } from "effect"
import type { ActorRef } from "../identity/caller.ts"
import type { Placement } from "../runtime/storage/codec.ts"

/** Ownership column keys, which are also their SQL names. */
export const OWNERSHIP = ["routing_key", "tenant_id", "actor_id"] as const

type OwnershipKey = (typeof OWNERSHIP)[number]

const ownershipColumns = () => ({
  routing_key: bigint("routing_key", { mode: "bigint" }).notNull(),
  tenant_id: text("tenant_id").notNull(),
  actor_id: text("actor_id").notNull(),
})

type OwnershipColumns<Name extends string> = BuildColumns<
  Name,
  ReturnType<typeof ownershipColumns>,
  "pg"
>

const NameKey: unique symbol = Symbol.for("drizzle:Name")

const SchemaKey: unique symbol = Symbol.for("drizzle:Schema")

const ColumnsKey: unique symbol = Symbol.for("drizzle:Columns")

const ExtraColumnsKey: unique symbol = Symbol.for("drizzle:ExtraConfigColumns")

const ExtraConfigKey: unique symbol = Symbol.for("drizzle:ExtraConfigBuilder")

const IsAliasKey: unique symbol = Symbol.for("drizzle:IsAlias")

const ForeignKeysKey: unique symbol = Symbol.for("drizzle:PgInlineForeignKeys")

interface BuiltColumn extends PgColumn {
  primary: boolean
  isUnique: boolean
  readonly uniqueName: string | undefined
  readonly uniqueType: "distinct" | "not distinct" | undefined
}

type ExtraColumns = Record<string, ExtraConfigColumn>

type ExtraConfig = (
  self: ExtraColumns,
) => ReadonlyArray<PgTableExtraConfigValue | ReadonlyArray<PgTableExtraConfigValue>>

/**
 * The Drizzle table internals `table` rewrites. Drizzle keeps them under
 * registered symbols and drizzle-kit reads the same ones, so the ownership
 * columns appear in generated SQL.
 */
interface TableInternals {
  readonly [NameKey]: string
  readonly [SchemaKey]: string | undefined
  [ColumnsKey]: Record<string, BuiltColumn>
  [ExtraColumnsKey]: ExtraColumns
  [ExtraConfigKey]: ExtraConfig | undefined
  readonly [IsAliasKey]: boolean
  readonly [ForeignKeysKey]: ReadonlyArray<ForeignKeyBuilder>
}

interface KeyBuilder {
  readonly columns: ReadonlyArray<ExtraConfigColumn>
  readonly name: string | undefined
}

interface Prefixable {
  columns: Array<ExtraConfigColumn | SQL>
}

interface ColumnBuilderInternals {
  readonly setName: (name: string) => void
  readonly build: (table: AnyPgTable) => { readonly postBuild: () => PgColumn }
  readonly buildExtraConfigColumn: (table: AnyPgTable) => ExtraConfigColumn
}

declare const OwnedTypeId: unique symbol

/** Ownership lives beside the table, keyed by the table object itself, so no other object can claim it by copying a property or symbol. */
const owned = new WeakMap<object, Ownership>()

/** What the framework knows about an owned table; aliases forward it. */
export interface Ownership {
  /** The table name, qualified by its schema when it has one. */
  readonly name: string
  readonly schema: string | undefined
  readonly table: string
  /** Business column keys, excluding ownership columns. */
  readonly columns: ReadonlyArray<string>
  /** Business primary key column keys, in key order. */
  readonly primaryKey: ReadonlyArray<string>
  /** The actor type listing this table; set once by `Actor.make`. */
  owner: string | undefined
}

/**
 * A Drizzle table owned by one actor type. Every row carries the trusted
 * `routing_key`, `tenant_id`, and `actor_id` of the actor that wrote it, and
 * every primary key, unique constraint, and index leads with them.
 */
export type OwnedTable<T extends AnyPgTable> = PgTableWithColumns<{
  name: T["_"]["name"]
  schema: T["_"]["schema"]
  columns: T["_"]["columns"] & OwnershipColumns<T["_"]["name"]>
  dialect: "pg"
  isAlias: false
}> & { readonly [OwnedTypeId]: Ownership }

/** Any owned table, whatever its columns. */
export type AnyOwnedTable = AnyPgTable & { readonly [OwnedTypeId]: Ownership }

type BusinessColumns<T extends AnyOwnedTable> = Omit<T["_"]["columns"], OwnershipKey>

/** A row as application code reads it: business columns only. */
export type Row<T extends AnyOwnedTable> = Omit<InferSelectModel<T>, OwnershipKey>

/** A row as application code writes it: business columns only. */
export type Insert<T extends AnyOwnedTable> = Omit<InferInsertModel<T>, OwnershipKey>

/** Drizzle's object filter over business columns; `RAW` SQL is not supported. */
export type Filter<T extends AnyOwnedTable> = Omit<TableFilter<T, BusinessColumns<T>>, "RAW">

/** Drizzle's ordering over business columns. */
export type Order<T extends AnyOwnedTable> = RelationsOrder<BusinessColumns<T>>

/** Options for reading one row: a filter and an ordering, both over business columns. */
export interface ReadOptions<T extends AnyOwnedTable> {
  readonly where?: Filter<T>
  readonly orderBy?: Order<T>
}

/** Options for reading many rows: a filter, an ordering, and a page. */
export interface ListOptions<T extends AnyOwnedTable> extends ReadOptions<T> {
  readonly limit?: number
  readonly offset?: number
}

/** Read-only access to the current actor's rows of one owned table. */
export interface ScopedRead<T extends AnyOwnedTable> {
  /** The first row matching `options`, or none. */
  readonly one: (options?: ReadOptions<T>) => Effect.Effect<Option.Option<Row<T>>>
  /** Every matching row, at most `limit` after skipping `offset`. */
  readonly all: (options?: ListOptions<T>) => Effect.Effect<ReadonlyArray<Row<T>>>
  /** The number of matching rows. */
  readonly count: (options?: { readonly where?: Filter<T> }) => Effect.Effect<number>
}

/** A mutation that runs once it is given its filter; `{}` matches every row of the actor. */
export interface Filtered<T extends AnyOwnedTable> {
  readonly where: (filter: Filter<T>) => Effect.Effect<void>
}

/** Turn-bound access to the current actor's rows; writes commit or roll back with the turn. */
export interface ScopedRows<T extends AnyOwnedTable> extends ScopedRead<T> {
  /** Inserts one row or a list of rows. */
  readonly insert: (values: Insert<T> | ReadonlyArray<Insert<T>>) => Effect.Effect<void>
  /** Inserts, or on a primary key conflict updates the supplied non-key columns. */
  readonly upsert: (values: Insert<T> | ReadonlyArray<Insert<T>>) => Effect.Effect<void>
  /** Sets `values` on the rows the returned filter matches. */
  readonly update: (values: Partial<Insert<T>>) => Filtered<T>
  /** Deletes the rows the returned filter matches. */
  readonly delete: () => Filtered<T>
}

/** The read-only Drizzle surface a group query is built from. */
export type GroupDatabase = Pick<EffectPgDatabase, "select" | "selectDistinct">

/**
 * Read-only joins across the owned rows of every actor sharing this actor's
 * placement group. The framework adds the group predicate to the base table
 * and to every inner or left join.
 */
export type Group = <A>(
  build: (database: GroupDatabase) => Effect.Effect<A, EffectDrizzleQueryError>,
) => Effect.Effect<A>

/** Who the rows belong to and how long a bound capability lives. */
export interface TableScope {
  readonly ref: ActorRef
  readonly placement: Placement
  /** The tables the actor type declares; `rows` refuses any other. */
  readonly tables: ReadonlyArray<AnyOwnedTable>
  /** Dies once the capability is used outside the turn or query that received it. */
  readonly guard: Effect.Effect<void>
}

/** The table capabilities of one turn or query. */
export interface TableAccess {
  /** Turn-bound access returns the full `ScopedRows`; read access only `ScopedRead`. */
  readonly rows: (table: AnyOwnedTable) => ScopedRead<AnyOwnedTable>
  readonly group: Group
}

/** The ownership of `table`, or undefined when it is not an owned table. */
export const ownership = (table: PgSelectConfig["table"]): Ownership | undefined => owned.get(table)

const isOwned = <T extends AnyPgTable>(table: T): table is T & OwnedTable<T> =>
  ownership(table) !== undefined

const flatten = (config: ExtraConfig | undefined, self: ExtraColumns) =>
  (config?.(self) ?? []).flat()

/**
 * Declares an actor-owned Drizzle table. The table gains `routing_key`,
 * `tenant_id`, and `actor_id` columns; its primary key, unique constraints, and
 * indexes are prefixed with them, so drizzle-kit generates keys that are
 * unique per actor and scans that stay on one shard. Each table also carries
 * the `durable_tenant` row-level-security policy: the table owner is exempt,
 * and a runtime with row-level security sees only each transaction's tenant.
 *
 * Throws for anything but a `pgTable`, an alias, an already owned table, a
 * table with a reserved ownership column, a table without a primary key, or a
 * foreign key, which would cross actors and need ownership columns on both
 * sides. Column-level `primaryKey` and `unique` would be global, so they move
 * into the prefixed extra config. Only btree indexes are accepted: other
 * methods cannot lead with the bigint and text ownership prefix.
 *
 * @example
 * const Notes = Actor.table(pgTable("notes", { id: text("id").primaryKey(), body: text("body") }))
 */
export const table = <T extends AnyPgTable>(source: T): OwnedTable<T> => {
  if (!is(source, PgTable)) throw new Error("Actor.table takes a pgTable")
  const internals = source as T & TableInternals
  const name = internals[NameKey]

  if (internals[IsAliasKey]) throw new Error(`Actor.table takes a table, not an alias: ${name}`)

  if (ownership(source) !== undefined) throw new Error(`Table ${name} is already owned`)

  const columns = internals[ColumnsKey]
  const reserved: ReadonlyArray<string> = OWNERSHIP

  for (const [key, column] of Object.entries(columns))
    if (reserved.includes(key) || reserved.includes(column.name))
      throw new Error(`Column ${key} of ${name} is reserved for ownership`)

  if (internals[ForeignKeysKey].length > 0)
    throw new Error(`Owned table ${name} cannot declare foreign keys`)

  const extraColumns = internals[ExtraColumnsKey]
  const declared = internals[ExtraConfigKey]
  const keyOf = new Map(Object.entries(columns).map(([key, column]) => [column.name, key]))
  let composite: ReadonlyArray<string> | undefined

  for (const builder of flatten(declared, extraColumns)) {
    if (is(builder, ForeignKeyBuilder))
      throw new Error(`Owned table ${name} cannot declare foreign keys`)

    if (is(builder, PrimaryKeyBuilder))
      composite = (builder as PrimaryKeyBuilder & KeyBuilder).columns.map(
        (column) => keyOf.get(column.name) ?? column.name,
      )
  }

  const columnKey = Object.entries(columns).filter(([, column]) => column.primary)
  const key = composite ?? columnKey.map(([key]) => key)

  if (key.length === 0) throw new Error(`Owned table ${name} needs a primary key`)

  const uniques = Object.entries(columns).filter(([, column]) => column.isUnique)

  for (const [, column] of columnKey) column.primary = false

  for (const [, column] of uniques) column.isUnique = false

  const built: Record<string, BuiltColumn> = {}
  const builtExtra: ExtraColumns = {}

  for (const [key, builder] of Object.entries(ownershipColumns())) {
    const internal = builder as typeof builder & ColumnBuilderInternals
    internal.setName(key)
    built[key] = internal.build(source).postBuild() as BuiltColumn
    builtExtra[key] = internal.buildExtraConfigColumn(source)
  }

  Object.assign(source, built)
  internals[ColumnsKey] = { ...built, ...columns }
  internals[ExtraColumnsKey] = { ...builtExtra, ...extraColumns }

  internals[ExtraConfigKey] = (self) => {
    const owner = OWNERSHIP.map((key) => self[key]!)
    const result: Array<PgTableExtraConfigValue> = []
    let primaryName: string | undefined

    for (const builder of flatten(declared, self)) {
      if (is(builder, PrimaryKeyBuilder)) {
        primaryName = (builder as PrimaryKeyBuilder & KeyBuilder).name
        continue
      }

      if (is(builder, IndexBuilder)) {
        const config = (
          builder as IndexBuilder & { readonly config: Prefixable & { readonly method?: string } }
        ).config

        if (config.method !== undefined && config.method !== "btree")
          throw new Error(
            `Owned table ${name} supports btree indexes only; a ${config.method} index cannot lead with routing_key`,
          )

        config.columns = [...owner, ...config.columns]
      } else if (is(builder, UniqueConstraintBuilder)) {
        const constraint = builder as UniqueConstraintBuilder & Prefixable
        constraint.columns = [...owner, ...constraint.columns]
      }

      result.push(builder)
    }

    const [routing, tenant, actor] = owner

    for (const [key, column] of uniques) {
      const constraint = unique(column.uniqueName).on(routing!, tenant!, actor!, self[key]!)
      result.push(column.uniqueType === "not distinct" ? constraint.nullsNotDistinct() : constraint)
    }

    const [first, ...rest] = [...owner, ...key.map((column) => self[column]!)]
    result.push(primaryKey({ name: primaryName, columns: [first!, ...rest] }))

    const scoped = sql`tenant_id = current_setting('durable.tenant', true)`
    result.push(pgPolicy("durable_tenant", { for: "all", using: scoped, withCheck: scoped }))

    return result
  }

  const schema = internals[SchemaKey]

  owned.set(source, {
    name: schema === undefined ? name : `${schema}.${name}`,
    schema,
    table: name,
    columns: Object.keys(columns),
    primaryKey: key,
    owner: undefined,
  })

  if (!isOwned(source)) throw new Error(`Table ${name} did not take ownership`)

  return source
}
