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
  // Read-only views in the `durable` schema are the supported way to inspect
  // runtime rows from SQL. Every column they expose is public; base-table
  // columns they leave out stay private. Each view joins its actor type's
  // placement, so Postgres never treats one as an automatically updatable
  // single-table view, and a write through it fails before touching a row.
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
        r.command_id, r.command, r.caller_key AS caller,
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
    // The catalog is how a tool checks which view versions a database has.
    yield* sql`CREATE VIEW durable.views AS
      SELECT view_name, version FROM (VALUES
        ('actors', 1), ('state', 1), ('receipts', 1), ('events', 1), ('outbox', 1),
        ('timers', 1), ('effects', 1), ('dead_letters', 1), ('views', 1)
      ) AS v(view_name, version)`
  }),
}

export const migrate = Migrator.make({})({
  table: "actor_migrations",
  loader: Migrator.fromRecord(migrations),
})
