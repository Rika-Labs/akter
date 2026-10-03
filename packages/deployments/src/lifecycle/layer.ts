import type { Row, ScopedRead } from "@rikalabs/akter"
import { DateTime, Effect, Layer, Option, Predicate, Result } from "effect"
import {
  type DeploymentDetail,
  DeploymentExists,
  DeploymentLifecycle,
  DeploymentNotFound,
  type DeploymentStatus,
  deploymentRollout,
  type DeploymentSummary,
  type Environment,
  InvalidCursor,
  NotBuilding,
  type Phase,
  type Region,
  RollbackTargetInvalid,
  RolloutInProgress,
  rolloutBuildLog,
  rolloutRunner,
  rolloutStep,
  RolloutStepJob,
  type StepName,
  splitLifecycleKey,
} from "./contract.ts"
import { RolloutPlatform, RolloutRouting } from "./platform.ts"

const STEPS: ReadonlyArray<StepName> = ["build", "migrate", "start-runners", "drain-previous"]

type Deployment = Row<typeof deploymentRollout>

const summaryOf = (row: Deployment): DeploymentSummary => ({
  id: row.id,
  organizationId: row.organizationId,
  projectId: row.projectId,
  environment: row.environment as Environment,
  commitSha: row.commitSha,
  message: row.message,
  author: { name: row.authorName, image: row.authorImage },
  regions: row.regions as ReadonlyArray<Region>,
  runnerCount: row.runnerCount,
  durationMs: row.finishedAt === null ? null : row.finishedAt.getTime() - row.createdAt.getTime(),
  status: row.status as DeploymentStatus,
  phase: row.phase as Phase,
  rolledBackFrom: row.rolledBackFrom,
  imageDigest: row.imageDigest,
  failure: row.failure,
  createdAt: DateTime.fromDateUnsafe(row.createdAt),
})

/** A deployment with its steps and runners, read through either a turn's or a query's rows. */
const detailOf = Effect.fnUntraced(function* (
  rows: {
    readonly deployments: ScopedRead<typeof deploymentRollout>
    readonly steps: ScopedRead<typeof rolloutStep>
    readonly runners: ScopedRead<typeof rolloutRunner>
  },
  id: string,
) {
  const deployment = yield* rows.deployments.one({ where: { id } })

  if (Option.isNone(deployment)) return yield* DeploymentNotFound.make({ deploymentId: id })

  const steps = yield* rows.steps.all({ where: { deploymentId: id } })

  const runners = yield* rows.runners.all({
    where: { deploymentId: id },
    orderBy: { runnerId: "asc" },
  })

  return {
    ...summaryOf(deployment.value),
    steps: STEPS.flatMap((name) => {
      const step = steps.find((candidate) => candidate.name === name)

      return step === undefined
        ? []
        : [
            {
              name,
              status: step.status as DeploymentDetail["steps"][number]["status"],
              durationMs: step.durationMs,
              detail: step.detail,
            },
          ]
    }),
    runners: runners.map((runner) => ({
      id: runner.runnerId,
      region: runner.region as Region,
      actorCount: runner.actorCount,
      cpuPercent: runner.cpuPercent,
      health: runner.health as DeploymentDetail["runners"][number]["health"],
    })),
  } satisfies DeploymentDetail
})

type Routing = typeof RolloutRouting.Service

const releaseOf = (deployment: Deployment) => ({
  organizationId: deployment.organizationId,
  projectId: deployment.projectId,
  environment: deployment.environment as Environment,
  deploymentId: deployment.id,
  imageDigest: deployment.imageDigest ?? "",
  envSnapshot: deployment.envSnapshot,
  regions: deployment.regions as ReadonlyArray<Region>,
  rolledBackFrom: deployment.rolledBackFrom,
})

const turnRows = Effect.gen(function* () {
  const turn = yield* DeploymentLifecycle.Turn

  return {
    turn,
    deployments: turn.rows(deploymentRollout),
    steps: turn.rows(rolloutStep),
    runners: turn.rows(rolloutRunner),
    log: turn.rows(rolloutBuildLog),
  }
})

type Rows = Effect.Success<typeof turnRows>

const startStep = (rows: Rows, deploymentId: string, name: StepName, now: Date) =>
  rows.steps.update({ status: "running", startedAt: now }).where({ deploymentId, name })

