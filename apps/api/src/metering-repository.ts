import { Context, DateTime, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"

/** The organization and project a deployment's tenant is metered to. */
export interface MeterBinding {
  readonly organizationId: string
  readonly projectId: string
}

/**
 * The edge's lock, shared because the edge creates the same tables:
 * `CREATE TABLE IF NOT EXISTS` alone races when two processes create one
 * table at once.
 */
const SCHEMA_LOCK = 7_243_001

/**
 * The metering tables in creation order. The first group, the latest storage
 * samples and the edge's connection leases repeat definitions the edge and
 * billing also create, so any process may start first and the API can read
 * the caps the edge admits by.
 *
 * `cloud_meter_evidence`, `cloud_meter_hour`, `cloud_meter_seal` and
 * `cloud_meter_export` are the `UsageActor`'s owned tables: their first three
 * columns and primary key prefix are the framework's ownership scope, and none
 * has a foreign key. Evidence rows are written once and never deleted: their
 * event ids are the permanent record that a source event was imported.
 *
 * Three triggers make an evidence row's effects atomic with the row. Before
 * insert it binds the organization and project from `cloud_meter_tenant` (the
 * exact tenant, else `'*'`) and refuses an unbound tenant, so a later change of
 * allocation never moves imported usage. After insert, unless the row is late,
 * it adds the hour counters, adds committed units to the account of the event's
 * own UTC month (5 per command, 1 per read, storage as GB-months of the month's
 * actual hours), and settles a matching edge reservation: the reservation
 * becomes `committed` and its units leave `reserved_units` of the
 * reservation's original period. The account row is locked before the
 * reservation, the order the edge uses. A storage row also moves the tenant's
 * latest sample in `cloud_meter_storage_sample`, after the account locks and
 * only to a strictly newer hour, so an import after an outage cannot leave a
 * cap on an older, larger sample and a replayed older sample cannot raise it.
 * A late storage row changes nothing there: its hour was sealed before it.
 */
const migrations: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS cloud_meter_tenant (
    deployment_id text NOT NULL,
    tenant text NOT NULL,
    organization_id text NOT NULL,
    project_id text NOT NULL,
    PRIMARY KEY (deployment_id, tenant)
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_billing_account (
    organization_id text PRIMARY KEY,
    plan text NOT NULL DEFAULT 'free',
    spend_limit_cents bigint,
    customer_id text,
    billing_email text,
    subscription_id text,
    provider_updated_at bigint NOT NULL DEFAULT 0,
    payment_status text NOT NULL DEFAULT 'free'
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_usage_account (
    organization_id text NOT NULL,
    period text NOT NULL,
    command_units bigint NOT NULL DEFAULT 0,
    reserved_units bigint NOT NULL DEFAULT 0,
    storage_gb_months double precision NOT NULL DEFAULT 0,
    PRIMARY KEY (organization_id, period)
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_usage_reservation (
    identity text PRIMARY KEY,
    organization_id text NOT NULL,
    project_id text NOT NULL,
    period text NOT NULL,
    deployment_id text NOT NULL,
    tenant text NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    command_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('command', 'read')),
    units integer NOT NULL,
    state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'committed', 'released')),
    reserved_at timestamptz NOT NULL DEFAULT now(),
    settled_at timestamptz,
    UNIQUE (deployment_id, tenant, actor_type, actor_id, command_id)
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_usage_hour (
    organization_id text NOT NULL,
    deployment_id text NOT NULL,
    tenant text NOT NULL,
    project_id text NOT NULL,
    hour timestamptz NOT NULL,
    command_count bigint NOT NULL DEFAULT 0,
    read_count bigint NOT NULL DEFAULT 0,
    storage_byte_hours double precision NOT NULL DEFAULT 0,
    sealed boolean NOT NULL DEFAULT false,
    sent boolean NOT NULL DEFAULT false,
    PRIMARY KEY (organization_id, deployment_id, tenant, project_id, hour)
  )`,
  `CREATE INDEX IF NOT EXISTS cloud_usage_hour_organization ON cloud_usage_hour (organization_id, hour)`,
  `CREATE TABLE IF NOT EXISTS cloud_meter_evidence (
    routing_key bigint NOT NULL,
    tenant_id text NOT NULL,
    actor_id text NOT NULL,
    event_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('command', 'read', 'storage')),
    deployment_id text NOT NULL,
    tenant_name text NOT NULL,
    source_actor_type text,
    source_actor_id text,
    command_id text,
    request_token text,
    reservation_identity text,
    hour timestamptz NOT NULL
      CHECK (hour = date_trunc('hour', hour AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
    storage_byte_hours double precision CHECK (storage_byte_hours >= 0),
    fingerprint text NOT NULL,
    late boolean NOT NULL DEFAULT false,
    organization_id text NOT NULL DEFAULT '',
    project_id text NOT NULL DEFAULT '',
    PRIMARY KEY (routing_key, tenant_id, actor_id, event_id)
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_meter_hour (
    routing_key bigint NOT NULL,
    tenant_id text NOT NULL,
    actor_id text NOT NULL,
    hour timestamptz NOT NULL,
    organization_id text NOT NULL,
    project_id text NOT NULL,
    command_count bigint NOT NULL DEFAULT 0,
    read_count bigint NOT NULL DEFAULT 0,
    storage_byte_hours double precision NOT NULL DEFAULT 0,
    PRIMARY KEY (routing_key, tenant_id, actor_id, hour, organization_id, project_id)
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_meter_seal (
    routing_key bigint NOT NULL,
    tenant_id text NOT NULL,
    actor_id text NOT NULL,
    hour timestamptz NOT NULL,
    deployment_id text NOT NULL,
    tenant_name text NOT NULL,
    sealed_through bigint NOT NULL,
    PRIMARY KEY (routing_key, tenant_id, actor_id, hour)
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_meter_export (
    routing_key bigint NOT NULL,
    tenant_id text NOT NULL,
    actor_id text NOT NULL,
    hour timestamptz NOT NULL,
    organization_id text NOT NULL,
    meter text NOT NULL,
    deployment_id text NOT NULL,
    tenant_name text NOT NULL,
    customer_id text NOT NULL,
    usage_key text NOT NULL,
    value double precision NOT NULL CHECK (value > 0),
    first_attempt_ms bigint NOT NULL,
    status text NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'accepted', 'needs_reconciliation')),
    PRIMARY KEY (routing_key, tenant_id, actor_id, hour, organization_id, meter)
  )`,
  `CREATE OR REPLACE FUNCTION cloud_meter_bind() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    SELECT organization_id, project_id INTO NEW.organization_id, NEW.project_id
    FROM cloud_meter_tenant
    WHERE deployment_id = NEW.deployment_id AND tenant IN (NEW.tenant_name, '*')
    ORDER BY (tenant = '*') LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'meter tenant (%, %) is not bound to an organization',
        NEW.deployment_id, NEW.tenant_name;
    END IF;
    RETURN NEW;
  END;
  $$`,
  `CREATE OR REPLACE TRIGGER cloud_meter_bind BEFORE INSERT ON cloud_meter_evidence
    FOR EACH ROW EXECUTE FUNCTION cloud_meter_bind()`,
  `CREATE TABLE IF NOT EXISTS cloud_meter_storage_sample (
    deployment_id text NOT NULL,
    tenant text NOT NULL,
    hour timestamptz NOT NULL,
    logical_bytes double precision NOT NULL CHECK (logical_bytes >= 0),
    PRIMARY KEY (deployment_id, tenant)
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_connection_lease (
    lease_id text PRIMARY KEY,
    organization_id text NOT NULL,
    deployment_id text NOT NULL,
    tenant text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('socket', 'sse')),
    edge_id text NOT NULL,
    heartbeat_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS cloud_connection_lease_live
    ON cloud_connection_lease (organization_id, expires_at)`,
  `CREATE INDEX IF NOT EXISTS cloud_connection_lease_edge ON cloud_connection_lease (edge_id)`,
  `CREATE OR REPLACE FUNCTION cloud_meter_storage_observe(
    observed_deployment text, observed_tenant text, observed_hour timestamptz,
    observed_bytes double precision
  ) RETURNS void LANGUAGE sql AS $$
    INSERT INTO cloud_meter_storage_sample (deployment_id, tenant, hour, logical_bytes)
    VALUES (observed_deployment, observed_tenant, observed_hour, observed_bytes)
    ON CONFLICT (deployment_id, tenant) DO UPDATE
    SET hour = excluded.hour, logical_bytes = excluded.logical_bytes
    WHERE cloud_meter_storage_sample.hour < excluded.hour
  $$`,
  `CREATE OR REPLACE FUNCTION cloud_meter_count() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE
    commands bigint := (NEW.kind = 'command')::int;
    reads bigint := (NEW.kind = 'read')::int;
    byte_hours double precision := COALESCE(NEW.storage_byte_hours, 0);
    month text := to_char(NEW.hour AT TIME ZONE 'UTC', 'YYYY-MM');
    month_hours double precision;
    res_org text;
    res_period text;
    settled record;
    held record;
  BEGIN
    IF NEW.late THEN
      RETURN NULL;
    END IF;
    month_hours := extract(epoch FROM
      (date_trunc('month', NEW.hour AT TIME ZONE 'UTC') + interval '1 month')
      - date_trunc('month', NEW.hour AT TIME ZONE 'UTC')) / 3600;
    IF NEW.reservation_identity IS NOT NULL THEN
      SELECT organization_id, period INTO res_org, res_period
      FROM cloud_usage_reservation
      WHERE identity = NEW.reservation_identity AND state = 'reserved';
    END IF;
    INSERT INTO cloud_usage_account (organization_id, period)
    VALUES (NEW.organization_id, month)
    ON CONFLICT DO NOTHING;
    IF res_period IS NOT NULL THEN
      INSERT INTO cloud_usage_account (organization_id, period)
      VALUES (res_org, res_period)
      ON CONFLICT DO NOTHING;
    END IF;
    FOR held IN
      SELECT organization_id, period FROM cloud_usage_account
      WHERE (organization_id, period) IN (
        (NEW.organization_id, month),
        (COALESCE(res_org, NEW.organization_id), COALESCE(res_period, month)))
      ORDER BY organization_id, period
      FOR UPDATE
    LOOP
      NULL;
    END LOOP;
    IF NEW.kind = 'storage' THEN
      PERFORM cloud_meter_storage_observe(NEW.deployment_id, NEW.tenant_name, NEW.hour,
        NEW.storage_byte_hours);
    END IF;
    INSERT INTO cloud_meter_hour (routing_key, tenant_id, actor_id, hour, organization_id,
      project_id, command_count, read_count, storage_byte_hours)
    VALUES (NEW.routing_key, NEW.tenant_id, NEW.actor_id, NEW.hour, NEW.organization_id,
      NEW.project_id, commands, reads, byte_hours)
    ON CONFLICT (routing_key, tenant_id, actor_id, hour, organization_id, project_id) DO UPDATE SET
      command_count = cloud_meter_hour.command_count + EXCLUDED.command_count,
      read_count = cloud_meter_hour.read_count + EXCLUDED.read_count,
      storage_byte_hours = cloud_meter_hour.storage_byte_hours + EXCLUDED.storage_byte_hours;
    INSERT INTO cloud_usage_hour (organization_id, deployment_id, tenant, project_id, hour,
      command_count, read_count, storage_byte_hours)
    VALUES (NEW.organization_id, NEW.deployment_id, NEW.tenant_name, NEW.project_id, NEW.hour,
      commands, reads, byte_hours)
    ON CONFLICT (organization_id, deployment_id, tenant, project_id, hour) DO UPDATE SET
      command_count = cloud_usage_hour.command_count + EXCLUDED.command_count,
      read_count = cloud_usage_hour.read_count + EXCLUDED.read_count,
      storage_byte_hours = cloud_usage_hour.storage_byte_hours + EXCLUDED.storage_byte_hours;
    UPDATE cloud_usage_account SET
      command_units = command_units + commands * 5 + reads,
      storage_gb_months = storage_gb_months + byte_hours / 1000000000 / month_hours
    WHERE organization_id = NEW.organization_id AND period = month;
    IF res_period IS NOT NULL THEN
      UPDATE cloud_usage_reservation SET state = 'committed', settled_at = now()
      WHERE identity = NEW.reservation_identity AND state = 'reserved'
      RETURNING organization_id, period, units INTO settled;
      IF FOUND THEN
        UPDATE cloud_usage_account SET reserved_units = reserved_units - settled.units
        WHERE organization_id = settled.organization_id AND period = settled.period;
      END IF;
    END IF;
    RETURN NULL;
  END;
  $$`,
  `CREATE OR REPLACE TRIGGER cloud_meter_count AFTER INSERT ON cloud_meter_evidence
    FOR EACH ROW EXECUTE FUNCTION cloud_meter_count()`,
  `CREATE OR REPLACE FUNCTION cloud_meter_sealed() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    UPDATE cloud_usage_hour h SET sealed = true, sent = NOT EXISTS (
      SELECT 1 FROM cloud_meter_export e
      WHERE e.routing_key = NEW.routing_key AND e.tenant_id = NEW.tenant_id
        AND e.actor_id = NEW.actor_id AND e.hour = NEW.hour
        AND e.organization_id = h.organization_id AND e.status <> 'accepted')
    WHERE h.deployment_id = NEW.deployment_id AND h.tenant = NEW.tenant_name AND h.hour = NEW.hour;
    RETURN NULL;
  END;
  $$`,
  `CREATE OR REPLACE TRIGGER cloud_meter_sealed AFTER INSERT ON cloud_meter_seal
    FOR EACH ROW EXECUTE FUNCTION cloud_meter_sealed()`,
  `CREATE OR REPLACE FUNCTION cloud_meter_sent() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    UPDATE cloud_usage_hour h SET sent = NOT EXISTS (
      SELECT 1 FROM cloud_meter_export e
      WHERE e.routing_key = NEW.routing_key AND e.tenant_id = NEW.tenant_id
        AND e.actor_id = NEW.actor_id AND e.hour = NEW.hour
        AND e.organization_id = NEW.organization_id AND e.status <> 'accepted')
    WHERE h.deployment_id = NEW.deployment_id AND h.tenant = NEW.tenant_name
      AND h.hour = NEW.hour AND h.organization_id = NEW.organization_id AND h.sealed;
    RETURN NULL;
  END;
  $$`,
  `CREATE OR REPLACE TRIGGER cloud_meter_sent AFTER UPDATE OF status ON cloud_meter_export
    FOR EACH ROW EXECUTE FUNCTION cloud_meter_sent()`,
]

/**
 * Reads the metering actor needs from outside its own tables. The actor's
 * writes never go through this service; the triggers are the authority.
 * A database failure is a defect.
 */
export class MeteringRepository extends Context.Service<
  MeteringRepository,
  {
    /**
     * The organization and project a deployment's tenant is metered to: the
     * exact tenant's mapping, else the deployment's `'*'` mapping.
     */
    readonly binding: (
      deployment: string,
      tenant: string,
    ) => Effect.Effect<Option.Option<MeterBinding>>
    /** The provider customer the organization's billing account is durably bound to. */
    readonly customerOf: (organizationId: string) => Effect.Effect<Option.Option<string>>
    /**
     * Publishes a deployment's storage samples of `hour` as each tenant's
     * latest sample, under the same strictly-newer rule the import trigger
     * uses, so the edge's Free storage cap follows a sample before its hour is
     * imported.
     */
    readonly observeStorage: (
      deployment: string,
      hour: DateTime.Utc,
      samples: ReadonlyArray<{ readonly tenant: string; readonly logicalBytes: number }>,
    ) => Effect.Effect<void>
  }
>()("@akter/api/metering-repository/MeteringRepository") {}

/**
 * `MeteringRepository` over the control-plane database; building it creates the
 * metering tables, functions and triggers under one advisory transaction lock,
 * so it must be built before any layer of the `UsageActor`.
 */
export const MeteringRepositoryLive = Layer.effect(
  MeteringRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT pg_advisory_xact_lock(${SCHEMA_LOCK})`

          for (const statement of migrations) yield* sql.unsafe(statement)
        }),
      )
      .pipe(Effect.orDie)

    return {
      binding: (deployment, tenant) =>
        sql<{ readonly organization_id: string; readonly project_id: string }>`
          SELECT organization_id, project_id FROM cloud_meter_tenant
          WHERE deployment_id = ${deployment} AND tenant IN (${tenant}, '*')
          ORDER BY (tenant = '*') LIMIT 1
        `.pipe(
          Effect.map(([row]) =>
            Option.fromNullishOr(row).pipe(
              Option.map((found) => ({
                organizationId: found.organization_id,
                projectId: found.project_id,
              })),
            ),
          ),
          Effect.orDie,
        ),
      customerOf: (organizationId) =>
        sql<{ readonly customer_id: string | null }>`
          SELECT customer_id FROM cloud_billing_account WHERE organization_id = ${organizationId}
        `.pipe(
          Effect.map(([row]) => Option.fromNullishOr(row?.customer_id)),
          Effect.orDie,
        ),
      observeStorage: (deployment, hour, samples) => {
        const ordered = samples.toSorted((left, right) => (left.tenant < right.tenant ? -1 : 1))

        return ordered.length === 0
          ? Effect.void
          : sql`
              SELECT cloud_meter_storage_observe(${deployment}, sampled.tenant,
                ${DateTime.toDateUtc(hour)}, sampled.bytes)
              FROM unnest(${ordered.map(({ tenant }) => tenant)}::text[],
                ${ordered.map(({ logicalBytes }) => logicalBytes)}::float8[])
                AS sampled(tenant, bytes)
            `.pipe(Effect.asVoid, Effect.orDie)
      },
    }
  }),
)
