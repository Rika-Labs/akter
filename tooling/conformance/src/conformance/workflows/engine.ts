import { DateTime, Duration, Effect, type Scope } from "effect"
import { SqlClient } from "effect/sql"
import { Actor } from "../../../../../packages/akter/src/index.ts"
import { ActorTest } from "../../../../../packages/akter/src/testing/actor-test.ts"
import { encodeExecutionId } from "../../../../../packages/akter/src/identity/execution.ts"
import type {
  ConformanceCase,
  ConformanceEnvironment,
  ConformanceServices,
} from "../../conformance.ts"
import {
  engineCases,
  type EngineRun,
  eventually as eventuallyEngine,
  type Scenario,
  type WorkflowEngineDriver,
} from "../workflow-engine.ts"
import { EngineProbe, Probe, type WorkflowsFixture } from "./actors.ts"

/**
 * The shared engine suite's driver for the framework engine, on the
 * conformance environment's database. Every call pins the first runtime's
 * tenant, so an execution stays reachable across `restart`.
 */
const frameworkDriver = (environment: ConformanceEnvironment) =>
  Effect.gen(function* () {
    const tenant = yield* Effect.promise(() =>
      environment.run(Effect.map(Effect.service(ActorTest), (test) => test.tenant)),
    )

    const inTenant = <A, E>(effect: Effect.Effect<A, E, ConformanceServices | Scope.Scope>) =>
      Effect.promise(() => environment.run(effect.pipe(Actor.tenant(tenant))))

    const runOf = (scenario: Scenario, key: string) =>
      Effect.gen(function* () {
        const executionId = yield* encodeExecutionId({
          tenant,
          actor: "EngineProbe",
          id: key,
          workflow: "Probe",
          key: `${scenario}/${key}`,
        }).pipe(Effect.orDie)

        const reattach = EngineProbe.run(Probe, executionId).pipe(Effect.orDie)

        return {
          executionId,
          poll: inTenant(Effect.flatMap(reattach, (run) => run.poll).pipe(Effect.orDie)),
          interrupt: inTenant(Effect.flatMap(reattach, (run) => run.interrupt).pipe(Effect.orDie)),
        } satisfies EngineRun
      })

    const start = (scenario: Scenario, key: string) =>
      inTenant(
        Effect.flatMap(EngineProbe.get(key), (probe) => probe.Probe({ scenario, key })).pipe(
          Effect.orDie,
        ),
      )

    const driver: WorkflowEngineDriver = {
      pollWhileRunning: "Suspended",
      execute: (scenario, key) =>
        start(scenario, key).pipe(Effect.flatMap((run) => inTenant(Effect.exit(run.result)))),
      start: (scenario, key) => Effect.andThen(start(scenario, key), runOf(scenario, key)),
      attach: runOf,
      awaitSuspended: (run) =>
        eventuallyEngine({
          check: inTenant(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient

              const rows = yield* sql<{
                status: string
              }>`SELECT status FROM actor_workflow_executions
                WHERE execution_id = ${run.executionId}`

              return rows[0]?.status === "suspended"
            }).pipe(Effect.orDie),
          ),
          what: `${run.executionId} to suspend`,
        }),
      advance: (duration) =>
        inTenant(
          ActorTest.use((test) =>
            test.advance(Duration.sum(Duration.fromInputUnsafe(duration), Duration.seconds(1))),
          ),
        ),
      restart: Effect.gen(function* () {
        const now = (test: ActorTest["Service"]) =>
          test.now.pipe(Effect.map(DateTime.toEpochMillis))

        const before = yield* inTenant(Effect.flatMap(Effect.service(ActorTest), now))
        yield* environment.restart
        const after = yield* inTenant(Effect.flatMap(Effect.service(ActorTest), now))

        if (before > after) yield* inTenant(ActorTest.use((test) => test.advance(before - after)))
      }),
    }

    return driver
  })

/** The shared engine suite on the framework engine, plus its ours-only divergences. */
export const engineConformance: ReadonlyArray<ConformanceCase<WorkflowsFixture>> = [
  ...engineCases.map((engineCase, index): ConformanceCase<WorkflowsFixture> => ({
    name: `workflow engine: ${engineCase.name}`,
    timeoutMs: 60_000,
    run: ({ expect, environment, fixture }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const driver = yield* frameworkDriver(environment)

          yield* engineCase.run({
            driver,
            fixture: fixture.engine,
            expect,
            key: `engine-${index}`,
          })
        }),
      ),
  })),
  {
    name: "workflow engine: a body reaches no Effect WorkflowEngine, so external DurableDeferred completion is unsupported",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const probe = yield* EngineProbe.get("inspect")
          expect(yield* (yield* probe.Inspect({})).result).toBe("absent")
        }),
      ),
  },
]
