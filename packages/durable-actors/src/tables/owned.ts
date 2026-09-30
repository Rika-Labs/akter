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

declare const OwnedKeysId: unique symbol

declare const ReadOnlyId: unique symbol

declare const MappedColumnsId: unique symbol

/** Ownership lives beside the table, keyed by the table object itself, so no other object can claim it by copying a property or symbol. */
const owned = new WeakMap<object, Ownership>()

/** How an actor type uses an owned table: `read` tables are never written by the runtime. */
export type AdoptionAccess = "write" | "read"

/** The column types an existing table's tenant and actor columns may have. */
export type MappedKind = "text" | "uuid"

/** What the framework knows about an owned table; aliases forward it. */
export interface Ownership {
  /** The table name, qualified by its schema when it has one. */
  readonly name: string
  readonly schema: string | undefined
  readonly table: string
  /**
   * The column keys of a row: business columns, and for an adopted table also
   * its mapped tenant and actor columns, which are readable but never writable.
   */
  readonly columns: ReadonlyArray<string>
  /**
   * Primary key column keys, in key order. An owned table's key excludes the
   * ownership columns it is prefixed with; an adopted table's is the physical
   * key as it already is.
   */
  readonly primaryKey: ReadonlyArray<string>
  /** The actor type listing this table; set once by `Actor.make`. */
  owner: string | undefined
  /** True when the table existed before the framework and maps its own tenant and actor columns. */
  readonly adopted: boolean
  readonly access: AdoptionAccess
  /** Drizzle keys of the ownership columns, which application code never reads or writes. */
  readonly ownerKeys: ReadonlyArray<string>
  /** SQL names of the ownership columns, in the same order as `ownerKeys`. */
  readonly ownerColumns: ReadonlyArray<string>
  /** The key of `routing_key`; a read-only adopted table has none. */
  readonly routingKey: string | undefined
  readonly tenantKey: string
  readonly actorKey: string
  readonly tenantKind: MappedKind
  readonly actorKind: MappedKind
  /** The owning actor type's placement; set with `owner`. */
  placement: Placement | undefined
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
}> & { readonly [OwnedTypeId]: Ownership; readonly [OwnedKeysId]: OwnershipKey }

/** The columns of an existing table that can name its owner: any column of `T`. */
export interface OwnerColumns<T extends AnyPgTable> {
  readonly tenant: T["_"]["columns"][keyof T["_"]["columns"]]
  readonly actor: T["_"]["columns"][keyof T["_"]["columns"]]
}

const routingColumn = () => ({ routing_key: bigint("routing_key", { mode: "bigint" }) })

type RoutingColumn<Name extends string> = BuildColumns<Name, ReturnType<typeof routingColumn>, "pg">

/**
 * An existing table an actor type owns rows of. Its keys, constraints, and
 * indexes are untouched; it gains one nullable `routing_key`, and the mapped
 * tenant and actor columns are ownership columns the turn supplies.
 */
export type AdoptedTable<T extends AnyPgTable, Mapped> = PgTableWithColumns<{
  name: T["_"]["name"]
  schema: T["_"]["schema"]
  columns: T["_"]["columns"] & RoutingColumn<T["_"]["name"]>
  dialect: "pg"
  isAlias: false
}> & {
  readonly [OwnedTypeId]: Ownership
  readonly [OwnedKeysId]: "routing_key"
  readonly [MappedColumnsId]: Mapped
}

/** An existing table adopted for reading only: unchanged, with no mutation methods in any turn or query. */
export type ReadAdoptedTable<T extends AnyPgTable, Mapped> = T & {
  readonly [OwnedTypeId]: Ownership
  readonly [OwnedKeysId]: never
  readonly [MappedColumnsId]: Mapped
  readonly [ReadOnlyId]: true
}

type Same<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false

/**
 * The columns of an adopted table that look like a mapped column. Types
 * cannot tell which property a column object came from, so a column shaped
 * exactly like the tenant or actor column is treated as possibly mapped: its
 * insert is optional in the type, and the database refuses a missing value.
 */
type MappedLookalikes<T extends AnyOwnedTable> = T extends { readonly [MappedColumnsId]: infer M }
  ? {
      [K in keyof T["_"]["columns"] & string]: Same<T["_"]["columns"][K], M> extends true
        ? K
        : never
    }[keyof T["_"]["columns"] & string]
  : never

/** Any owned table, whatever its columns. */
export type AnyOwnedTable = AnyPgTable & { readonly [OwnedTypeId]: Ownership }

type OwnedKeys<T extends AnyOwnedTable> = T extends { readonly [OwnedKeysId]: infer K }
  ? K & string
  : OwnershipKey

type BusinessColumns<T extends AnyOwnedTable> = Omit<T["_"]["columns"], OwnedKeys<T>>

