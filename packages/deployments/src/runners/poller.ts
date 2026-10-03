import { Effect, Layer, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import { runnerActor } from "./actor.ts"

/** Polling delivers desired capacity to actors; concurrent pollers cannot launch independent jobs. */
export const RunnerPoller = (idleSeconds = 300) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const poll = Effect.gen(function* () {
        const regions = yield* sql<{ deploymentId: string; region: string; wake: boolean }>`
          SELECT d.id AS "deploymentId", d.primary_region AS region,
            (d.tier <> 'free' OR EXISTS (
              SELECT 1 FROM runner_wake w WHERE w.deployment_id = d.id AND w.region = d.primary_region
            )) AS wake
          FROM deployment d WHERE d.serving AND d.image IS NOT NULL
        `.pipe(Effect.orDie)
        yield* Effect.forEach(regions, ({ deploymentId, region, wake }) =>
          Effect.gen(function* () {
            const runner = yield* runnerActor(deploymentId, region)
            yield* runner.Reconcile()
            if (wake) yield* runner.Wake()
            else yield* runner.Idle({ idleSeconds })
          }),
        )
      })
      yield* poll.pipe(
        Effect.catch(() => Effect.logWarning("Runner reconciliation failed; retrying")),
        Effect.repeat(Schedule.spaced("1 second")),
        Effect.forkScoped,
      )
    }),
  )
