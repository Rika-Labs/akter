import { UsageAccounting } from "@rikalabs/akter/runtime"
import { Context, DateTime, Effect, Layer } from "effect"
import { SqlClient, type SqlError } from "effect/sql"

import {
  CellUsage,
  DeploymentMismatch,
  HourNotEnded,
  HourNotSealed,
  StorageSampleUnavailable,
  StorageNotObservable,
  type JournalEvent,
  type JournalKind,
  type PendingPage,
  type SealedHour,
  type StorageSample,
  UnknownEvents,
} from "./contract.ts"

const SCHEMA_LOCK = 499500504

const DEFAULT_PAGE = 256

const MAX_PAGE = 1000

const CURRENT_HOUR = "date_trunc('hour', clock_timestamp(), 'UTC')"

interface JournalRow {
  readonly event_id: string
  readonly deployment_id: string
  readonly tenant_id: string
  readonly actor_type: string
  readonly actor_id: string
  readonly command_id: string | null
  readonly request_token: string | null
  readonly kind: JournalKind
  readonly hour: Date
  readonly recorded_at: Date
  readonly acked_at: Date | null
  readonly storage_byte_hours: string | null
}

interface HourRow {
  readonly hour: Date
  readonly sealed_at: Date
}

const eventOf = (row: JournalRow): JournalEvent => ({
  eventId: row.event_id,
  deploymentId: row.deployment_id,
  tenant: row.tenant_id,
  actorType: row.actor_type,
  actorId: row.actor_id,
  commandId: row.command_id,
  requestToken: row.request_token,
  kind: row.kind,
  hour: DateTime.fromDateUnsafe(row.hour),
  recordedAt: DateTime.fromDateUnsafe(row.recorded_at),
  storageByteHours: row.storage_byte_hours === null ? null : Number(row.storage_byte_hours),
  acknowledged: row.acked_at !== null,
  ackedAt: row.acked_at === null ? null : DateTime.fromDateUnsafe(row.acked_at),
})