/**
 * A row as application code reads it: business columns only. An adopted
 * table's row also carries its mapped tenant and actor columns, which are
 * read-only.
 */
export type Row<T extends AnyOwnedTable> = Omit<InferSelectModel<T>, OwnedKeys<T>>

/**
 * A row as application code writes it: business columns only. The mapped
 * columns of an adopted table come from the turn and are rejected when set.
 */
export type Insert<T extends AnyOwnedTable> = Omit<
  InferInsertModel<T>,
  OwnedKeys<T> | MappedLookalikes<T>
> &
  Partial<Pick<InferInsertModel<T>, MappedLookalikes<T> & keyof InferInsertModel<T>>>

/** What a turn's `rows` returns for `T`: rows of a read-adopted table have no mutation methods. */
export type TurnRows<T extends AnyOwnedTable> = T extends { readonly [ReadOnlyId]: true }
  ? ScopedRead<T>
  : ScopedRows<T>

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

/** The tables an actor type declares and how its rows are placed, as tooling that reads a definition needs them. */
export interface DeclaredTables {
  readonly actor: string
  readonly placement: Placement
  readonly tables: ReadonlyArray<AnyOwnedTable>
}

const declared = new WeakMap<WeakKey, DeclaredTables>()

/** Records the tables an actor definition declares; `Actor.make` calls it once per definition. */
export const recordDeclaredTables = (entry: {
  readonly definition: WeakKey
  readonly tables: DeclaredTables
}) => {
  declared.set(entry.definition, entry.tables)
}

/** The tables and placement of an actor definition, or undefined for any other value. */
export const declaredTablesOf = (definition: WeakKey): DeclaredTables | undefined =>
  declared.get(definition)

/** The ownership of `table`, or undefined when it is not an owned table. */
export const ownership = (table: PgSelectConfig["table"]): Ownership | undefined => owned.get(table)

const isOwned = <T extends AnyPgTable>(table: T): table is T & OwnedTable<T> =>
  ownership(table) !== undefined

const flatten = (config: ExtraConfig | undefined, self: ExtraColumns) =>
  (config?.(self) ?? []).flat()

/** Options that adopt an existing table: the columns holding the tenant and the actor's key. */
export interface AdoptOptions<T extends AnyPgTable, O extends OwnerColumns<T>> {
  readonly owner: O
  /** `"read"` adopts the table for reading only; the runtime then adds no column and no guard. */
  readonly access?: AdoptionAccess
}

const mappedKindOf = (columnType: string): MappedKind | undefined => {
  if (columnType === "PgText" || columnType === "PgVarchar") return "text"

  return columnType === "PgUUID" ? "uuid" : undefined
}

const declaredKey = (
  columns: Record<string, BuiltColumn>,
  extraColumns: ExtraColumns,
  extraConfig: ExtraConfig | undefined,
) => {
  const keyOf = new Map(Object.entries(columns).map(([key, column]) => [column.name, key]))
  let composite: ReadonlyArray<string> | undefined

  for (const builder of flatten(extraConfig, extraColumns))
    if (is(builder, PrimaryKeyBuilder))
      composite = (builder as PrimaryKeyBuilder & KeyBuilder).columns.map(
        (column) => keyOf.get(column.name) ?? column.name,
      )

  return (
    composite ?? Object.entries(columns).flatMap(([key, column]) => (column.primary ? [key] : []))
  )
}