const endStep = Effect.fnUntraced(function* (
  rows: Rows,
  deploymentId: string,
  name: StepName,
  status: "succeeded" | "failed" | "skipped",
  now: Date,
  detail: string | null = null,
) {
  const step = yield* rows.steps.one({ where: { deploymentId, name } })
  const startedAt = Option.isSome(step) ? step.value.startedAt : null

  yield* rows.steps
    .update({
      status,
      detail,
      durationMs: startedAt === null ? null : now.getTime() - startedAt.getTime(),
    })
    .where({ deploymentId, name })
})

/** Ends the rollout as `failed`; the live deployment is not touched. */
const fail = Effect.fnUntraced(function* (
  rows: Rows,
  deploymentId: string,
  name: StepName,
  reason: string,
  now: Date,
) {
  yield* rows.deployments
    .update({ status: "failed", phase: "failed", failure: reason, finishedAt: now })
    .where({ id: deploymentId })
  yield* endStep(rows, deploymentId, name, "failed", now, reason)

  for (const pending of yield* rows.steps.all({ where: { deploymentId, status: "pending" } }))
    yield* endStep(rows, deploymentId, pending.name as StepName, "skipped", now)
})

const enqueue = (
  rows: Rows,
  deployment: Deployment,
  step: "migrate" | "start-runners" | "drain-previous",
  replaces: string | null,
) =>
  rows.turn.enqueue(
    RolloutStepJob.make({
      step,
      deploymentId: deployment.id,
      imageDigest: deployment.imageDigest ?? "",
      envSnapshot: deployment.envSnapshot,
      regions: deployment.regions as ReadonlyArray<Region>,
      replaces,
    }),
  )

const appendLog = Effect.fnUntraced(function* (
  rows: Rows,
  deploymentId: string,
  lines: ReadonlyArray<{ readonly stream: "stdout" | "stderr"; readonly text: string }>,
  now: Date,
) {
  if (lines.length === 0) return

  yield* rows.log.insert(
    lines.map((line, lineIndex) => ({ deploymentId, lineIndex, at: now, ...line })),
  )
})

const awaitingBuild = Effect.fnUntraced(function* (deploymentId: string) {
  const rows = yield* turnRows
  const deployment = yield* rows.deployments.one({ where: { id: deploymentId } })

  if (Option.isNone(deployment)) return yield* DeploymentNotFound.make({ deploymentId })

  if (deployment.value.status !== "in-progress" || deployment.value.phase !== "building")
    return yield* NotBuilding.make({ deploymentId })

  return { rows, deployment: deployment.value, now: DateTime.toDateUtc(yield* DateTime.now) }
})

/**
 * Records a new in-progress deployment, refusing while another is. A rollback
 * (`rolledBackFrom` set) starts at `start-runners` with its build and migrate
 * steps skipped; any other deployment waits for its build result.
 */
const begin = Effect.fnUntraced(function* (
  routing: Routing,
  input: {
    readonly deploymentId: string
    readonly commitSha: string
    readonly message: string
    readonly author: { readonly name: string; readonly image: string | null }
    readonly regions: ReadonlyArray<Region>
    readonly envSnapshot: string
    readonly imageDigest: string | null
    readonly rolledBackFrom: string | null
  },
) {
  const rows = yield* turnRows
  const { projectId, environment } = splitLifecycleKey(rows.turn.id)

  if (Option.isSome(yield* rows.deployments.one({ where: { id: input.deploymentId } })))
    return yield* DeploymentExists.make({ deploymentId: input.deploymentId })

  const running = yield* rows.deployments.one({ where: { status: "in-progress" } })

  if (Option.isSome(running))
    return yield* RolloutInProgress.make({ deploymentId: running.value.id })

  const now = DateTime.toDateUtc(yield* DateTime.now)
  const rollback = input.rolledBackFrom !== null
  const first: StepName = rollback ? "start-runners" : "build"

  const deployment: Deployment = {
    id: input.deploymentId,
    seq: (yield* rows.deployments.count()) + 1,
    organizationId: rows.turn.ref.tenant,
    projectId,
    environment,
    commitSha: input.commitSha,
    message: input.message,
    authorName: input.author.name,
    authorImage: input.author.image,
    regions: input.regions,
    status: "in-progress",
    phase: rollback ? "rolling-out" : "building",
    rolledBackFrom: input.rolledBackFrom,
    imageDigest: input.imageDigest,
    envSnapshot: input.envSnapshot,
    runnerCount: 0,
    createdAt: now,
    finishedAt: null,
    failure: null,
  }

  yield* rows.deployments.insert(deployment)
  yield* rows.steps.insert(
    STEPS.map((name) => ({
      deploymentId: input.deploymentId,
      name,
      status:
        name === first
          ? "running"
          : rollback && (name === "build" || name === "migrate")
            ? "skipped"
            : "pending",
      startedAt: name === first ? now : null,
      durationMs: null,
      detail: null,
    })),
  )

  if (rollback) {
    yield* routing.register(releaseOf(deployment))
    yield* enqueue(rows, deployment, "start-runners", null)
  }

  return yield* detailOf(rows, input.deploymentId).pipe(Effect.orDie)
})

