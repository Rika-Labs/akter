import { Actor } from "@rikalabs/akter"
import { Cause, Effect, Function, Layer, Option, Schedule, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { platformError, RunnerPlatform } from "./contract.ts"

const Spec = Schema.Struct({
  deploymentId: Schema.String,
  region: Schema.String,
  image: Schema.String,
  environment: Schema.Record(Schema.String, Schema.String),
  operationId: Schema.optional(Schema.String),
  cleanup: Schema.optional(Schema.Boolean),
})

const StartedResult = Schema.Struct({
  ...Spec.fields,
  id: Schema.String,
  url: Schema.NullOr(Schema.String),
  basePath: Schema.String,
  terminated: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
})

const Start = Actor.job("StartRunner", { payload: Spec.fields, success: StartedResult })
const Stop = Actor.job("StopRunner", { payload: { id: Schema.String } })
const Started = Actor.command("Started", { payload: StartedResult })
const Stopped = Actor.command("Stopped")
const StartFailed = Actor.command("StartFailed", { payload: Actor.DeadLetter(Start) })
const StopFailed = Actor.command("StopFailed", { payload: Actor.DeadLetter(Stop) })
const Wake = Actor.command("Wake")
const WakeIfServing = Actor.command("WakeIfServing")
const Idle = Actor.command("Idle", { payload: { idleSeconds: Schema.Int } })
const Drain = Actor.command("Drain")
const Capacity = Schema.Struct({
  status: Schema.String,
  taskId: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
})
const Lookup = Actor.query("Lookup", { success: Capacity })
const Check = Actor.job("CheckRunner", {
  payload: { id: Schema.String },
  success: Schema.Struct({ id: Schema.String, stopped: Schema.Boolean }),
})
const Checked = Actor.command("Checked", {
  payload: { id: Schema.String, stopped: Schema.Boolean },
})
const CheckFailed = Actor.command("CheckFailed", { payload: Actor.DeadLetter(Check) })
const Reconcile = Actor.command("Reconcile")

/** One region's runner capacity is serialized by durable actor turns, not by a polling process. */
export const Runners = Actor.make("CloudRunners", {
  key: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}\/[a-z0-9][a-z0-9-]{0,62}$/u)),
  state: Actor.state({
    status: Schema.Literals([
      "stopped",
      "starting",
      "running",
      "stopping",
      "failed",
      "stop-failed",
    ]).pipe(Schema.withDecodingDefault(Effect.succeed("stopped" as const))),
    taskId: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
    url: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
    checking: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
    wanted: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
    startKey: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  }),
  api: { Wake, WakeIfServing, Idle, Drain, Lookup, Reconcile },
  internal: { Started, Stopped, StartFailed, StopFailed, Checked, CheckFailed },
  jobs: {
    StartRunner: {
      job: Start,
      timeout: "8 minutes",
      retry: { times: 3 },
      onSuccess: Started,
      onDeadLetter: StartFailed,
    },
    StopRunner: {
      job: Stop,
      timeout: "3 minutes",
      retry: { times: 3 },
      onSuccess: Stopped,
      onDeadLetter: StopFailed,
    },
    CheckRunner: { job: Check, retry: { times: 1 }, onSuccess: Checked, onDeadLetter: CheckFailed },
  },
})

export const runnerKey: {
  (deploymentId: string, region: string): string
  (region: string): (deploymentId: string) => string
} = Function.dual(2, (deploymentId: string, region: string) => `${deploymentId}/${region}`)

const controlPlaneActor = (deploymentId: string, region: string) =>
  Runners.get(runnerKey(deploymentId, region)).pipe(Actor.tenant("control-plane"))

/** Capacity is global to a release-region; an organization's lifecycle job must not create a second tenant's capacity actor. */
export const runnerActor: {
  (deploymentId: string, region: string): ReturnType<typeof controlPlaneActor>
  (region: string): (deploymentId: string) => ReturnType<typeof controlPlaneActor>
} = Function.dual(2, controlPlaneActor)

/**
 * Registration is committed with the state transition; stopping first
 * withdraws the ingress row. The idle check reads `clock_timestamp()`: a Neki
 * turn session targeted at its data shard refuses `now()` beside a table.
 */