const install = (sql: SqlClient.SqlClient) =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`SELECT pg_advisory_xact_lock(${SCHEMA_LOCK})`
      yield* sql`CREATE TABLE IF NOT EXISTS cloud_meter_cell_journal (
        event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        deployment_id text NOT NULL,
        tenant_id text NOT NULL,
        actor_type text NOT NULL,
        actor_id text NOT NULL,
        command_id text,
        request_token text,
        kind text NOT NULL CHECK (kind IN ('command', 'read', 'storage')),
        hour timestamptz NOT NULL,
        recorded_at timestamptz NOT NULL,
        acked_at timestamptz,
        storage_byte_hours bigint,
        CHECK ((kind = 'command') = (command_id IS NOT NULL)),
        CHECK ((kind = 'storage') = (storage_byte_hours IS NOT NULL))
      )`
      yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS cloud_meter_cell_journal_command
        ON cloud_meter_cell_journal (deployment_id, tenant_id, actor_type, actor_id, command_id)
        WHERE kind = 'command'`
      yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS cloud_meter_cell_journal_storage
        ON cloud_meter_cell_journal (deployment_id, tenant_id, hour) WHERE kind = 'storage'`
      yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS cloud_meter_cell_journal_token
        ON cloud_meter_cell_journal (request_token) WHERE request_token IS NOT NULL`
      yield* sql`CREATE INDEX IF NOT EXISTS cloud_meter_cell_journal_hour
        ON cloud_meter_cell_journal (hour)`
      yield* sql`CREATE TABLE IF NOT EXISTS cloud_meter_cell_owner (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        deployment_id text NOT NULL
      )`
      yield* sql`CREATE TABLE IF NOT EXISTS cloud_meter_cell_hour (
        hour timestamptz PRIMARY KEY,
        sealed_at timestamptz NOT NULL
      )`
      yield* sql`CREATE OR REPLACE FUNCTION cloud_meter_cell_journal_place() RETURNS trigger AS $$
        BEGIN
          IF EXISTS (SELECT 1 FROM cloud_meter_cell_hour WHERE hour = NEW.hour) THEN
            SELECT max(hour) + interval '1 hour' INTO NEW.hour FROM cloud_meter_cell_hour;
          END IF;
          RETURN NEW;
        END
        $$ LANGUAGE plpgsql`
      yield* sql`CREATE OR REPLACE TRIGGER cloud_meter_cell_journal_place
        BEFORE INSERT ON cloud_meter_cell_journal
        FOR EACH ROW EXECUTE FUNCTION cloud_meter_cell_journal_place()`
      yield* sql`CREATE OR REPLACE FUNCTION cloud_meter_cell_journal_guard() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'journal rows cannot be deleted';
          END IF;
          IF OLD.acked_at IS NOT NULL
             OR (to_jsonb(NEW) - 'acked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'acked_at') THEN
            RAISE EXCEPTION 'journal rows are immutable';
          END IF;
          RETURN NEW;
        END
        $$ LANGUAGE plpgsql`
      yield* sql`CREATE OR REPLACE TRIGGER cloud_meter_cell_journal_guard
        BEFORE UPDATE OR DELETE ON cloud_meter_cell_journal
        FOR EACH ROW EXECUTE FUNCTION cloud_meter_cell_journal_guard()`
    }),
  )

/**
 * Journals a cell's metered work in its own database: one row per command
 * whose receipt committed, and one per answered read. Both hooks write one
 * statement on the client the runtime hands them, so a command's row commits
 * or rolls back with its receipt. The row's hour comes from the database
 * clock inside the insert, which takes its table lock first, so an hour being
 * sealed can never receive a row assigned before it.
 *
 * Journal rows outlive receipt retention and never expire: a command's row is
 * unique per deployment, tenant, actor and command id, so a command whose
 * receipt was pruned and which runs again still counts once.
 */
export const CellUsageLive = (options: { readonly deploymentId: string }) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      yield* install(sql)
      const owner = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT pg_advisory_xact_lock(${SCHEMA_LOCK})`
          yield* sql`INSERT INTO cloud_meter_cell_owner (deployment_id)
            VALUES (${options.deploymentId}) ON CONFLICT (singleton) DO NOTHING`
          const [row] = yield* sql<{ deployment_id: string }>`
            SELECT deployment_id FROM cloud_meter_cell_owner`
          return row!
        }),
      )
      if (owner.deployment_id !== options.deploymentId) {
        return yield* DeploymentMismatch.make({
          configured: options.deploymentId,
          owner: owner.deployment_id,
        })
      }

      const seal = (
        hour: DateTime.Utc,
      ): Effect.Effect<SealedHour, HourNotEnded | SqlError.SqlError> =>
        sql.withTransaction(
          Effect.gen(function* () {
            const start = DateTime.formatIso(hour)
            yield* sql`LOCK TABLE cloud_meter_cell_journal IN SHARE MODE`
            const [ended] = yield* sql<{ hour: Date; ended: boolean }>`
              SELECT date_trunc('hour', ${start}::timestamptz, 'UTC') AS hour,
                clock_timestamp() >= date_trunc('hour', ${start}::timestamptz, 'UTC') + interval '1 hour' AS ended`
            if (!ended!.ended) return yield* HourNotEnded.make({ hour: start })
            yield* sql`INSERT INTO cloud_meter_cell_hour (hour, sealed_at)
              VALUES (${ended!.hour}, clock_timestamp()) ON CONFLICT (hour) DO NOTHING`
            const [sealed] = yield* sql<HourRow>`
              SELECT hour, sealed_at FROM cloud_meter_cell_hour WHERE hour = ${ended!.hour}`
            return {
              hour: DateTime.fromDateUnsafe(sealed!.hour),
              sealedAt: DateTime.fromDateUnsafe(sealed!.sealed_at),
            }
          }),
        )

      const sealAndPending = (
        hour: DateTime.Utc,
        limit = DEFAULT_PAGE,
        after?: string,
      ): Effect.Effect<PendingPage, HourNotEnded | SqlError.SqlError> =>
        Effect.gen(function* () {
          const sealed = yield* seal(hour)
          const size = Math.max(1, Math.min(Math.trunc(limit), MAX_PAGE))
          const rows = yield* sql<JournalRow>`
            SELECT * FROM cloud_meter_cell_journal
            WHERE deployment_id = ${options.deploymentId}
              AND hour = ${DateTime.formatIso(sealed.hour)}::timestamptz AND acked_at IS NULL
              AND (${after ?? null}::uuid IS NULL OR event_id > ${after ?? null}::uuid)
            ORDER BY event_id LIMIT ${size + 1}`
          return {
            ...sealed,
            events: rows.slice(0, size).map(eventOf),
            complete: rows.length <= size,
          }
        })

      const sampleStorage = (
        hour: DateTime.Utc,
      ): Effect.Effect<
        StorageSample,
        StorageSampleUnavailable | StorageNotObservable | SqlError.SqlError
      > =>
        Effect.gen(function* () {
          const start = DateTime.formatIso(hour)
          const [target] = yield* sql<{ hour: Date; current: boolean }>`
            SELECT date_trunc('hour', ${start}::timestamptz, 'UTC') AS hour,
              date_trunc('hour', ${start}::timestamptz, 'UTC') = date_trunc('hour', clock_timestamp(), 'UTC') AS current`
          const tables = yield* sql<{
            table_name: string
            attributed: boolean
            observable: boolean
          }>`
            SELECT c.relname AS table_name,
              EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND NOT a.attisdropped
                AND a.attname = 'tenant_id' AND a.atttypid = 'text'::regtype)
              AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND NOT a.attisdropped
                AND a.attname = 'routing_key' AND a.atttypid = 'bigint'::regtype) AS attributed,
              has_schema_privilege(n.oid, 'USAGE') AND has_table_privilege(c.oid, 'SELECT')
              AND (NOT c.relrowsecurity OR (c.relowner = r.oid AND NOT c.relforcerowsecurity)
                OR r.rolsuper OR r.rolbypassrls) AS observable
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_roles r ON r.rolname = current_user
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
              AND NOT starts_with(c.relname, 'cloud_meter_')
            ORDER BY c.relname`
          const attributed = tables.filter((table) => table.attributed)
          const hidden = attributed.flatMap((table) => (table.observable ? [] : [table.table_name]))
          if (hidden.length > 0) return yield* StorageNotObservable.make({ tables: hidden })

          const persisted = sql<{ tenant_id: string; storage_byte_hours: string }>`
            SELECT tenant_id, storage_byte_hours::text FROM cloud_meter_cell_journal
            WHERE kind = 'storage' AND deployment_id = ${options.deploymentId}
              AND hour = ${target!.hour}
            ORDER BY tenant_id`

          const sampled = (
            rows: ReadonlyArray<{ tenant_id: string; storage_byte_hours: string }>,
          ) =>
            rows.length === 0 && !target!.current
              ? Effect.fail(StorageSampleUnavailable.make({ hour: start }))
              : Effect.succeed({
                  hour: DateTime.fromDateUnsafe(target!.hour),
                  samples: rows.map((row) => ({
                    tenant: row.tenant_id,
                    logicalBytes: Number(row.storage_byte_hours),
                  })),
                  tables: attributed.map((table) => table.table_name),
                  unattributedTables: tables.flatMap((table) =>
                    table.attributed ? [] : [table.table_name],
                  ),
                })

          if (!target!.current) return yield* Effect.flatMap(persisted, sampled)

          const totals = new Map<string, number>()
          for (const table of attributed) {
            const rows = yield* sql<{ tenant_id: string; bytes: string }>`
              SELECT tenant_id, sum(pg_column_size(t.*))::text AS bytes
              FROM ${sql(table.table_name)} AS t GROUP BY tenant_id`
            for (const row of rows) {
              totals.set(row.tenant_id, (totals.get(row.tenant_id) ?? 0) + Number(row.bytes))
            }
          }
          const tenants = [...totals.keys()]
          const bytes = tenants.map((tenant) => String(totals.get(tenant)))

          const stored = yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`LOCK TABLE cloud_meter_cell_journal IN ROW EXCLUSIVE MODE`
              const [still] = yield* sql<{ current: boolean }>`
                SELECT ${target!.hour}::timestamptz = date_trunc('hour', clock_timestamp(), 'UTC') AS current`
              if (still!.current && tenants.length > 0) {
                yield* sql`
                  INSERT INTO cloud_meter_cell_journal
                    (deployment_id, tenant_id, actor_type, actor_id, kind, hour, recorded_at,
                     storage_byte_hours)
                  SELECT ${options.deploymentId}, sampled.tenant_id, '', '', 'storage', ${target!.hour},
                    clock_timestamp(), sampled.bytes
                  FROM unnest(${tenants}::text[], ${bytes}::bigint[]) AS sampled(tenant_id, bytes)
                  ON CONFLICT (deployment_id, tenant_id, hour) WHERE kind = 'storage' DO NOTHING`
              }
              return yield* persisted
            }),
          )

          return yield* sampled(stored)
        })

      const earliestHour = sql<{ hour: Date | null }>`
        SELECT min(hour) AS hour FROM cloud_meter_cell_journal
        WHERE deployment_id = ${options.deploymentId} AND acked_at IS NULL`.pipe(
        Effect.map(([row]) => (row?.hour == null ? null : DateTime.fromDateUnsafe(row.hour))),
      )

      const ack = (eventIds: ReadonlyArray<string>) =>
        eventIds.length === 0
          ? Effect.succeed(0)
          : sql.withTransaction(
              Effect.gen(function* () {
                const known = yield* sql<{ event_id: string }>`
              SELECT event_id FROM cloud_meter_cell_journal
              WHERE deployment_id = ${options.deploymentId} AND event_id = ANY(${eventIds}::uuid[])`
                const found = new Set(known.map((row) => row.event_id))
                const unknown = eventIds.filter((id) => !found.has(id.toLowerCase()))
                if (unknown.length > 0) return yield* UnknownEvents.make({ eventIds: unknown })
                const open = yield* sql<{ hour: Date }>`
              SELECT DISTINCT j.hour FROM cloud_meter_cell_journal j
              WHERE j.deployment_id = ${options.deploymentId}
                AND j.event_id = ANY(${eventIds}::uuid[])
                AND NOT EXISTS (SELECT 1 FROM cloud_meter_cell_hour h WHERE h.hour = j.hour)
              ORDER BY j.hour LIMIT 1`
                if (open[0] !== undefined) {
                  return yield* HourNotSealed.make({
                    hour: DateTime.formatIso(DateTime.fromDateUnsafe(open[0].hour)),
                  })
                }
                const acked = yield* sql<{ event_id: string }>`
              UPDATE cloud_meter_cell_journal SET acked_at = clock_timestamp()
              WHERE deployment_id = ${options.deploymentId}
                AND event_id = ANY(${eventIds}::uuid[]) AND acked_at IS NULL
              RETURNING event_id`
                return acked.length
              }),
            )

      return Context.make(
        CellUsage,
        CellUsage.of({ sampleStorage, sealAndPending, earliestHour, ack }),
      ).pipe(
        Context.add(UsageAccounting, {
          commands: ({ ref, commandIds, sql: turn }) =>
            Effect.asVoid(turn`
              INSERT INTO cloud_meter_cell_journal
                (deployment_id, tenant_id, actor_type, actor_id, command_id, kind, hour, recorded_at)
              SELECT ${options.deploymentId}, ${ref.tenant}, ${ref.actor}, ${ref.id}, ids.command_id,
                'command', ${turn.unsafe(CURRENT_HOUR)}, clock_timestamp()
              FROM unnest(${commandIds}::text[]) AS ids(command_id)
              ON CONFLICT (deployment_id, tenant_id, actor_type, actor_id, command_id)
                WHERE kind = 'command' DO NOTHING`),
          read: ({ ref, requestToken, watch, sql: primary }) =>
            watch && requestToken === undefined
              ? Effect.void
              : Effect.asVoid(primary`
                  INSERT INTO cloud_meter_cell_journal
                    (deployment_id, tenant_id, actor_type, actor_id, request_token, kind, hour, recorded_at)
                  VALUES (${options.deploymentId}, ${ref.tenant}, ${ref.actor}, ${ref.id},
                    ${requestToken ?? null}, 'read', ${primary.unsafe(CURRENT_HOUR)}, clock_timestamp())
                  ON CONFLICT (request_token) WHERE request_token IS NOT NULL DO NOTHING`),
        }),
      )
    }),
  )
