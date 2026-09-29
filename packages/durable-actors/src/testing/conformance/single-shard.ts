import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { ActorTest } from "../actor-test.ts"
import type {
  ConformanceCase,
  ConformanceEnvironment,
  ConformanceServices,
} from "../conformance.ts"
import { touchesOneShard } from "./neki/plan.ts"
import { mintWorkload } from "./mint.ts"
import { placementWorkload } from "./placement.ts"
import { type RecordedStatement, scopeOf, statementLog, type StatementScope } from "./statements.ts"

/**
 * The statements that touch a per-actor table without naming a routing key.
 * The check fails on any other, and on one that no longer appears, so the list
 * only shrinks.
 */
const UNKEYED_STATEMENTS = [
  // The creating-intent proof of a minted actor that is not parent-placed (#302).
  "SELECT caller FROM actor_outbox WHERE intent_id = $1 AND kind = 'intent' AND tenant_id = $2 AND actor_type = $3 AND actor_id = $4 AND target_type = $5 AND target_id = $6 AND command = $7 AND payload::jsonb = $8::jsonb",
]

/**
 * Drives a turn, a wake, a due-work scan, and the parent families of the
 * placement fixtures, and returns every statement the runtime compiled while it
 * did. The suite's runtime stops meanwhile: the first runtime creates the
 * actors, and a second one wakes them from storage, so the recorder sits on
 * runtimes of this case alone. The suite's runtime is running again on return.
 */
const frameworkStatements = (environment: ConformanceEnvironment) =>
  Effect.gen(function* () {
    const log = statementLog()

    // Start-up runs its own migrations and registry reads; recording starts once it is done.
    const on = (effect: Effect.Effect<void, never, ConformanceServices>, record: boolean) =>
      Effect.acquireUseRelease(
        Effect.sync(() => environment.build({ observe: log.observe })),
        (runtime) =>
          Effect.promise(() => runtime.runPromise(Effect.void)).pipe(
            Effect.andThen(
              Effect.sync(() => {
                log.recording = record
              }),
            ),
            Effect.andThen(Effect.promise(() => runtime.runPromise(Effect.scoped(effect)))),
            Effect.ensuring(
              Effect.sync(() => {
                log.recording = false
              }),
            ),
          ),
        (runtime) => Effect.promise(() => runtime.dispose()),
      )

    yield* environment.stop
    yield* on(placementWorkload.create, false)

    yield* on(
      Effect.gen(function* () {
        yield* placementWorkload.wake
        yield* mintWorkload
        yield* (yield* ActorTest).advance("2 hours")
      }),
      true,
    ).pipe(Effect.ensuring(environment.restart))

    return Array.from(log.seen.values())
  })

const byScope = (statements: ReadonlyArray<RecordedStatement>) => {
  const scopes: Record<StatementScope, Array<RecordedStatement>> = {
    "table-free": [],
    keyed: [],
    scan: [],
    registry: [],
    unkeyed: [],
  }

  for (const statement of statements) scopes[scopeOf(statement.sql)].push(statement)

  return scopes
}

/** The statements whose Neki plan reaches anything other than one shard, with the plan. */
const scatteredOf = (
  environment: ConformanceEnvironment,
  statements: ReadonlyArray<RecordedStatement>,
) =>
  Effect.promise(() =>
    environment.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const scattered: Array<{ statement: string; plan: string }> = []

        for (const { sql: statement, params } of statements) {
          const rows = yield* sql
            .unsafe(
              `EXPLAIN (NEKI_PLAN, COSTS OFF, FORMAT TEXT) ${statement}`,
              params as Array<never>,
            )
            .values.pipe(Effect.orDie)

          const plan = rows.map(([line]) => String(line)).join("\n")

          if (!touchesOneShard(plan)) scattered.push({ statement: statement.slice(0, 160), plan })
        }

        return scattered
      }),
    ),
  )

export const singleShardConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "single-shard: every framework statement of a turn, a wake, and a due-work scan names its routing key or its bucket range",
    run: ({ expect, environment }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const scopes = byScope(yield* frameworkStatements(environment))

          expect(scopes.keyed.length > 10).toBe(true)
          expect(scopes.scan.length).toBe(2)

          // A scan takes its bucket range as parameters, so a claim per shard range needs no new statement.
          expect(
            scopes.scan.every(({ sql }) => /generate_series\(\$\d+::int, \$\d+::int\)/.test(sql)),
          ).toBe(true)

          expect(scopes.unkeyed.map(({ sql }) => sql)).toEqual(UNKEYED_STATEMENTS)
        }),
      ),
  },
  {
    name: "single-shard: EXPLAIN (NEKI_PLAN) plans every keyed framework statement of a turn and a wake on one shard",
    requiresNeki: true,
    timeoutMs: 120_000,
    run: ({ expect, environment }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const scopes = byScope(yield* frameworkStatements(environment))

          expect(yield* scatteredOf(environment, scopes.keyed)).toEqual([])
        }),
      ),
  },
  {
    name: "single-shard: EXPLAIN (NEKI_PLAN) plans each due-work scan statement on one shard",
    requiresNeki: true,
    timeoutMs: 120_000,
    run: ({ expect, environment }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const scopes = byScope(yield* frameworkStatements(environment))

          expect(yield* scatteredOf(environment, scopes.scan)).toEqual([])
        }),
      ),
  },
]