export const RunnerCommands = Runners.toLayer(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const beginStart = Effect.fnUntraced(function* () {
      const turn = yield* Runners.Turn
      const [deploymentId, region] = turn.id.split("/")
      if (deploymentId === undefined || region === undefined) return
      const [row] = yield* sql<{
        image: string | null
        environment: Readonly<Record<string, string>>
      }>`SELECT image, environment_snapshot AS environment FROM deployment WHERE id = ${deploymentId}`.pipe(
        Effect.orDie,
      )
      if (row === undefined || row.image === null) return
      const operationId = turn.state.startKey ?? turn.commandId
      const cleanup = !turn.state.wanted
      yield* turn.state.set({ status: "starting", taskId: null, url: null, startKey: operationId })
      yield* turn.enqueue(
        Start.make({
          deploymentId,
          region,
          image: row.image,
          environment: row.environment,
          operationId,
          cleanup,
        }),
      )
    })
    const stop = Effect.fnUntraced(function* () {
      const turn = yield* Runners.Turn
      yield* turn.state.set({ wanted: false })
      if (turn.state.status === "failed" && turn.state.startKey !== null) return yield* beginStart()
      if (!["running", "stop-failed"].includes(turn.state.status) || turn.state.taskId === null)
        return
      const [deploymentId, region] = turn.id.split("/")
      yield* sql`DELETE FROM deployment_runner WHERE deployment_id = ${deploymentId} AND region = ${region} AND url = ${turn.state.url}`.pipe(
        Effect.orDie,
      )
      yield* turn.state.set({ status: "stopping" })
      yield* turn.enqueue(Stop.make({ id: turn.state.taskId }))
    })
    const wake = Effect.fnUntraced(function* () {
      const turn = yield* Runners.Turn
      yield* turn.state.set({ wanted: true })
      if (turn.state.status === "stop-failed" && turn.state.taskId !== null) {
        yield* turn.state.set({ status: "stopping" })
        yield* turn.enqueue(Stop.make({ id: turn.state.taskId }))
        return
      }
      if (!["stopped", "failed"].includes(turn.state.status)) return
      yield* beginStart()
    })

    return {
      Wake: wake,
      WakeIfServing: Effect.fnUntraced(function* () {
        const turn = yield* Runners.Turn
        const [deploymentId] = turn.id.split("/")
        const [row] = yield* sql<{
          serving: boolean
        }>`SELECT serving FROM deployment WHERE id = ${deploymentId} FOR SHARE`.pipe(Effect.orDie)
        if (row?.serving !== true) return
        yield* wake()
      }),
      Started: Effect.fnUntraced(function* (result) {
        const turn = yield* Runners.Turn
        if (result.terminated) {
          yield* turn.state.set({
            status: turn.state.wanted ? "failed" : "stopped",
            taskId: null,
            url: null,
            startKey: null,
            checking: false,
          })
          return
        }
        if (!turn.state.wanted) {
          yield* turn.state.set({
            status: "stopping",
            taskId: result.id,
            url: null,
            checking: false,
          })
          yield* turn.enqueue(Stop.make({ id: result.id }))
          return
        }
        if (result.url === null)
          return yield* Effect.die(new Error("An active runner must have an address"))
        yield* sql`INSERT INTO deployment_runner (deployment_id, region, url, base_path, ready, provider_id) VALUES (${result.deploymentId}, ${result.region}, ${result.url}, ${result.basePath}, true, ${result.id}) ON CONFLICT (deployment_id, region, url) DO UPDATE SET base_path = EXCLUDED.base_path, ready = true, provider_id = EXCLUDED.provider_id`.pipe(
          Effect.orDie,
        )
        yield* sql`DELETE FROM runner_wake WHERE deployment_id = ${result.deploymentId} AND region = ${result.region}`.pipe(
          Effect.orDie,
        )
        yield* turn.state.set({
          status: "running",
          taskId: result.id,
          url: result.url,
          checking: false,
        })
      }),
      Idle: Effect.fnUntraced(function* ({ idleSeconds }) {
        if (idleSeconds < 1) return
        const turn = yield* Runners.Turn
        const [deploymentId] = turn.id.split("/")
        const [row] = yield* sql<{
          idle: boolean
        }>`SELECT tier = 'free' AND scale_to_zero AND last_activity_at <= clock_timestamp() - ${idleSeconds} * interval '1 second' AS idle FROM deployment WHERE id = ${deploymentId} FOR UPDATE`.pipe(
          Effect.orDie,
        )
        if (row?.idle === true) yield* stop()
      }),
      Drain: stop,
      Reconcile: Effect.fnUntraced(function* () {
        const turn = yield* Runners.Turn
        if (turn.state.status !== "running" || turn.state.taskId === null || turn.state.checking)
          return
        yield* turn.state.set({ checking: true })
        yield* turn.enqueue(Check.make({ id: turn.state.taskId }))
      }),
      Checked: Effect.fnUntraced(function* ({ id, stopped }) {
        const turn = yield* Runners.Turn
        if (turn.state.status !== "running" || turn.state.taskId !== id) return
        yield* turn.state.set({ checking: false })
        if (!stopped) return
        const [deploymentId, region] = turn.id.split("/")
        yield* sql`DELETE FROM deployment_runner WHERE deployment_id = ${deploymentId} AND region = ${region} AND url = ${turn.state.url}`.pipe(
          Effect.orDie,
        )
        yield* turn.state.set({ status: "stopped", taskId: null, url: null, startKey: null })
      }),
      CheckFailed: Effect.fnUntraced(function* () {
        yield* (yield* Runners.Turn).state.set({ checking: false })
      }),
      Stopped: Effect.fnUntraced(function* () {
        const turn = yield* Runners.Turn
        yield* turn.state.set({
          status: "stopped",
          taskId: null,
          url: null,
          checking: false,
          startKey: null,
        })
        if (turn.state.wanted) yield* (yield* Runners.intents(turn.id)).Wake()
      }),
      StartFailed: Effect.fnUntraced(function* () {
        yield* (yield* Runners.Turn).state.set({ status: "failed" })
      }),
      StopFailed: Effect.fnUntraced(function* () {
        yield* (yield* Runners.Turn).state.set({ status: "stop-failed" })
      }),
    }
  }),
)

