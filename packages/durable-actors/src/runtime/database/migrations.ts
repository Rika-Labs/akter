import { Effect } from "effect"
import { Migrator, SqlClient } from "effect/unstable/sql"

export const migrate = Migrator.make({})({
  table: "actor_migrations",
  loader: Migrator.fromRecord({
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
        (yield* sql<{ rows: number }>`SELECT count(*)::int AS rows FROM actor_generations`)[0]!
          .rows > 0
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
  }),
})