/**
 * Handlers of `DeploymentLifecycle`. Every handler is one short SQL
 * transaction; provider calls are `RolloutStepJob`s whose results come back
 * as `StepFinished` and `StepDeadLettered`. Turns of one actor run one at a
 * time, so at most one deployment is `in-progress`, and a replaced
 * deployment is retired in the same turn that makes its replacement `live`.
 */
export const DeploymentLifecycleCommands = DeploymentLifecycle.toLayer(
  Effect.gen(function* () {
    const routing = yield* RolloutRouting

    return {
      Create: Effect.fnUntraced(function* (input) {
        return yield* begin(routing, { ...input, imageDigest: null, rolledBackFrom: null })
      }),

      Redeploy: Effect.fnUntraced(function* ({ source, ...input }) {
        const rows = yield* turnRows
        const earlier = yield* rows.deployments.one({ where: { id: source } })

        if (Option.isNone(earlier)) return yield* DeploymentNotFound.make({ deploymentId: source })

        return yield* begin(routing, {
          ...input,
          commitSha: earlier.value.commitSha,
          imageDigest: null,
          rolledBackFrom: null,
        })
      }),

      Rollback: Effect.fnUntraced(function* ({ target, ...input }) {
        const rows = yield* turnRows
        const earlier = yield* rows.deployments.one({ where: { id: target } })

        if (Option.isNone(earlier)) return yield* DeploymentNotFound.make({ deploymentId: target })

        const status = earlier.value.status as DeploymentStatus

        if (status !== "drained" && status !== "rolled-back")
          return yield* RollbackTargetInvalid.make({ deploymentId: target, status })

        return yield* begin(routing, {
          ...input,
          commitSha: earlier.value.commitSha,
          regions: earlier.value.regions as ReadonlyArray<Region>,
          envSnapshot: earlier.value.envSnapshot,
          imageDigest: earlier.value.imageDigest,
          rolledBackFrom: target,
        })
      }),

      RecordBuild: Effect.fnUntraced(function* ({
        deploymentId,
        imageDigest,
        commitSha,
        envSnapshot,
        log,
      }) {
        const earlier = yield* (yield* turnRows).deployments.one({ where: { id: deploymentId } })

        if (
          Option.isSome(earlier) &&
          earlier.value.phase !== "building" &&
          earlier.value.rolledBackFrom === null &&
          earlier.value.imageDigest === imageDigest &&
          earlier.value.commitSha === commitSha &&
          (envSnapshot === undefined || envSnapshot === earlier.value.envSnapshot)
        )
          return yield* detailOf(yield* turnRows, deploymentId)

        const { rows, deployment, now } = yield* awaitingBuild(deploymentId)
        const recorded = {
          ...deployment,
          imageDigest,
          commitSha,
          envSnapshot: envSnapshot ?? deployment.envSnapshot,
        }

        yield* appendLog(rows, deploymentId, log ?? [], now)
        yield* rows.deployments
          .update({
            commitSha,
            imageDigest,
            envSnapshot: recorded.envSnapshot,
            phase: "build-recorded",
          })
          .where({ id: deploymentId })
        yield* endStep(rows, deploymentId, "build", "succeeded", now)
        yield* startStep(rows, deploymentId, "migrate", now)
        yield* routing.register(releaseOf(recorded))
        yield* enqueue(rows, recorded, "migrate", null)

        return yield* detailOf(rows, deploymentId)
      }),

      FailBuild: Effect.fnUntraced(function* ({ deploymentId, reason }) {
        const { rows, now } = yield* awaitingBuild(deploymentId)

        yield* appendLog(rows, deploymentId, [{ stream: "stderr", text: reason }], now)
        yield* fail(rows, deploymentId, "build", reason, now)

        return yield* detailOf(rows, deploymentId)
      }),

      StepFinished: Effect.fnUntraced(function* (result) {
        const rows = yield* turnRows
        const found = yield* rows.deployments.one({ where: { id: result.deploymentId } })

        if (Option.isNone(found)) return

        const deployment = found.value
        const now = DateTime.toDateUtc(yield* DateTime.now)
        const name: StepName = result.step

        if (result.step === "drain-previous") {
          if (deployment.status !== "live") return

          yield* endStep(
            rows,
            deployment.id,
            name,
            Predicate.isTagged(result, "StepFailed") ? "failed" : "succeeded",
            now,
            Predicate.isTagged(result, "StepFailed") ? result.reason : null,
          )

          return
        }

        const expected: Phase = result.step === "migrate" ? "build-recorded" : "rolling-out"

        if (deployment.status !== "in-progress" || deployment.phase !== expected) return

        if (Predicate.isTagged(result, "StepFailed")) {
          yield* fail(rows, deployment.id, name, result.reason, now)

          if (result.step === "start-runners")
            yield* enqueue(rows, deployment, "drain-previous", deployment.id)

          return
        }

        if (result.step === "migrate") {
          yield* endStep(rows, deployment.id, "migrate", "succeeded", now)
          yield* rows.deployments.update({ phase: "rolling-out" }).where({ id: deployment.id })
          yield* startStep(rows, deployment.id, "start-runners", now)
          yield* enqueue(rows, deployment, "start-runners", null)

          return
        }

        const previous = yield* rows.deployments.one({ where: { status: "live" } })

        const regions =
          deployment.regions.length === 0
            ? [...new Set(result.runners.map((runner) => runner.region))]
            : deployment.regions

        const activation = yield* routing
          .activate({
            ...releaseOf({ ...deployment, regions }),
            previousDeploymentId: Option.isSome(previous) ? previous.value.id : null,
            initiator:
              rows.turn.caller._tag === "System"
                ? rows.turn.caller.onBehalfOf?.subject
                : rows.turn.caller._tag === "User"
                  ? rows.turn.caller.subject
                  : undefined,
          })
          .pipe(Effect.result)

        if (Result.isFailure(activation)) {
          yield* fail(rows, deployment.id, "start-runners", activation.failure.reason, now)
          yield* enqueue(rows, deployment, "drain-previous", deployment.id)

          return
        }

        if (result.runners.length > 0)
          yield* rows.runners.insert(
            result.runners.map((runner) => ({
              deploymentId: deployment.id,
              runnerId: runner.id,
              region: runner.region,
              actorCount: runner.actorCount,
              cpuPercent: runner.cpuPercent,
              health: runner.health,
            })),
          )

        yield* endStep(rows, deployment.id, "start-runners", "succeeded", now)
        yield* rows.deployments
          .update({
            status: "live",
            phase: "live",
            finishedAt: now,
            runnerCount: result.runners.length,
            regions,
          })
          .where({ id: deployment.id })

        if (Option.isNone(previous)) {
          yield* endStep(rows, deployment.id, "drain-previous", "skipped", now)

          return
        }

        yield* rows.deployments
          .update({ status: deployment.rolledBackFrom === null ? "drained" : "rolled-back" })
          .where({ id: previous.value.id })
        yield* startStep(rows, deployment.id, "drain-previous", now)
        yield* enqueue(rows, deployment, "drain-previous", previous.value.id)
      }),

      StepDeadLettered: Effect.fnUntraced(function* ({ job, cause: trace }) {
        const cause = trace.split("\n")[0]!
        const rows = yield* turnRows
        const found = yield* rows.deployments.one({ where: { id: job.deploymentId } })

        if (Option.isNone(found)) return

        const now = DateTime.toDateUtc(yield* DateTime.now)
        const name: StepName = job.step

        if (job.step === "drain-previous") {
          if (found.value.status === "live")
            yield* endStep(rows, job.deploymentId, name, "failed", now, cause)

          return
        }

        if (found.value.status !== "in-progress") return

        yield* fail(rows, job.deploymentId, name, cause, now)

        if (job.step === "start-runners")
          yield* enqueue(rows, found.value, "drain-previous", job.deploymentId)
      }),
    }
  }),
)

