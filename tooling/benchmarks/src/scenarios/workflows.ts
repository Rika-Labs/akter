import { Effect, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import { summarize } from "../measure.ts"
import { WorkflowProbe } from "../probe/workflows.ts"
import { type CaseResult, measure, type Scenario } from "../scenario.ts"

const SLEEP_MS = 50

/** Starts one execution and returns once its row is finished. */
const runToEnd = (key: string, steps: number, sleepMs: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const probe = yield* WorkflowProbe.get(key)
    const run = yield* probe.Flow({ key, steps, sleepMs })

    yield* sql<{ done: boolean }>`SELECT true AS done FROM actor_workflow_executions
      WHERE execution_id = ${run.executionId} AND status = 'finished'`.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 millis"),
        until: (rows) => rows.length > 0,
      }),
      Effect.orDie,
    )
  })

/** Database-clock start-to-finish times of finished executions whose key starts with `prefix`. */
const lifetimes = (prefix: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const rows = yield* sql<{ ms: number }>`
      SELECT (finished_at_ms - started_at_ms)::int AS ms FROM actor_workflow_executions
      WHERE status = 'finished' AND workflow_key LIKE ${`${prefix}%`}`.pipe(Effect.orDie)

    return summarize(rows.map((row) => row.ms))
  })

/**
 * Workflow engine cost on one runner: a start that finishes with no steps,
 * the same with four activity steps (each a persisted row before and after
 * its run), and a durable sleep resumed through the relay.
 */
export const workflows: Scenario = {
  name: "workflows",
  description:
    "Workflow executions to completion, sequentially: no steps, four activity steps, and a 50 ms durable sleep resumed by the relay; extra holds database-clock start-to-finish times.",
  run: (context) =>
    Effect.gen(function* () {
      const operations = context.quick ? 100 : 500
      const results: Array<CaseResult> = []

      for (const [name, steps, sleepMs] of [
        ["steps-0", 0, 0],
        ["steps-4", 4, 0],
        [`sleep-${SLEEP_MS}ms`, 0, SLEEP_MS],
      ] as const)
        results.push(
          yield* context.withRuntime({}, (instruments) =>
            Effect.gen(function* () {
              yield* Effect.forEach(
                Array.from({ length: 20 }, (_, index) => index),
                (index) => runToEnd(`warmup-${index}`, steps, sleepMs),
              ).pipe(Effect.orDie)

              const result = yield* measure({
                name,
                parameters: { workers: 1, steps, sleepMs },
                instruments,
                workers: 1,
                operations: sleepMs > 0 ? Math.min(operations, 200) : operations,
                operation: (index) => runToEnd(`${name}-${index}`, steps, sleepMs),
                listStatements: true,
              })

              const lifetime = yield* lifetimes(`${name}-`)

              const lifetimeExtra = {
                lifetimeP50Ms: lifetime.p50,
                lifetimeP95Ms: lifetime.p95,
                lifetimeP99Ms: lifetime.p99,
              }

              if (sleepMs === 0) return { ...result, extra: lifetimeExtra } satisfies CaseResult

              return {
                ...result,
                extra: {
                  ...lifetimeExtra,
                  resumeP50Ms: lifetime.p50 - sleepMs,
                  resumeP95Ms: lifetime.p95 - sleepMs,
                  resumeP99Ms: lifetime.p99 - sleepMs,
                },
              } satisfies CaseResult
            }),
          ),
        )

      return results
    }),
}
