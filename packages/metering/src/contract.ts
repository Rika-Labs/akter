import { Context, type DateTime, type Effect, Schema } from "effect"
import type { SqlError } from "effect/sql"

/** What a journal row records: a newly committed command, a read answered, or a tenant's stored bytes for an hour. */
export type JournalKind = "command" | "read" | "storage"

/**
 * One unit of metered work as a cell recorded it. The database refuses every
 * change to a row except setting `ackedAt` once, and refuses every delete:
 * an acknowledged row stays as the archive. A command is one row per
 * deployment, tenant, actor and command id, however many receipts that id
 * later gets, so a command the framework runs again after its receipt was
 * pruned (which external commands cannot do, since an expired id is refused)
 * still counts once. `hour` is the UTC hour, on the database's clock, the work
 * was recorded in. A storage row has empty `actorType` and `actorId`, and
 * `storageByteHours`: the tenant's logical bytes, held for the hour.
 */
export interface JournalEvent {
  readonly eventId: string
  readonly deploymentId: string
  readonly tenant: string
  readonly actorType: string
  readonly actorId: string
  readonly commandId: string | null
  readonly requestToken: string | null
  readonly kind: JournalKind
  readonly hour: DateTime.Utc
  readonly recordedAt: DateTime.Utc
  readonly storageByteHours: number | null
  readonly acknowledged: boolean
  readonly ackedAt: DateTime.Utc | null
}

/** An hour that will take no more journal rows. */
export interface SealedHour {
  readonly hour: DateTime.Utc
  readonly sealedAt: DateTime.Utc
}

/** One page of a sealed hour's journal rows that the control plane has not acknowledged. */
export interface PendingPage extends SealedHour {
  readonly events: ReadonlyArray<JournalEvent>
  /** True when this page ends the pending rows; otherwise ask again with `after` set to the last `eventId`. */
  readonly complete: boolean
}

/** A tenant's logical bytes for one hour, as first sampled and persisted. */
export interface TenantStorage {
  readonly tenant: string
  readonly logicalBytes: number
}

/**
 * The hour's storage samples. `tables` are the public tables counted: those
 * with a `tenant_id` and a `routing_key` column. `unattributedTables` are the
 * other public tables (coordination and deployment metadata, which carry no
 * tenant or actor), which no tenant is charged for. The journal's own
 * `cloud_meter_*` tables are in neither list.
 */
export interface StorageSample {
  readonly hour: DateTime.Utc
  readonly samples: ReadonlyArray<TenantStorage>
  readonly tables: ReadonlyArray<string>
  readonly unattributedTables: ReadonlyArray<string>
}

/** The hour has not finished on the database's clock, so it can still take rows. */
export class HourNotEnded extends Schema.TaggedError<HourNotEnded>()("HourNotEnded", {
  hour: Schema.String,
}) {}

/** An event belongs to an hour that is not sealed, so the control plane cannot have imported it completely. */
export class HourNotSealed extends Schema.TaggedError<HourNotSealed>()("HourNotSealed", {
  hour: Schema.String,
}) {}

/** The database's journal belongs to another deployment; one database serves exactly one. */
export class DeploymentMismatch extends Schema.TaggedError<DeploymentMismatch>()(
  "DeploymentMismatch",
  { configured: Schema.String, owner: Schema.String },
) {}

/** Events that are not in this deployment's journal, so none were acknowledged. */
export class UnknownEvents extends Schema.TaggedError<UnknownEvents>()("UnknownEvents", {
  eventIds: Schema.Array(Schema.String),
}) {}

/**
 * No storage sample exists for the hour, and none can be taken now because
 * it is not the database's current hour. A past hour's bytes were never
 * observed, so none are made up.
 */
export class StorageSampleUnavailable extends Schema.TaggedError<StorageSampleUnavailable>()(
  "StorageSampleUnavailable",
  { hour: Schema.String },
) {}

/** The current database role cannot read every attributed row, so no sample is persisted. */
export class StorageNotObservable extends Schema.TaggedError<StorageNotObservable>()(
  "StorageNotObservable",
  { tables: Schema.Array(Schema.String) },
) {}

/**
 * The cell's usage journal, read for import by the control plane.
 *
 * `sampleStorage` records each tenant's stored bytes for the database's
 * current hour; the collector calls it every minute, so the first call of the
 * hour persists that hour's sample and later calls return it unchanged even
 * though tenants kept writing. A tenant whose latest sample was positive
 * receives a zero sample after all its attributed rows are deleted; a tenant
 * whose latest sample is already zero does not need repeated zero rows. For
 * any other hour it returns the samples
 * already persisted, or fails `StorageSampleUnavailable`: bytes are never
 * estimated for an hour nobody observed, so a downtime leaves its hours
 * without a sample. Bytes are the sum of `pg_column_size` over the tenant's
 * rows, a logical measure of the stored values, not the physical volume of
 * disk, indexes or bloat, and they say nothing about how storage changed
 * between samples. It reads every tenant, so its connection must bypass
 * row-level security (an owner without forced RLS, a superuser, or a role with
 * BYPASSRLS) and have SELECT access. The sampler verifies this for every
 * attributed table and fails `StorageNotObservable` before scanning or
 * persisting any partial sample if its role cannot see all rows.
 *
 * `sealAndPending` ends an hour that has finished: it waits for every
 * transaction writing the journal, after which no row can join that hour,
 * then returns up to `limit` (default 256) of its unacknowledged rows after
 * `after`. An hour still running is refused. `earliestHour` is the oldest
 * hour with an unacknowledged row, or null. `ack` marks events imported,
 * only for sealed hours, and returns how many it newly marked; call it only
 * after the control plane durably stored them, and fails `UnknownEvents`,
 * changing nothing, if any id is not in this deployment's journal.
 *
 * A database serves one deployment: the first layer to start records its
 * deployment id there and a layer configured with another fails to build with
 * `DeploymentMismatch`. Every query below is scoped to that deployment, and
 * storage bytes are attributed by tenant alone, so two deployments must not
 * share a database or schema.
 */
export class CellUsage extends Context.Service<
  CellUsage,
  {
    readonly sampleStorage: (
      hour: DateTime.Utc,
    ) => Effect.Effect<
      StorageSample,
      StorageSampleUnavailable | StorageNotObservable | SqlError.SqlError
    >
    readonly sealAndPending: (
      hour: DateTime.Utc,
      limit?: number,
      after?: string,
    ) => Effect.Effect<PendingPage, HourNotEnded | SqlError.SqlError>
    readonly earliestHour: Effect.Effect<DateTime.Utc | null, SqlError.SqlError>
    readonly ack: (
      eventIds: ReadonlyArray<string>,
    ) => Effect.Effect<number, HourNotSealed | UnknownEvents | SqlError.SqlError>
  }
>()("@akter/metering/contract/CellUsage") {}