/** Query handlers of `DeploymentLifecycle`. */
export const DeploymentLifecycleReads = DeploymentLifecycle.toQueryLayer({
  List: Effect.fnUntraced(function* ({ status, limit, cursor }) {
    const read = yield* DeploymentLifecycle.Read

    if (cursor !== undefined && !/^[0-9]{1,9}$/u.test(cursor)) return yield* InvalidCursor.make({})

    const size = Math.min(Math.max(limit ?? 50, 1), 100)

    const rows = yield* read.rows(deploymentRollout).all({
      where: {
        status: status ?? { isNotNull: true },
        seq: { lt: cursor === undefined ? 2_147_483_647 : Number(cursor) },
      },
      orderBy: { seq: "desc" },
      limit: size + 1,
    })

    const page = rows.slice(0, size)

    return {
      items: page.map(summaryOf),
      nextCursor: rows.length > size ? String(page[page.length - 1]!.seq) : null,
    }
  }),

  Get: Effect.fnUntraced(function* ({ deploymentId }) {
    const read = yield* DeploymentLifecycle.Read

    return yield* detailOf(
      {
        deployments: read.rows(deploymentRollout),
        steps: read.rows(rolloutStep),
        runners: read.rows(rolloutRunner),
      },
      deploymentId,
    )
  }),

  GetBuildLog: Effect.fnUntraced(function* ({ deploymentId, after }) {
    const read = yield* DeploymentLifecycle.Read

    if (Option.isNone(yield* read.rows(deploymentRollout).one({ where: { id: deploymentId } })))
      return yield* DeploymentNotFound.make({ deploymentId })

    const build = yield* read.rows(rolloutStep).one({ where: { deploymentId, name: "build" } })

    const lines = yield* read.rows(rolloutBuildLog).all({
      where: { deploymentId, lineIndex: { gte: after ?? 0 } },
      orderBy: { lineIndex: "asc" },
    })

    return {
      lines: lines.map((line) => ({
        index: line.lineIndex,
        at: DateTime.fromDateUnsafe(line.at),
        stream: line.stream as "stdout" | "stderr",
        text: line.text,
      })),
      complete:
        Option.isSome(build) &&
        build.value.status !== "running" &&
        build.value.status !== "pending",
    }
  }),
})

