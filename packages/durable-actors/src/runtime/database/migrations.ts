import { Effect } from "effect"
import { Migrator, SqlClient } from "effect/unstable/sql"

// DDL rollback and restart evidence: testing/conformance/crash/main.test.ts.
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
  }),
})
