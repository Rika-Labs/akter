import { Effect } from "effect"
import { Migrator, SqlClient } from "effect/unstable/sql"

/** Every framework migration by id, applied in order above the latest applied id. */
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
      (yield* sql<{
        rows: number
      }>`SELECT count(*)::int AS rows FROM actor_generations`)[0]!.rows > 0
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
    yield* sql`ALTER TABLE actor_outbox ADD COLUMN scheduled_at_ms bigint NOT NULL`
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
  // The placement join keeps every view from being automatically updatable,
  // so writes fail without triggers or rules to maintain.
  "0013_inspection_views": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE SCHEMA durable`
    yield* sql`CREATE VIEW durable.actors AS
      SELECT g.tenant_id, g.actor_type, g.actor_id, g.routing_key, p.placement,
        g.generation, g.created, g.event_sequence AS last_event_sequence
      FROM actor_generations g
      LEFT JOIN actor_placements p ON p.actor_type = g.actor_type`
    yield* sql`CREATE VIEW durable.state AS
      SELECT s.tenant_id, s.actor_type, s.actor_id, s.routing_key, p.placement,
        s.key, s.value, octet_length(s.value) AS value_bytes
      FROM actor_state s
      LEFT JOIN actor_placements p ON p.actor_type = s.actor_type`
    yield* sql`CREATE VIEW durable.receipts AS
      SELECT r.tenant_id, r.actor_type, r.actor_id, r.routing_key, p.placement,
        r.command_id, r.command, r.caller_key,
        r.outcome::jsonb ->> '_tag' AS outcome_tag, r.outcome,
        r.expires_at_ms, to_timestamp(r.expires_at_ms::float8 / 1000) AS expires_at
      FROM actor_receipts r
      LEFT JOIN actor_placements p ON p.actor_type = r.actor_type`
    yield* sql`CREATE VIEW durable.events AS
      SELECT e.tenant_id, e.actor_type, e.actor_id, e.routing_key, p.placement,
        e.sequence, e.event, e.command_id, e.value, octet_length(e.value) AS value_bytes,
        e.emitted_at_ms, to_timestamp(e.emitted_at_ms::float8 / 1000) AS emitted_at
      FROM actor_events e
      LEFT JOIN actor_placements p ON p.actor_type = e.actor_type`
    yield* sql`CREATE VIEW durable.outbox AS
      SELECT o.tenant_id, o.actor_type, o.actor_id, o.routing_key, p.placement,
        o.intent_id, o.timer_key, o.target_type, o.target_id, o.command, o.payload, o.caller,
        o.attempts, o.last_error, o.due_at_ms, to_timestamp(o.due_at_ms::float8 / 1000) AS due_at
      FROM actor_outbox o
      LEFT JOIN actor_placements p ON p.actor_type = o.actor_type
      WHERE o.kind = 'intent'`
    yield* sql`CREATE VIEW durable.timers AS
      SELECT o.tenant_id, o.actor_type, o.actor_id, o.routing_key, p.placement,
        o.timer_key, o.intent_id, o.target_type, o.target_id, o.command, o.payload, o.caller,
        o.attempts, o.due_at_ms, to_timestamp(o.due_at_ms::float8 / 1000) AS due_at
      FROM actor_outbox o
      LEFT JOIN actor_placements p ON p.actor_type = o.actor_type
      WHERE o.kind = 'intent' AND o.timer_key IS NOT NULL`
    yield* sql`CREATE VIEW durable.effects AS
      SELECT o.tenant_id, o.actor_type, o.actor_id, o.routing_key, p.placement,
        o.intent_id AS effect_id, o.command AS effect, o.payload, o.caller,
        o.attempts, o.last_error, o.ambiguous,
        o.due_at_ms, to_timestamp(o.due_at_ms::float8 / 1000) AS due_at
      FROM actor_outbox o
      LEFT JOIN actor_placements p ON p.actor_type = o.actor_type
      WHERE o.kind = 'effect'`
    yield* sql`CREATE VIEW durable.dead_letters AS
      SELECT d.tenant_id, d.actor_type, d.actor_id, d.routing_key, p.placement,
        d.effect_id, d.effect, d.payload, d.attempts, d.cause, d.ambiguous,
        d.dead_at_ms, to_timestamp(d.dead_at_ms::float8 / 1000) AS dead_at
      FROM actor_dead_letters d
      LEFT JOIN actor_placements p ON p.actor_type = d.actor_type`
    yield* sql`CREATE VIEW durable.workflows AS
      SELECT w.tenant_id, w.actor_type, w.actor_id, w.routing_key, p.placement,
        w.execution_id, w.workflow, w.workflow_key, w.manifest_hash, w.status, w.interrupt,
        w.caller, w.payload, octet_length(w.payload) AS payload_bytes,
        w.result, octet_length(w.result) AS result_bytes,
        w.started_at_ms, to_timestamp(w.started_at_ms::float8 / 1000) AS started_at,
        w.finished_at_ms, to_timestamp(w.finished_at_ms::float8 / 1000) AS finished_at
      FROM actor_workflow_executions w
      LEFT JOIN actor_placements p ON p.actor_type = w.actor_type`
    yield* sql`CREATE VIEW durable.workflow_steps AS
      SELECT s.tenant_id, s.actor_type, s.actor_id, s.routing_key, p.placement,
        s.execution_id, s.step, s.attempt, s.kind, s.exit, s.wait_event, s.version,
        s.due_at_ms, to_timestamp(s.due_at_ms::float8 / 1000) AS due_at,
        s.started_at_ms, to_timestamp(s.started_at_ms::float8 / 1000) AS started_at,
        s.settled_at_ms, to_timestamp(s.settled_at_ms::float8 / 1000) AS settled_at
      FROM actor_workflow_step s
      LEFT JOIN actor_placements p ON p.actor_type = s.actor_type`
    // The catalog is how a tool checks which view versions a database has.
    yield* sql`CREATE VIEW durable.views AS
      SELECT view_name, version FROM (VALUES
        ('actors', 1), ('state', 1), ('receipts', 1), ('events', 1), ('outbox', 1),
        ('timers', 1), ('effects', 1), ('dead_letters', 1), ('workflows', 1),
        ('workflow_steps', 1), ('views', 1)
      ) AS v(view_name, version)`
  }),
  // A connection's session lives beside the actor's rows; its socket and
  // buffers live at the holder runner named by `holder` and `holder_epoch`.
  "0014_connections": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE actor_connections (
        routing_key bigint NOT NULL,
        connection_id text NOT NULL,
        bucket integer NOT NULL CHECK (bucket = routing_key >> 56),
        tenant_id text NOT NULL,
        actor_type text NOT NULL,
        actor_id text NOT NULL,
        member text NOT NULL,
        holder text NOT NULL,
        holder_epoch text NOT NULL,
        caller text NOT NULL,
        session bytea,
        frame_seq bigint NOT NULL DEFAULT 0,
        opened_at_ms bigint NOT NULL,
        opened_through bigint NOT NULL,
        PRIMARY KEY (routing_key, tenant_id, actor_type, actor_id, connection_id),
        FOREIGN KEY (routing_key, tenant_id, actor_type, actor_id) REFERENCES actor_generations
      )`
    yield* sql`CREATE INDEX actor_connections_holder ON actor_connections (bucket, holder, holder_epoch)`
  }),
  "0015_effect_control": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE actor_outbox
      ADD COLUMN running boolean NOT NULL DEFAULT false,
      ADD COLUMN cancelled_at_ms bigint,
      ADD COLUMN maybe_applied boolean NOT NULL DEFAULT false,
      ADD COLUMN ready_at_ms bigint,
      ADD COLUMN waiting boolean NOT NULL DEFAULT false,
      ADD CONSTRAINT actor_outbox_effect_ready CHECK (kind <> 'effect' OR ready_at_ms IS NOT NULL)`
    yield* sql`CREATE INDEX actor_outbox_running
      ON actor_outbox (routing_key, tenant_id, actor_type, actor_id, command)
      WHERE kind = 'effect' AND running`
    yield* sql`CREATE INDEX actor_outbox_effect_queue
      ON actor_outbox (routing_key, tenant_id, actor_type, actor_id, command, ready_at_ms, intent_id)
      WHERE kind = 'effect' AND NOT running`
  }),
  // An attempt can end an effect before its retries run out, as when its
  // route rejects the result. `final_failure` records that, with the outcome,
  // so a dead letter that fails to commit is retried without another
  // provider call.
  "0016_final_effect_failures": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE actor_outbox ADD COLUMN final_failure boolean NOT NULL DEFAULT false`
  }),
  // Subscriptions fan out on the source's shard after commit: one row per
  // (source, subscription, subscriber), routed rows with subscriber_id = ''.
  // The tag summary makes the publisher's probe a key lookup per emitted tag,
  // and the subscriber's cursor, on its own shard, deduplicates every
  // delivery after its receipt is pruned. The due index leads with
  // `subscriber_type` so a runner never scans types it doesn't register.
  "0017_subscriptions": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE actor_subscriptions (
        routing_key bigint NOT NULL,
        tenant_id text NOT NULL,
        source_type text NOT NULL,
        source_id text NOT NULL,
        subscriber_type text NOT NULL,
        subscription text NOT NULL,
        subscriber_id text NOT NULL,
        events text[] NOT NULL,
        epoch bigint NOT NULL DEFAULT 0,
        active boolean NOT NULL DEFAULT true,
        delivered bigint NOT NULL,
        marked bigint NOT NULL DEFAULT 0,
        bucket integer NOT NULL CHECK (bucket = routing_key >> 56),
        due_at_ms bigint,
        attempts integer NOT NULL DEFAULT 0,
        last_error text,
        gaps bigint NOT NULL DEFAULT 0,
        gap_at_ms bigint,
        gap_through bigint,
        PRIMARY KEY (routing_key, tenant_id, source_type, source_id, subscriber_type, subscription, subscriber_id),
        FOREIGN KEY (routing_key, tenant_id, source_type, source_id) REFERENCES actor_generations
      ) WITH (fillfactor = 80)`
    yield* sql`CREATE INDEX actor_subscriptions_due ON actor_subscriptions (bucket, subscriber_type, due_at_ms)
        WHERE due_at_ms IS NOT NULL`
    yield* sql`CREATE TABLE actor_subscription_tags (
        routing_key bigint NOT NULL,
        tenant_id text NOT NULL,
        source_type text NOT NULL,
        source_id text NOT NULL,
        event text NOT NULL,
        rows integer NOT NULL CHECK (rows > 0),
        PRIMARY KEY (routing_key, tenant_id, source_type, source_id, event),
        FOREIGN KEY (routing_key, tenant_id, source_type, source_id) REFERENCES actor_generations
      )`
    yield* sql`CREATE TABLE actor_subscription_cursors (
        routing_key bigint NOT NULL,
        tenant_id text NOT NULL,
        actor_type text NOT NULL,
        actor_id text NOT NULL,
        subscription text NOT NULL,
        source_type text NOT NULL,
        source_id text NOT NULL,
        epoch bigint NOT NULL DEFAULT 0,
        active boolean NOT NULL DEFAULT true,
        applied bigint NOT NULL,
        PRIMARY KEY (routing_key, tenant_id, actor_type, actor_id, subscription, source_type, source_id),
        FOREIGN KEY (routing_key, tenant_id, actor_type, actor_id) REFERENCES actor_generations
      )`
    // The routed declarations of the deployment, by source type: a runner
    // that serves a source must register every subscriber type routing from
    // it, because the publishing turn creates the routed rows.
    yield* sql`CREATE TABLE actor_routed_subscriptions (
        source_type text NOT NULL,
        subscriber_type text NOT NULL,
        subscription text NOT NULL,
        PRIMARY KEY (source_type, subscriber_type, subscription)
      )`
    yield* sql`ALTER TABLE actor_outbox DROP CONSTRAINT actor_outbox_kind_check,
        ADD CONSTRAINT actor_outbox_kind_check CHECK (kind IN ('intent', 'effect', 'feed', 'control'))`
  }),
  // Every tenant row admits only the tenant its transaction names. The table
  // owner and superusers are exempt, so nothing changes until a deployment
  // runs its turns and views as a role that is neither.
  "0018_rls": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    for (const table of [
      "actor_generations",
      "actor_state",
      "actor_receipts",
      "actor_outbox",
      "actor_events",
      "actor_dead_letters",
      "actor_blobs",
      "actor_workflow_executions",
      "actor_workflow_step",
      "actor_connections",
      "actor_subscriptions",
      "actor_subscription_tags",
      "actor_subscription_cursors",
    ]) {
      yield* sql`ALTER TABLE ${sql(table)} ENABLE ROW LEVEL SECURITY`
      yield* sql`CREATE POLICY durable_tenant ON ${sql(table)}
          USING (tenant_id = current_setting('durable.tenant', true))
          WITH CHECK (tenant_id = current_setting('durable.tenant', true))`
    }
  }),
  // Content is stored once per tenant on the tenant's routing key; actors
  // hold references on their own shard. Nothing counts references and no key
  // points from a reference or a chunk to a content row: the sweep finds
  // unreferenced content by scanning references, and grants gate it.
  "0020_content_blobs": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    // Grants name the database they were issued by, so a key shared with
    // another deployment never makes its grants valid here.
    yield* sql`ALTER TABLE actor_deployment
        ADD COLUMN deployment_id text NOT NULL DEFAULT gen_random_uuid()::text`
    yield* sql`CREATE TABLE tenant_contents (
        routing_key bigint NOT NULL,
        tenant_id text NOT NULL,
        hash text NOT NULL,
        size bigint NOT NULL CHECK (size >= 0),
        granted_until_ms bigint NOT NULL,
        PRIMARY KEY (routing_key, tenant_id, hash)
      )`
    yield* sql`CREATE INDEX tenant_contents_granted
        ON tenant_contents (routing_key, tenant_id, granted_until_ms, hash)`
    yield* sql`CREATE TABLE tenant_content_chunks (
        routing_key bigint NOT NULL,
        tenant_id text NOT NULL,
        hash text NOT NULL,
        chunk integer NOT NULL CHECK (chunk >= 0),
        bytes bytea NOT NULL,
        PRIMARY KEY (routing_key, tenant_id, hash, chunk)
      )`
    yield* sql`CREATE TABLE actor_content_refs (
        routing_key bigint NOT NULL,
        tenant_id text NOT NULL,
        actor_type text NOT NULL,
        actor_id text NOT NULL,
        blob text NOT NULL,
        name text NOT NULL,
        hash text NOT NULL,
        size bigint NOT NULL CHECK (size >= 0),
        PRIMARY KEY (routing_key, tenant_id, actor_type, actor_id, blob, name),
        FOREIGN KEY (routing_key, tenant_id, actor_type, actor_id) REFERENCES actor_generations
      )`
    yield* sql`CREATE INDEX actor_content_refs_hash ON actor_content_refs (tenant_id, hash)`
    // Every tenant that ever uploaded, and when its content was last swept.
    yield* sql`CREATE TABLE tenant_content_sweeps (
        routing_key bigint NOT NULL,
        tenant_id text NOT NULL,
        swept_at_ms bigint NOT NULL,
        PRIMARY KEY (routing_key, tenant_id)
      )`

    // A query reads references and chunks as the tenant role when row-level
    // security is on; uploads, grants, and the sweep keep the exempt connecting role.
    for (const table of [
      "actor_content_refs",
      "tenant_contents",
      "tenant_content_chunks",
      "tenant_content_sweeps",
    ]) {
      yield* sql`ALTER TABLE ${sql(table)} ENABLE ROW LEVEL SECURITY`
      yield* sql`CREATE POLICY durable_tenant ON ${sql(table)}
          USING (tenant_id = current_setting('durable.tenant', true))
          WITH CHECK (tenant_id = current_setting('durable.tenant', true))`
    }

    // The longest turn of each actor type that declares content, which the
    // sweep waits out; it only grows, so a runner still on an earlier
    // deploy with longer turns stays covered.
    yield* sql`CREATE TABLE actor_content_types (
        actor_type text PRIMARY KEY,
        turn_ms bigint NOT NULL CHECK (turn_ms > 0)
      )`
    // The sweep join shows how far each tenant's collection lags, and keeps
    // the view from being automatically updatable.
    yield* sql`CREATE VIEW durable.contents AS
      SELECT c.tenant_id, c.routing_key, c.hash, c.size,
        c.granted_until_ms, to_timestamp(c.granted_until_ms::float8 / 1000) AS granted_until,
        s.swept_at_ms, to_timestamp(s.swept_at_ms::float8 / 1000) AS swept_at
      FROM tenant_contents c
      LEFT JOIN tenant_content_sweeps s ON s.routing_key = c.routing_key AND s.tenant_id = c.tenant_id`
    yield* sql`CREATE VIEW durable.content_refs AS
      SELECT r.tenant_id, r.actor_type, r.actor_id, r.routing_key, p.placement,
        r.blob, r.name, r.hash, r.size
      FROM actor_content_refs r
      LEFT JOIN actor_placements p ON p.actor_type = r.actor_type`
    yield* sql`CREATE OR REPLACE VIEW durable.views AS
      SELECT view_name, version FROM (VALUES
        ('actors', 1), ('state', 1), ('receipts', 1), ('events', 1), ('outbox', 1),
        ('timers', 1), ('effects', 1), ('dead_letters', 1), ('workflows', 1),
        ('workflow_steps', 1), ('views', 1), ('contents', 1), ('content_refs', 1)
      ) AS v(view_name, version)`
  }),
  // Stored events and effect payloads carry the version of their class's
  // migration chain they were written at; readers upcast from it. A settled
  // effect row becomes its route intent and goes back to 0. The two tables
  // let startup refuse a deploy that would strand a stored version:
  // `actor_payload_versions` records each version some runtime has written,
  // and `actor_payload_writers` is each runtime's heartbeat per version it
  // writes, which a clear waits out before it scans.
  // Nothing written before it has a recorded version, so a database that
  // already holds events or effect rows is refused rather than guessed at.
  "0021_payload_versions": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const [held] = yield* sql<{ held: boolean }>`SELECT
      EXISTS (SELECT 1 FROM actor_events) OR EXISTS (SELECT 1 FROM actor_outbox)
        OR EXISTS (SELECT 1 FROM actor_dead_letters) AS held`

    if (held?.held === true)
      return yield* new Migrator.MigrationError({
        kind: "BadState",
        message:
          "Migration 0021_payload_versions needs a database without events, outbox rows, or dead letters; recreate this development database",
      })
    yield* sql`ALTER TABLE actor_events ADD COLUMN payload_version integer NOT NULL DEFAULT 0
      CHECK (payload_version >= 0)`
    yield* sql`ALTER TABLE actor_outbox ADD COLUMN payload_version integer NOT NULL DEFAULT 0
      CHECK (payload_version >= 0)`
    yield* sql`ALTER TABLE actor_dead_letters ADD COLUMN payload_version integer NOT NULL DEFAULT 0
      CHECK (payload_version >= 0)`
    yield* sql`CREATE TABLE actor_payload_versions (
        actor_type text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('event', 'effect')),
        tag text NOT NULL,
        version integer NOT NULL CHECK (version >= 0),
        first_written_at_ms bigint NOT NULL,
        superseded_at_ms bigint,
        cleared_at_ms bigint,
        PRIMARY KEY (actor_type, kind, tag, version)
      )`
    yield* sql`CREATE TABLE actor_payload_writers (
        runtime_id text NOT NULL,
        actor_type text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('event', 'effect')),
        tag text NOT NULL,
        version integer NOT NULL CHECK (version >= 0),
        window_ms bigint NOT NULL CHECK (window_ms > 0),
        refreshed_at_ms bigint NOT NULL,
        PRIMARY KEY (runtime_id, actor_type, kind, tag, version)
      )`
    yield* sql`CREATE INDEX actor_payload_writers_version
      ON actor_payload_writers (actor_type, kind, tag, version, refreshed_at_ms)`
    // Columns are added at the end, which a view version allows.
    yield* sql`CREATE OR REPLACE VIEW durable.events AS
      SELECT e.tenant_id, e.actor_type, e.actor_id, e.routing_key, p.placement,
        e.sequence, e.event, e.command_id, e.value, octet_length(e.value) AS value_bytes,
        e.emitted_at_ms, to_timestamp(e.emitted_at_ms::float8 / 1000) AS emitted_at,
        e.payload_version
      FROM actor_events e
      LEFT JOIN actor_placements p ON p.actor_type = e.actor_type`
    yield* sql`CREATE OR REPLACE VIEW durable.effects AS
      SELECT o.tenant_id, o.actor_type, o.actor_id, o.routing_key, p.placement,
        o.intent_id AS effect_id, o.command AS effect, o.payload, o.caller,
        o.attempts, o.last_error, o.ambiguous,
        o.due_at_ms, to_timestamp(o.due_at_ms::float8 / 1000) AS due_at,
        o.payload_version
      FROM actor_outbox o
      LEFT JOIN actor_placements p ON p.actor_type = o.actor_type
      WHERE o.kind = 'effect'`
    yield* sql`CREATE OR REPLACE VIEW durable.dead_letters AS
      SELECT d.tenant_id, d.actor_type, d.actor_id, d.routing_key, p.placement,
        d.effect_id, d.effect, d.payload, d.attempts, d.cause, d.ambiguous,
        d.dead_at_ms, to_timestamp(d.dead_at_ms::float8 / 1000) AS dead_at,
        d.payload_version
      FROM actor_dead_letters d
      LEFT JOIN actor_placements p ON p.actor_type = d.actor_type`
  }),
  // A parent-placed type routes through its parent type's placement, so the
  // parent is part of the record a later build must match.
  "0022_parent_placement": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE actor_placements ADD COLUMN parent_type text,
        DROP CONSTRAINT actor_placements_placement_check,
        ADD CONSTRAINT actor_placements_placement_check
          CHECK (placement IN ('tenant', 'actor', 'parent')),
        ADD CONSTRAINT actor_placements_parent_type_check
          CHECK ((placement = 'parent') = (parent_type IS NOT NULL))`
  }),
  // Every authorized operator action, and every authenticated one refused by
  // scope. A repair writes its row in its own transaction, on the target
  // actor's routing key, so the two commit together on one shard; a
  // tenant-wide action uses the tenant's routing key. Rows are never pruned.
  "0023_operator_audit": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE actor_operator_audit (
        routing_key bigint NOT NULL,
        audit_id text NOT NULL,
        at_ms bigint NOT NULL,
        operator text NOT NULL,
        action text NOT NULL,
        tenant_id text NOT NULL,
        actor_type text,
        actor_id text,
        target text,
        capability text,
        reason text,
        outcome text NOT NULL,
        PRIMARY KEY (routing_key, audit_id)
      )`
    yield* sql`CREATE INDEX actor_operator_audit_tenant ON actor_operator_audit (tenant_id, at_ms)`
    yield* sql`ALTER TABLE actor_operator_audit ENABLE ROW LEVEL SECURITY`
    yield* sql`CREATE POLICY durable_tenant ON actor_operator_audit
        USING (tenant_id = current_setting('durable.tenant', true))
        WITH CHECK (tenant_id = current_setting('durable.tenant', true))`
    // The join keeps the view read-only, as every other `durable` view is.
    yield* sql`CREATE VIEW durable.operator_audit AS
      SELECT a.tenant_id, a.actor_type, a.actor_id, a.routing_key, p.placement, a.audit_id,
        a.operator, a.action, a.target, a.capability, a.reason, a.outcome,
        a.at_ms, to_timestamp(a.at_ms::float8 / 1000) AS at
      FROM actor_operator_audit a
      LEFT JOIN actor_placements p ON p.actor_type = a.actor_type`
    yield* sql`CREATE OR REPLACE VIEW durable.views AS
      SELECT view_name, version FROM (VALUES
        ('actors', 1), ('state', 1), ('receipts', 1), ('events', 1), ('outbox', 1),
        ('timers', 1), ('effects', 1), ('dead_letters', 1), ('workflows', 1),
        ('workflow_steps', 1), ('views', 1), ('contents', 1), ('content_refs', 1),
        ('operator_audit', 1)
      ) AS v(view_name, version)`
  }),
}

/**
 * Runs `record` like `Migrator`, but first refuses a database where a
 * registered id below the latest applied one was never applied: `Migrator`
 * would skip it forever, leaving its tables missing.
 */
export const migrator = (
  record: Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>>,
) => {
  const run = Migrator.make({})({
    table: "actor_migrations",
    loader: Migrator.fromRecord(record),
  })

  const registered = Object.keys(record).map((key) => Number(key.split("_")[0]))

  const refuseSkipped = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const [table] = yield* sql<{
      readonly name: string | null
    }>`SELECT to_regclass('actor_migrations')::text AS name`

    const rows =
      table?.name == null
        ? []
        : yield* sql<{ readonly id: number }>`SELECT migration_id::int AS id FROM actor_migrations`

    const applied = new Set(rows.map(({ id }) => id))
    const latest = Math.max(0, ...applied)
    const skipped = registered.filter((id) => id < latest && !applied.has(id)).sort((a, b) => a - b)

    if (skipped.length > 0) {
      return yield* new Migrator.MigrationError({
        kind: "BadState",
        message: `Migrations ${skipped.join(", ")} were never applied but migration ${latest} was; they would be skipped. Restore this database from before migration ${latest} or recreate it.`,
      })
    }
  })

  // A concurrent runner with fewer migrations can commit a higher id between
  // the first check and the migration lock, so the result is checked again.
  return refuseSkipped.pipe(
    Effect.andThen(run),
    Effect.tap(() => refuseSkipped),
  )
}

export const migrate = migrator(migrations)
