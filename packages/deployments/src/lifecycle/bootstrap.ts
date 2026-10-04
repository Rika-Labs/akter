import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"

const ownership = `routing_key bigint NOT NULL, tenant_id text NOT NULL, actor_id text NOT NULL`

const statements = [
  `CREATE TABLE IF NOT EXISTS deployment_rollout (
    ${ownership},
    id text NOT NULL,
    seq integer NOT NULL,
    organization_id text NOT NULL,
    project_id text NOT NULL,
    environment text NOT NULL,
    commit_sha text NOT NULL,
    message text NOT NULL,
    author_name text NOT NULL,
    author_image text,
    regions jsonb NOT NULL,
    status text NOT NULL,
    phase text NOT NULL,
    rolled_back_from text,
    image_digest text,
    env_snapshot text NOT NULL,
    runner_count integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL,
    finished_at timestamptz,
    failure text,
    CONSTRAINT deployment_rollout_pkey PRIMARY KEY (routing_key, tenant_id, actor_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS deployment_rollout_seq
    ON deployment_rollout (routing_key, tenant_id, actor_id, seq)`,
  `CREATE TABLE IF NOT EXISTS deployment_rollout_step (
    ${ownership},
    deployment_id text NOT NULL,
    name text NOT NULL,
    status text NOT NULL,
    started_at timestamptz,
    duration_ms integer,
    detail text,
    CONSTRAINT deployment_rollout_step_pkey PRIMARY KEY (routing_key, tenant_id, actor_id, deployment_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS deployment_rollout_runner (
    ${ownership},
    deployment_id text NOT NULL,
    runner_id text NOT NULL,
    region text NOT NULL,
    actor_count integer,
    cpu_percent double precision,
    health text NOT NULL,
    CONSTRAINT deployment_rollout_runner_pkey PRIMARY KEY (routing_key, tenant_id, actor_id, deployment_id, runner_id)
  )`,
  `CREATE TABLE IF NOT EXISTS deployment_rollout_build_log (
    ${ownership},
    deployment_id text NOT NULL,
    line_index integer NOT NULL,
    at timestamptz NOT NULL,
    stream text NOT NULL,
    text text NOT NULL,
    CONSTRAINT deployment_rollout_build_log_pkey PRIMARY KEY (routing_key, tenant_id, actor_id, deployment_id, line_index)
  )`,
  `ALTER TABLE deployment_rollout_runner ALTER COLUMN actor_count DROP NOT NULL`,
  `ALTER TABLE deployment_rollout_runner ALTER COLUMN cpu_percent DROP NOT NULL`,
]

const tables = [
  "deployment_rollout",
  "deployment_rollout_step",
  "deployment_rollout_runner",
  "deployment_rollout_build_log",
]

/**
 * Creates the lifecycle's owned tables when they are missing, under one
 * transaction-scoped advisory lock so runners starting together cannot race
 * each other, and leaves existing tables and rows untouched. Row-level
 * security is enabled with the `durable_tenant` policy, which changes nothing
 * until the runtime opts in. It must run before the actor runtime starts,
 * which fails when an owned table is missing.
 */
export const ensureLifecycleTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`SELECT pg_advisory_xact_lock(hashtext('deployment_rollout_tables'))`

      for (const statement of statements) yield* sql.unsafe(statement)

      for (const table of tables) {
        yield* sql.unsafe(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)

        const [policy] = yield* sql<{ readonly found: number }>`
          SELECT 1 AS found FROM pg_policies
          WHERE schemaname = current_schema() AND tablename = ${table} AND policyname = 'durable_tenant'
        `

        if (policy === undefined)
          yield* sql.unsafe(
            `CREATE POLICY durable_tenant ON ${table} AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('durable.tenant', true)) WITH CHECK (tenant_id = current_setting('durable.tenant', true))`,
          )
      }
    }),
  )
}).pipe(Effect.orDie)

/** `ensureLifecycleTables` as a layer, for a `SqlClient` on the database the actor runtime uses. */
export const LifecycleTablesLive = Layer.effectDiscard(ensureLifecycleTables)
