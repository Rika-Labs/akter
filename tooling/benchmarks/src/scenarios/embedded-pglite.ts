import { Clock, Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { load } from "../measure.ts"
import { Probe, SleepyProbe } from "../probe/contract.ts"
import { type CaseResult, measure, type Scenario } from "../scenario.ts"
import { HIBERNATION_WAIT, reactivated } from "./cold-activation.ts"

/**
 * Stored actors seeded straight into the runtime tables, so a case measures
 * turns against a database of that size without spending minutes creating it.
 * Each has a generation, a 256-byte state value, and one receipt.
 */
const seed = (actors: number) =>
  Effect.gen(function* () {
    if (actors === 0) return
    const sql = yield* SqlClient.SqlClient
    const now = yield* Clock.currentTimeMillis

    yield* sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id,
        generation, created, event_sequence)
      SELECT hashtextextended('seeded/' || i, 0), 'seeded', 'Seeded', i::text, 1, true, 0
      FROM generate_series(1, ${actors}::int) AS i`
    yield* sql`INSERT INTO actor_state (routing_key, tenant_id, actor_type, actor_id, key, value)
      SELECT routing_key, tenant_id, actor_type, actor_id, 'value',
        decode(repeat(md5(actor_id), 8), 'hex')
      FROM actor_generations WHERE actor_type = 'Seeded'`
    yield* sql`INSERT INTO actor_receipts (routing_key, tenant_id, actor_type, actor_id, command_id,
        command, payload_hash, caller_key, outcome, expires_at_ms)
      SELECT routing_key, tenant_id, actor_type, actor_id, 'c-' || actor_id, 'Touch', 'h',
        '{"_tag":"User","subject":"alice"}', '{"_tag":"Success","value":"null"}',
        ${now + 86_400_000}::bigint
      FROM actor_generations WHERE actor_type = 'Seeded'`
    yield* sql`CHECKPOINT`
  }).pipe(Effect.orDie)

const databaseBytes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const [row] = yield* sql<{ bytes: string }>`
    SELECT pg_database_size(current_database())::text AS bytes`.pipe(Effect.orDie)

  return Number(row!.bytes)
})

/**
 * Turn latency, wake latency, and throughput at several stored sizes. Run it
 * with `--backend pglite-file` for the embedded production shape, one process
 * on a file-backed `dataDir`; on other backends it measures the same cases there.
 */
export const embeddedPglite: Scenario = {
  name: "embedded-pglite",
  description:
    "Warm turns, wakes after hibernation, and 16-caller throughput with 0 to 100,000 stored actors seeded into the database; run with --backend pglite-file for file-backed PGlite.",
  run: (context) =>
    Effect.gen(function* () {
      const sizes = context.quick ? [0, 1_000, 10_000] : [0, 10_000, 100_000]
      const results: Array<CaseResult> = []

      for (const stored of sizes) {
        results.push(
          yield* context.withRuntime({}, (instruments) =>
            Effect.gen(function* () {
              yield* seed(stored)
              const probe = yield* Probe.get("embedded-turn")
              yield* load({ workers: 1, operations: 20, operation: () => probe.Add(1) })

              const result = yield* measure({
                name: `turn-${stored}`,
                parameters: { workers: 1, stored },
                instruments,
                workers: 1,
                operations: context.quick ? 200 : 2_000,
                operation: () => probe.Add(1),
              })

              return {
                ...result,
                extra: { databaseBytes: yield* databaseBytes },
              } satisfies CaseResult
            }),
          ),
        )

        results.push(
          yield* context.withRuntime({}, (instruments) =>
            Effect.gen(function* () {
              yield* seed(stored)
              const actors = context.quick ? 50 : 300

              const wake = (index: number) =>
                SleepyProbe.get(`embedded-wake-${index}`).pipe(
                  Effect.flatMap((sleepy) => sleepy.Add(1)),
                )

              yield* load({ workers: 16, operations: actors, operation: wake })
              yield* Effect.sleep(HIBERNATION_WAIT)

              const result = yield* measure({
                name: `wake-${stored}`,
                parameters: { workers: 1, stored, actors, hibernateAfterMs: 250 },
                instruments,
                workers: 1,
                operations: actors,
                operation: wake,
              })

              return {
                ...result,
                extra: {
                  databaseBytes: yield* databaseBytes,
                  reactivatedFraction: yield* reactivated,
                },
              } satisfies CaseResult
            }),
          ),
        )

        results.push(
          yield* context.withRuntime({}, (instruments) =>
            Effect.gen(function* () {
              yield* seed(stored)
              const actors = 256

              const add = (index: number) =>
                Probe.get(`embedded-many-${index % actors}`).pipe(
                  Effect.flatMap((many) => many.Add(1)),
                )

              yield* load({ workers: 16, operations: actors, operation: add })

              const result = yield* measure({
                name: `throughput-${stored}`,
                parameters: { workers: 16, stored, actors },
                instruments,
                workers: 16,
                operations: context.quick ? 1_000 : 10_000,
                operation: add,
              })

              return {
                ...result,
                extra: { databaseBytes: yield* databaseBytes },
              } satisfies CaseResult
            }),
          ),
        )
      }

      return results
    }),
}