/**
 * Provider attempts use the durable job id as their idempotency key across
 * process restarts. A typed failure stops the task it started; an interrupted
 * attempt leaves it for the retry, which finds the same task by that key.
 */
export const RunnerJobs = Runners.toJobLayer(
  Effect.gen(function* () {
    const platform = yield* RunnerPlatform
    return {
      StartRunner: Effect.fnUntraced(function* (spec) {
        const executor = yield* Runners.Executor
        const started = yield* platform.start({
          deploymentId: spec.deploymentId,
          region: spec.region,
          image: spec.image,
          environment: spec.environment,
          idempotencyKey: spec.operationId ?? executor.jobId,
        })
        if (spec.cleanup === true) {
          yield* platform
            .stop(started.id)
            .pipe(Effect.catchTag("RunnerNotFound", () => Effect.void))
          return {
            ...spec,
            id: started.id,
            url: null,
            basePath: started.basePath,
            terminated: true,
          }
        }
        const result =
          started.url === null
            ? yield* platform.describe(started.id).pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("100 millis"),
                  until: (runner) => runner.url !== null || runner.state === "stopped",
                }),
                Effect.timeoutOption("5 minutes"),
                Effect.flatMap((value) =>
                  Option.isSome(value)
                    ? Effect.succeed(value.value)
                    : platformError({ operation: "start", code: "unavailable" }),
                ),
                Effect.onError((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.void
                    : platform.stop(started.id).pipe(Effect.orDie),
                ),
              )
            : started
        if (result.state === "stopped") {
          if (result.terminated !== true) yield* platform.stop(result.id)
          return { ...spec, id: result.id, url: null, basePath: result.basePath, terminated: true }
        }
        if (result.url === null)
          return yield* platformError({ operation: "start", code: "no-task" })
        return {
          ...spec,
          id: result.id,
          url: result.url,
          basePath: result.basePath,
          terminated: false,
        }
      }),
      StopRunner: Effect.fnUntraced(function* ({ id }) {
        yield* platform.stop(id).pipe(Effect.catchTag("RunnerNotFound", () => Effect.void))
      }),
      CheckRunner: Effect.fnUntraced(function* ({ id }) {
        return yield* platform.describe(id).pipe(
          Effect.map((runner) => ({ id, stopped: runner.state === "stopped" })),
          Effect.catchTag("RunnerNotFound", () => Effect.succeed({ id, stopped: true })),
        )
      }),
    }
  }),
)

export const RunnerReads = Runners.toQueryLayer({
  Lookup: () => Effect.map(Runners.Read, (read) => ({ ...read.state })),
})

export const RunnerLayers = Layer.mergeAll(RunnerCommands, RunnerJobs, RunnerReads)
