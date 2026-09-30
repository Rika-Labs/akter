import { Duration, Effect, Layer, Schedule } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { User } from "../../../index.ts"
import { ActorTest } from "../../actor-test.ts"
import { ActorCluster } from "../../cluster.ts"
import type { ConformanceEnvironment } from "../../conformance.ts"
import { Shipper, type WorkflowsFixture, workflowsLayer } from "./actors.ts"

export const reset = (fixture: WorkflowsFixture) =>
  Effect.sync(() => {
    fixture.runs.clear()
    fixture.blocked = undefined
  })

const EXPIRATION_SECONDS = 3

export const withCluster = <A, E>(
  environment: ConformanceEnvironment,
  fixture: WorkflowsFixture,
  body: Effect.Effect<A, E, ActorCluster>,
) =>
  environment.run(
    Effect.gen(function* () {
      yield* reset(fixture)
      const database = yield* environment.freshDatabase

      const context = yield* Layer.build(
        ActorTest.cluster({
          database,
          runners: 3,
          shardLockExpiration: `${EXPIRATION_SECONDS} seconds`,
          actors: workflowsLayer(fixture),
          as: User.make({ subject: "alice" }),
          authorize: () => Effect.succeed(true),
        }),
      )

      return yield* body.pipe(Effect.provideContext(context))
    }),
  )

export const on = <A, E, R>(runner: number, effect: Effect.Effect<A, E, R>) =>
  ActorCluster.use((cluster) => cluster.on(runner)(effect))

export const advance = (runner: number, duration: Duration.Input) =>
  on(
    runner,
    ActorTest.use((test) => test.advance(duration)),
  )

/** Kills the runner owning `id` and returns a survivor once it holds the shards. */
export const killOwner = (id: string) =>
  ActorCluster.use((cluster) =>
    Effect.gen(function* () {
      const ref = (yield* cluster.on(0)(Shipper.get(id))).ref
      const owner = (yield* cluster.owner(ref))!
      yield* cluster.kill(owner)
      yield* cluster.ready

      return (owner + 1) % cluster.runners
    }),
  )

export const eventually = <E, R>(check: Effect.Effect<boolean, E, R>, what: string) =>
  check.pipe(
    Effect.repeat({ schedule: Schedule.spaced("25 millis"), until: (held) => held }),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.die(new Error(`Timed out waiting for ${what}`)),
    }),
    Effect.asVoid,
  )

export const suspendedRow = (executionId: string) =>
  eventually(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const rows = yield* sql<{ status: string }>`SELECT status FROM actor_workflow_executions
        WHERE execution_id = ${executionId}`

      return rows[0]?.status === "suspended"
    }).pipe(Effect.orDie),
    "the execution to suspend",
  )