const adopt = (
  source: AnyPgTable,
  options: {
    readonly owner: { readonly tenant: PgColumn; readonly actor: PgColumn }
    readonly access?: AdoptionAccess | undefined
  },
): AnyOwnedTable => {
  const internals = source as AnyPgTable & TableInternals
  const name = internals[NameKey]
  const columns = internals[ColumnsKey]
  const access = options.access ?? "write"

  if (access !== "write" && access !== "read")
    throw new Error(`access of ${name} is "write" or "read"`)

  const find = (column: PgColumn, role: string) => {
    const found = Object.entries(columns).find(([, candidate]) => candidate === column)

    if (found === undefined) throw new Error(`owner.${role} is not a column of ${name}`)

    const kind = mappedKindOf(found[1].columnType)

    if (kind === undefined)
      throw new Error(
        `owner.${role} of ${name} is a ${found[1].columnType} column; only text, varchar, and uuid columns can be mapped`,
      )

    return { key: found[0], column: found[1], kind }
  }

  const tenant = find(options.owner.tenant, "tenant")
  const actor = find(options.owner.actor, "actor")

  if (tenant.key === actor.key)
    throw new Error(`owner.tenant and owner.actor of ${name} name the same column`)

  for (const [key, column] of Object.entries(columns))
    if (key === "routing_key" || column.name === "routing_key")
      throw new Error(`Column ${key} of ${name} is reserved for ownership`)

  const extraColumns = internals[ExtraColumnsKey]
  const extraConfig = internals[ExtraConfigKey]
  const primaryKey = declaredKey(columns, extraColumns, extraConfig)

  if (access === "write" && primaryKey.length === 0)
    throw new Error(`Owned table ${name} needs a primary key`)

  let routingKey: string | undefined

  if (access === "write") {
    const builder = routingColumn().routing_key
    const internal = builder as typeof builder & ColumnBuilderInternals
    internal.setName("routing_key")
    const built = internal.build(source).postBuild() as BuiltColumn
    Object.assign(source, { routing_key: built })
    internals[ColumnsKey] = { ...columns, routing_key: built }
    internals[ExtraColumnsKey] = {
      ...extraColumns,
      routing_key: internal.buildExtraConfigColumn(source),
    }
    routingKey = "routing_key"
  }

  const ownerKeys = [...(routingKey === undefined ? [] : [routingKey]), tenant.key, actor.key]

  const schema = internals[SchemaKey]

  owned.set(source, {
    name: schema === undefined ? name : `${schema}.${name}`,
    schema,
    table: name,
    columns: Object.keys(columns).filter((key) => key !== routingKey),
    primaryKey,
    owner: undefined,
    placement: undefined,
    adopted: true,
    access,
    ownerKeys,
    ownerColumns: ownerKeys.map((key) => internals[ColumnsKey][key]!.name),
    routingKey,
    tenantKey: tenant.key,
    actorKey: actor.key,
    tenantKind: tenant.kind,
    actorKind: actor.kind,
  })

  if (!isOwned(source)) throw new Error(`Table ${name} did not take ownership`)

  return source
}

/** What `Actor.table` returns: a new owned table, or the existing table adopted with `owner`. */
export type Declared<
  T extends AnyPgTable,
  O extends OwnerColumns<T> | undefined,
  A extends AdoptionAccess | undefined,
> =
  O extends OwnerColumns<T>
    ? A extends "read"
      ? ReadAdoptedTable<T, O["tenant"] | O["actor"]>
      : AdoptedTable<T, O["tenant"] | O["actor"]>
    : OwnedTable<T>

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
 * With `owner`, adopts a table that already exists and other code writes: its
 * `tenant` and `actor` columns, which must be text, varchar, or uuid, hold the
 * tenant and the actor's key, and nothing else about the table changes, so
 * foreign keys stay. A writable adopted table gains a nullable `routing_key`
 * and starts only after `durable adopt observe`; its primary key stays global,
 * so a key another actor already holds fails the turn. `access: "read"` maps
 * the two columns for reading and adds nothing.
 *
 * @example
 * const Notes = Actor.table(pgTable("notes", { id: text("id").primaryKey(), body: text("body") }))
 * const Invoices = Actor.table(invoices, { owner: { tenant: invoices.orgId, actor: invoices.accountId } })
 */
export const table = <
  T extends AnyPgTable,
  const O extends OwnerColumns<T> | undefined = undefined,
  const A extends AdoptionAccess | undefined = undefined,
>(
  source: T,
  ...adoption: readonly [] | readonly [{ readonly owner: O; readonly access?: A }]
): Declared<T, O, A> => {
  const options = adoption[0]

  if (!is(source, PgTable)) throw new Error("Actor.table takes a pgTable")
  const internals = source as T & TableInternals
  const name = internals[NameKey]

  if (internals[IsAliasKey]) throw new Error(`Actor.table takes a table, not an alias: ${name}`)

  if (ownership(source) !== undefined) throw new Error(`Table ${name} is already owned`)

  if (options !== undefined)
    return adopt(source, options as Parameters<typeof adopt>[1]) as Declared<T, O, A>

  const columns = internals[ColumnsKey]
  const reserved: ReadonlyArray<string> = OWNERSHIP

  for (const [key, column] of Object.entries(columns))
    if (reserved.includes(key) || reserved.includes(column.name))
      throw new Error(`Column ${key} of ${name} is reserved for ownership`)

  if (internals[ForeignKeysKey].length > 0)
    throw new Error(`Owned table ${name} cannot declare foreign keys`)

  const extraColumns = internals[ExtraColumnsKey]
  const extraConfig = internals[ExtraConfigKey]
  const keyOf = new Map(Object.entries(columns).map(([key, column]) => [column.name, key]))
  let composite: ReadonlyArray<string> | undefined

  for (const builder of flatten(extraConfig, extraColumns)) {
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

    for (const builder of flatten(extraConfig, self)) {
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
    adopted: false,
    access: "write",
    ownerKeys: OWNERSHIP,
    ownerColumns: OWNERSHIP,
    routingKey: "routing_key",
    tenantKey: "tenant_id",
    actorKey: "actor_id",
    tenantKind: "text",
    actorKind: "text",
    placement: undefined,
  })

  if (!isOwned(source)) throw new Error(`Table ${name} did not take ownership`)

  return source as Declared<T, O, A>
}
