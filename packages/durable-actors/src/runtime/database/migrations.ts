import { Effect } from "effect"
import { Migrator, SqlClient } from "effect/unstable/sql"

/** Every framework migration by id; the migrator runs ids above the latest applied one, in order. */
export const migrations = {
  "0001_foundation": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE actor_deployment (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        protocol integer NOT NULL,
        retry_window_ms bigint NOT NULL CHECK (retry_window_ms > 0)
      )`
    yield* sql`CREATE TABLE actor_generations (
        tenant_id text NOT NULL,
        actor_type text NOT NULL,
        actor_id text NOT NULL,
        generation bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, actor_type, actor_id)
      )`
    yield* sql`CREATE TABLE actor_state (
        tenant_id text NOT NULL,
        actor_type text NOT NULL,
        actor_id text NOT NULL,
        key text NOT NULL,
        value jsonb NOT NULL,
        PRIMARY KEY (tenant_id, actor_type, actor_id, key),
        FOREIGN KEY (tenant_id, actor_type, actor_id) REFERENCES actor_generations
      )`
    yield* sql`CREATE TABLE actor_receipts (
        tenant_id text NOT NULL,
        actor_type text NOT NULL,
        actor_id text NOT NULL,
        command_id text NOT NULL,
        command text NOT NULL,
        payload_hash text NOT NULL,
        caller_key text NOT NULL,
        outcome text NOT NULL,
        expires_at_ms bigint NOT NULL,
        PRIMARY KEY (tenant_id, actor_type, actor_id, command_id),
        FOREIGN KEY (tenant_id, actor_type, actor_id) REFERENCES actor_generations
      )`
  }),
  "0002_creation": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE actor_generations ADD COLUMN created boolean NOT NULL DEFAULT false`
  }),
  // Every framework row carries its routing key, leading the primary key so
  // a shard index can place it; state is opaque bytea.
  "0003_routing_state": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    if (
      (yield* sql<{ rows: number }>`SELECT count(*)::int AS rows FROM actor_generations`)[0]!.rows >
      0
    )
      return yield* Effect.die(
        new Error("0003 requires an empty foundation database; M0 stored no production data"),
      )

    yield* sql`DROP TABLE actor_receipts`
    yield* sql`DROP TABLE actor_state`
    yield* sql`DROP TABLE actor_generations`
    yield* sql`CREATE TABLE actor_generations (
        routing_key bigint NOT NULL,
        tenant_id text NOT NULL,
        actor_type text NOT NULL,
        actor_id text NOT NULL,
        generation bigint NOT NULL DEFAULT 0,
        created boolean NOT NULL DEFAULT false,
        PRIMARY KEY (routing_key, tenant_id, actor_type, actor_id)
      ) WITH (fillfactor = 80)`
    yield* sql`CREATE TABLE actor_state (
        routing_key bigint NOT NULL,
        tenant_id text NOT NULL,
        actor_type text NOT NULL,
        actor_id text NOT NULL,
        key text NOT NULL,
        value bytea NOT NULL,
        PRIMARY KEY (routing_key, tenant_id, actor_type, actor_id, key),
        FOREIGN KEY (routing_key, tenant_id, actor_type, actor_id) REFERENCES actor_generations
      ) WITH (fillfactor = 80)`
    yield* sql`CREATE TABLE actor_receipts (
        routing_key bigint NOT NULL,
        tenant_id text NOT NULL,
        actor_type text NOT NULL,
        actor_id text NOT NULL,
        command_id text NOT NULL,
        command text NOT NULL,
        payload_hash text NOT NULL,
        caller_key text NOT NULL,
        outcome text NOT NULL,
        expires_at_ms bigint NOT NULL,
        PRIMARY KEY (routing_key, tenant_id, actor_type, actor_id, command_id),
        FOREIGN KEY (routing_key, tenant_id, actor_type, actor_id) REFERENCES actor_generations
      )`
    // Placement and its encoding decide every row's routing key, so a
    // change would fork each existing actor into a second identity.
    yield* sql`CREATE TABLE actor_placements (
        actor_type text PRIMARY KEY,
        placement text NOT NULL CHECK (placement IN ('tenant', 'actor')),
        encoding integer NOT NULL
      )`
  }),
  // Every intent and timer lives on its sender's shard. `bucket` is the top
  // eight bits of `routing_key`, so the relay probes `(bucket, due_at_ms)` and
  // never reads actors with nothing due.
  "0004_outbox": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE actor_outbox (
        routing_key bigint NOT NULL,
        intent_id text NOT NULL,
        bucket integer NOT NULL CHECK (bucket = routing_key >> 56),
        due_at_ms bigint NOT NULL,
        tenant_id text NOT NULL,
        actor_type text NOT NULL,
        actor_id text NOT NULL,
        timer_key text,
        target_type text NOT NULL,
        target_id text NOT NULL,
        command text NOT NULL,
        payload text NOT NULL,
        caller text NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        PRIMARY KEY (routing_key, intent_id),
        FOREIGN KEY (routing_key, tenant_id, actor_type, actor_id) REFERENCES actor_generations
      )`
    yield* sql`CREATE INDEX actor_outbox_due ON actor_outbox (bucket, due_at_ms)`
    yield* sql`CREATE UNIQUE INDEX actor_outbox_timer
        ON actor_outbox (routing_key, tenant_id, actor_type, actor_id, timer_key)
        WHERE timer_key IS NOT NULL`
  }),
  // Application tables come from drizzle-kit; the framework only records
  // which actor type owns each one, so a second owner cannot read its rows.
  "0005_tables": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE actor_tables (
        table_schema text NOT NULL,
        table_name text NOT NULL,
        actor_type text NOT NULL,
        PRIMARY KEY (table_schema, table_name)
      )`
  }),
  // Events share the actor's routing key and commit with its turn. The
  // sequence counter lives on the fenced generation row, so a pruned stream
  // never reissues a cursor.
  "0006_events": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE actor_generations ADD COLUMN event_sequence bigint NOT NULL DEFAULT 0`
    yield* sql`CREATE TABLE actor_events (
        routing_key bigint NOT NULL,
        tenant_id text NOT NULL,
        actor_type text NOT NULL,
        actor_id text NOT NULL,
        sequence bigint NOT NULL CHECK (sequence > 0),
        event text NOT NULL,
        command_id text NOT NULL,
        value bytea NOT NULL,
        emitted_at_ms bigint NOT NULL,
        PRIMARY KEY (routing_key, tenant_id, actor_type, actor_id, sequence),
        FOREIGN KEY (routing_key, tenant_id, actor_type, actor_id) REFERENCES actor_generations
      )`
  }),
  // An effect is an outbox row whose executor runs when it is due. On
  // success or exhaustion it becomes an intent to its route, so the route
  // is delivered like any intent, with the effect id as its command id.
  // `ambiguous` records whether the last attempt's outcome is unknown.
  "0008_effects": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE actor_outbox
        ADD COLUMN kind text NOT NULL DEFAULT 'intent' CHECK (kind IN ('intent', 'effect')),
        ADD COLUMN last_error text,
        ADD COLUMN ambiguous boolean NOT NULL DEFAULT false`
    // Exhausted effects stay visible to operators after their row settles.
    yield* sql`CREATE TABLE actor_dead_letters (
        routing_key bigint NOT NULL,
        effect_id text NOT NULL,
        tenant_id text NOT NULL,
        actor_type text NOT NULL,
        actor_id text NOT NULL,
        effect text NOT NULL,
        payload text NOT NULL,
        attempts integer NOT NULL,
        cause text NOT NULL,
        ambiguous boolean NOT NULL,
        dead_at_ms bigint NOT NULL,
        PRIMARY KEY (routing_key, effect_id),
        FOREIGN KEY (routing_key, tenant_id, actor_type, actor_id) REFERENCES actor_generations
      )`
  }),
  // Blob entries are chunked bytea beside the actor's other rows: `append`
  // adds a chunk without rewriting earlier ones, and `compact` folds them into chunk 0.
  "0009_blobs": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE actor_blobs (
        routing_key bigint NOT NULL,
        tenant_id text NOT NULL,
        actor_type text NOT NULL,
        actor_id text NOT NULL,
        blob text NOT NULL,
        name text NOT NULL,
        chunk integer NOT NULL CHECK (chunk >= 0),
        bytes bytea NOT NULL,
        PRIMARY KEY (routing_key, tenant_id, actor_type, actor_id, blob, name, chunk),
        FOREIGN KEY (routing_key, tenant_id, actor_type, actor_id) REFERENCES actor_generations
      )`
  }),
  // Cleanup reads each actor type's oldest receipts and events by age, and
  // keeps a receipt while an outbox row with its id can still be redelivered;
  // these indexes keep every cleanup batch a range read.
  "0010_retention": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE INDEX actor_receipts_expiry ON actor_receipts (actor_type, expires_at_ms)`
    yield* sql`CREATE INDEX actor_events_emitted ON actor_events (actor_type, emitted_at_ms)`
    yield* sql`CREATE INDEX actor_outbox_intent ON actor_outbox (intent_id)`
  }),
  // Claims and backoff move `due_at_ms`, so `scheduled_at_ms` keeps the time a
  // row first became due. `kind` follows `bucket` in the due index so intent
  // scans never read effect rows waiting for an executor, and the reverse.
  "0011_relay": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE actor_outbox ADD COLUMN scheduled_at_ms bigint`
    yield* sql`CREATE INDEX actor_outbox_due_kind ON actor_outbox (bucket, kind, due_at_ms)`
    yield* sql`DROP INDEX actor_outbox_due`
  }),
  // Workflow executions, their recorded steps, and the manifests deployments
  // accepted. Every execution and step row lives on its owner's shard; a step
  // row is written pending before its work starts and settled once.
  "0012_workflows": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE actor_workflow_executions (
        routing_key bigint NOT NULL,
        execution_id text NOT NULL,
        bucket integer NOT NULL CHECK (bucket = routing_key >> 56),
        tenant_id text NOT NULL,
        actor_type text NOT NULL,
        actor_id text NOT NULL,
        workflow text NOT NULL,
        workflow_key text NOT NULL,
        manifest_hash text NOT NULL,
        payload bytea NOT NULL,
        caller text NOT NULL,
        event_cursor bigint NOT NULL,
        status text NOT NULL CHECK (status IN ('running', 'suspended', 'finished')),
        interrupt boolean NOT NULL DEFAULT false,
        result bytea,
        started_at_ms bigint NOT NULL,
        finished_at_ms bigint,
        PRIMARY KEY (routing_key, execution_id),
        FOREIGN KEY (routing_key, tenant_id, actor_type, actor_id) REFERENCES actor_generations,
        CHECK ((status = 'finished') = (result IS NOT NULL AND finished_at_ms IS NOT NULL))
      )`
    yield* sql`CREATE INDEX actor_workflow_executions_open
        ON actor_workflow_executions (routing_key, tenant_id, actor_type, actor_id)
        WHERE status <> 'finished'`
    yield* sql`CREATE INDEX actor_workflow_executions_finished
        ON actor_workflow_executions (bucket, finished_at_ms)
        WHERE status = 'finished'`
    yield* sql`CREATE INDEX actor_workflow_executions_check
        ON actor_workflow_executions (actor_type, workflow, manifest_hash)
        WHERE status <> 'finished'`
    yield* sql`CREATE TABLE actor_workflow_step (
        routing_key bigint NOT NULL,
        execution_id text NOT NULL,
        tenant_id text NOT NULL,
        actor_type text NOT NULL,
        actor_id text NOT NULL,
        step text NOT NULL,
        attempt integer NOT NULL,
        kind text NOT NULL CHECK (kind IN ('activity', 'clock', 'deferred', 'wait', 'version')),
        exit bytea,
        due_at_ms bigint,
        wait_event text,
        wait_after bigint,
        scanned bigint,
        matched bigint,
        version integer,
        started_at_ms bigint NOT NULL,
        settled_at_ms bigint,
        PRIMARY KEY (routing_key, execution_id, step, attempt),
        FOREIGN KEY (routing_key, execution_id) REFERENCES actor_workflow_executions ON DELETE CASCADE,
        CHECK ((kind = 'wait') = (wait_event IS NOT NULL AND wait_after IS NOT NULL AND scanned IS NOT NULL)),
        CHECK ((kind = 'clock') <= (due_at_ms IS NOT NULL)),
        CHECK ((kind = 'version') = (version IS NOT NULL AND exit IS NULL))
      )`
    yield* sql`CREATE INDEX actor_workflow_step_waits
        ON actor_workflow_step (routing_key, tenant_id, actor_type, actor_id, wait_event)
        WHERE kind = 'wait' AND exit IS NULL`
    yield* sql`CREATE TABLE actor_workflow_manifests (
        actor_type text NOT NULL,
        workflow text NOT NULL,
        manifest_hash text NOT NULL,
        manifest jsonb NOT NULL,
        accepted_at_ms bigint NOT NULL,
        PRIMARY KEY (actor_type, workflow, manifest_hash)
      )`
  }),
}

export const migrate = Migrator.make({})({
  table: "actor_migrations",
  loader: Migrator.fromRecord(migrations),
})
