import { checkWorkflows } from "@durable-actors/core/runtime"
import { BunCrypto } from "@effect/platform-bun"
import { Context, Crypto, Effect, Layer, Schedule } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { WorkflowProbe } from "../probe/workflows.ts"
import { type CaseResult, measure, type Scenario } from "../scenario.ts"

const SLEEP_MS = 3_600_000

/** Starts `open` executions that record two steps and then sleep for an hour. */
const openExecutions = (open: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    yield* Effect.forEach(
      Array.from({ length: open }, (_, index) => `open-${index}`),
      (key) =>
        WorkflowProbe.get(key).pipe(
          Effect.flatMap((probe) => probe.Flow({ key, steps: 2, sleepMs: SLEEP_MS })),
        ),
      { concurrency: 8, discard: true },
    ).pipe(Effect.orDie)

    yield* sql<{ open: number }>`SELECT count(*)::integer AS open FROM actor_workflow_executions
      WHERE status = 'suspended'`.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("50 millis"),
        until: (rows) => (rows[0]?.open ?? 0) >= open,
      }),
      Effect.orDie,
    )
  })

/**
 * The deploy check `durable workflows check` and a changed deployment's
 * startup run: every open execution grouped by start manifest, their
 * recorded steps and markers, against the declared workflows.
 */
export const workflowCheck: Scenario = {
  name: "workflow-check",
  description:
    "The workflow deploy check (checkWorkflows, read-only) over open WorkflowProbe executions that each recorded two steps and sleep; one check per operation, sequentially.",
  run: (context) =>
    Effect.gen(function* () {
      const results: Array<CaseResult> = []
      const crypto = Context.get(yield* Layer.build(BunCrypto.layer), Crypto.Crypto)

      for (const open of context.quick ? [100] : [100, 1_000])
        results.push(
          yield* context.withRuntime({}, (instruments) =>
            Effect.gen(function* () {
              yield* openExecutions(open)

              return yield* measure({
                name: `open-${open}`,
                parameters: { workers: 1, open, recordedSteps: 2 },
                instruments,
                workers: 1,
                operations: context.quick ? 20 : 100,
                operation: () =>
                  checkWorkflows([WorkflowProbe]).pipe(
                    Effect.flatMap((found) =>
                      found.length === 0
                        ? Effect.void
                        : Effect.die(new Error("the probe deployment must be compatible")),
                    ),
                    Effect.orDie,
                    Effect.provideService(Crypto.Crypto, crypto),
                  ),
                listStatements: true,
              })
            }),
          ),
        )

      return results
    }).pipe(Effect.scoped),
}
