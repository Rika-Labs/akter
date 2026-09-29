import { Duration, Effect, Exit, Layer, Option, Predicate, Scope, Schema } from "effect"
import {
  ClusterWorkflowEngine,
  MessageStorage,
  RunnerHealth,
  Runners,
  RunnerStorage,
  Sharding,
  ShardingConfig,
} from "effect/unstable/cluster"
import { Activity, DurableClock, DurableDeferred, Workflow } from "effect/unstable/workflow"
import { WorkflowEngine, WorkflowInstance } from "effect/unstable/workflow/WorkflowEngine"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  describeWorkflowEngine,
  type EngineFixture,
  type EnginePrimitives,
  type EngineRun,
  eventually,
  Flake,
  probeBody,
  ProbeInput,
  type Scenario,
  type WorkflowEngineDriver,
} from "./workflow-engine.ts"

const Probe = Workflow.make("Probe", {
  payload: ProbeInput,
  success: Schema.String,
  error: Flake,
  idempotencyKey: ({ scenario, key }) => `${scenario}/${key}`,
})

const primitives: EnginePrimitives<WorkflowEngine | WorkflowInstance> = {
  activity: (name, execute) =>
    Activity.make({ name, success: Schema.String, error: Flake, execute }),
  sleep: (name, duration) =>
    DurableClock.sleep({ name, duration, inMemoryThreshold: Duration.zero }),
  race: (name, effects) =>
    DurableDeferred.raceAll({ name, success: Schema.String, error: Schema.Never, effects }),
}

const config = ShardingConfig.layer({
  entityMailboxCapacity: 32,
  entityTerminationTimeout: 0,
  entityMessagePollInterval: 50,
  sendRetryInterval: 25,
  refreshAssignmentsInterval: 50,
})

const engineLayer = (fixture: EngineFixture) =>
  Probe.toLayer((input) => probeBody({ primitives, fixture, input })).pipe(
    Layer.provideMerge(ClusterWorkflowEngine.layer),
    Layer.provideMerge(Sharding.layer),
    Layer.provide(Runners.layerNoop),
    Layer.provide(RunnerStorage.layerMemory),
    Layer.provide(RunnerHealth.layerNoop),
    Layer.provide(config),
  )

/**
 * Effect's `ClusterWorkflowEngine` over Cluster's in-memory message storage.
 * The storage outlives the engine, so `restart` rebuilds sharding and the
 * engine over the same journal.
 */
const clusterDriver = (fixture: EngineFixture) =>
  Effect.gen(function* () {
    const outer = yield* Effect.scope
    const storage = yield* Layer.build(MessageStorage.layerMemory.pipe(Layer.provideMerge(config)))

    const open = Effect.gen(function* () {
      const scope = yield* Scope.fork(outer)

      const context = yield* Layer.buildWithScope(engineLayer(fixture), scope).pipe(
        Effect.provideContext(storage),
        Effect.orDie,
      )

      return { scope, context }
    })

    let current = yield* open

    const use = <A, E>(effect: Effect.Effect<A, E, WorkflowEngine>) =>
      Effect.suspend(() => effect.pipe(Effect.provideContext(current.context)))

    const executionId = (scenario: Scenario, key: string) => `${scenario}/${key}`

    const engine = use(Effect.service(WorkflowEngine))

    const runOf = (scenario: Scenario, key: string): EngineRun => {
      const id = executionId(scenario, key)

      return {
        executionId: id,
        poll: engine.pipe(Effect.flatMap((live) => live.poll(Probe, id))),
        interrupt: engine.pipe(Effect.flatMap((live) => live.interrupt(Probe, id))),
      }
    }

    const driver: WorkflowEngineDriver = {
      pollWhileRunning: "None",
      execute: (scenario, key) =>
        engine.pipe(
          Effect.flatMap((live) =>
            use(
              live.execute(Probe, {
                executionId: executionId(scenario, key),
                payload: { scenario, key },
              }),
            ),
          ),
          Effect.exit,
        ),
      start: (scenario, key) =>
        engine.pipe(
          Effect.flatMap((live) =>
            live.execute(Probe, {
              executionId: executionId(scenario, key),
              payload: { scenario, key },
              discard: true,
            }),
          ),
          Effect.orDie,
          Effect.as(runOf(scenario, key)),
        ),
      attach: (scenario, key) => Effect.succeed(runOf(scenario, key)),
      awaitSuspended: (run) =>
        eventually({
          check: run.poll.pipe(
            Effect.map(
              (polled) => Option.isSome(polled) && Predicate.isTagged(polled.value, "Suspended"),
            ),
          ),
          what: `${run.executionId} to suspend`,
        }),
      advance: (duration) =>
        Effect.sleep(
          Duration.sum(Duration.fromInputUnsafe(duration), Duration.fromInputUnsafe("100 millis")),
        ),
      restart: Effect.gen(function* () {
        yield* Scope.close(current.scope, Exit.void)
        current = yield* open
      }),
    }

    return driver
  })

describeWorkflowEngine({
  name: "ClusterWorkflowEngine",
  registrar: { describe, it, beforeAll, afterAll, expect, skip: (name) => it.skip(name) },
  open: clusterDriver,
})
