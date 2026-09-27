import { Clock, Effect } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { type CaseResult, measure, type Scenario } from "../scenario.ts"

const TENANTS = 100

const DAY_MS = 86_400_000

/**
 * Seeds `actors` actors spread over `TENANTS` tenants straight into the
 * runtime tables: one receipt, one event, and one day-away timer each, and a
 * dead letter for every hundredth actor. The type is never registered, so no
 * runner touches the rows while they are read.
 */
const seed = Effect.fnUntraced(function* (actors: number) {
  const sql = yield* SqlClient.SqlClient
  const now = yield* Clock.currentTimeMillis

  yield* sql`INSERT INTO actor_placements (actor_type, placement, encoding)
    VALUES ('Inspected', 'actor', 1) ON CONFLICT DO NOTHING`
  yield* sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id,
      generation, created, event_sequence)
    SELECT (i::bigint * 2654435761) % 9223372036854775807, 't' || (i % ${TENANTS}),
      'Inspected', i::text, 1, true, 1
    FROM generate_series(1, ${actors}::int) AS i`
  yield* sql`INSERT INTO actor_receipts (routing_key, tenant_id, actor_type, actor_id, command_id,
      command, payload_hash, caller_key, outcome, expires_at_ms)
    SELECT routing_key, tenant_id, actor_type, actor_id, 'c-' || actor_id, 'Touch', 'h',
      '{"_tag":"User","subject":"alice"}', '{"_tag":"Success","value":"null"}',
      ${now + DAY_MS}::bigint
    FROM actor_generations WHERE actor_type = 'Inspected'`
  yield* sql`INSERT INTO actor_events (routing_key, tenant_id, actor_type, actor_id, sequence,
      event, command_id, value, emitted_at_ms)
    SELECT routing_key, tenant_id, actor_type, actor_id, 1, 'Touched', 'c-' || actor_id,
      '\\x00'::bytea, ${now}::bigint
    FROM actor_generations WHERE actor_type = 'Inspected'`
  yield* sql`INSERT INTO actor_outbox (routing_key, intent_id, bucket, due_at_ms, tenant_id,
      actor_type, actor_id, timer_key, target_type, target_id, command, payload, caller)
    SELECT routing_key, 'timer-' || actor_id, routing_key >> 56, ${now + DAY_MS}::bigint,
      tenant_id, actor_type, actor_id, 'idle', actor_type, actor_id, 'Idle', '{}', '{}'
    FROM actor_generations WHERE actor_type = 'Inspected'`
  yield* sql`INSERT INTO actor_dead_letters (routing_key, effect_id, tenant_id, actor_type,
      actor_id, effect, payload, attempts, cause, ambiguous, dead_at_ms)
    SELECT routing_key, 'dead-' || actor_id, tenant_id, actor_type, actor_id, 'Deliver', '{}', 3,
      'ProviderDown', false, ${now}::bigint + actor_id::bigint
    FROM actor_generations WHERE actor_type = 'Inspected' AND actor_id::int % 100 = 0`
  yield* sql`ANALYZE`
})

interface Query {
  readonly name: string
  readonly description: string
  readonly run: (
    sql: SqlClient.SqlClient,
    actor: number,
  ) => Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>
}

const tenantOf = (actor: number) => `t${actor % TENANTS}`

const QUERIES: ReadonlyArray<Query> = [
  {
    name: "actor-by-identity",
    description: "one actor by tenant, type, and id",
    run: (sql, actor) => sql`SELECT * FROM durable.actors
      WHERE tenant_id = ${tenantOf(actor)} AND actor_type = 'Inspected' AND actor_id = ${String(actor)}`,
  },
  {
    name: "receipts-by-routing-key",
    description: "one actor's receipts, keyed by the routing key the actors view reports",
    run: (sql, actor) => sql`SELECT * FROM durable.receipts
      WHERE routing_key = ${String((BigInt(actor) * 2654435761n) % 9223372036854775807n)}::bigint
        AND tenant_id = ${tenantOf(actor)} AND actor_type = 'Inspected' AND actor_id = ${String(actor)}`,
  },
  {
    name: "tenant-dead-letters",
    description: "a tenant's newest 20 dead letters",
    run: (sql, actor) => sql`SELECT * FROM durable.dead_letters
      WHERE tenant_id = ${tenantOf(actor)} ORDER BY dead_at_ms DESC LIMIT 20`,
  },
  {
    name: "tenant-receipt-count",
    description: "how many receipts a tenant holds",
    run: (sql, actor) => sql`SELECT count(*)::int AS receipts FROM durable.receipts
      WHERE tenant_id = ${tenantOf(actor)}`,
  },
  {
    name: "next-timers",
    description: "the 20 timers due soonest across every tenant",
    run: (sql) => sql`SELECT * FROM durable.timers ORDER BY due_at_ms LIMIT 20`,
  },
]

/** Operator queries through the `durable` inspection views over a seeded deployment. */
export const inspectionViews: Scenario = {
  name: "inspection-views",
  description:
    "Operator SQL through the durable inspection views at 100k actors (10k in quick): point lookups, tenant scans, and due timers.",
  run: (context) =>
    Effect.gen(function* () {
      const quick = context.profile === "quick"
      const actors = quick ? 10_000 : 100_000

      return yield* context.withRuntime({}, (instruments) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* seed(actors).pipe(Effect.orDie)
          const results: Array<CaseResult> = []

          for (const query of QUERIES) {
            const operation = (index: number) =>
              query.run(sql, 1 + ((index * 7919) % actors)).pipe(Effect.orDie)

            for (let index = 0; index < 20; index++) yield* operation(index)
            results.push(
              yield* measure({
                name: query.name,
                parameters: { actors, tenants: TENANTS, workers: 1 },
                instruments,
                workers: 1,
                operations: quick ? 100 : 500,
                operation,
                extra: { query: query.description },
              }),
            )
          }

          return results
        }),
      )
    }),
}