/**
 * Executors of the rollout's provider calls, through `RolloutPlatform`. A
 * `PlatformFailure` that is not retryable becomes a `StepFailed` result so the
 * job is not repeated; a retryable one fails the attempt.
 */
export const DeploymentLifecycleJobs = DeploymentLifecycle.toJobLayer(
  Effect.gen(function* () {
    const platform = yield* RolloutPlatform

    return {
      RolloutStepJob: Effect.fnUntraced(function* (job) {
        const { jobId, ref } = yield* DeploymentLifecycle.Executor
        const { projectId, environment } = splitLifecycleKey(ref.id)

        const release = {
          jobId,
          organizationId: ref.tenant,
          projectId,
          environment,
          deploymentId: job.deploymentId,
          imageDigest: job.imageDigest,
          envSnapshot: job.envSnapshot,
          regions: job.regions,
        }

        const call = Effect.gen(function* () {
          if (job.step === "start-runners") return yield* platform.start(release)

          if (job.step === "migrate") yield* platform.migrate(release)
          else
            yield* platform.drain({
              jobId,
              organizationId: ref.tenant,
              projectId,
              environment,
              deploymentId: job.replaces ?? "",
              replacedBy: job.deploymentId,
            })

          return []
        })

        return yield* call.pipe(
          Effect.map((runners) => ({
            _tag: "StepSucceeded" as const,
            step: job.step,
            deploymentId: job.deploymentId,
            runners,
          })),
          Effect.catchIf(
            (failure) => !failure.retryable,
            (failure) =>
              Effect.succeed({
                _tag: "StepFailed" as const,
                step: job.step,
                deploymentId: job.deploymentId,
                reason: failure.reason,
              }),
          ),
        )
      }),
    }
  }),
)

/** Commands, queries and executors of the lifecycle; needs a `RolloutPlatform`. */
export const DeploymentLifecycleLive = Layer.mergeAll(
  DeploymentLifecycleCommands,
  DeploymentLifecycleReads,
  DeploymentLifecycleJobs,
)
