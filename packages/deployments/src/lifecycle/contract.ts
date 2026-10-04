import { Actor } from "@rikalabs/akter"
import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core"
import { Schema } from "effect"

/** The environments a project has; the same set as the control plane's `cloud_environment`. */
export const Environment = Schema.Literals(["production", "staging", "dev"])
export type Environment = typeof Environment.Type

/** The launch regions. */
export const Region = Schema.Literals(["us-east-1", "us-west-2"])
export type Region = typeof Region.Type

/** A deployment's life: `in-progress`, then `live` or `failed`; a replaced `live` ends `drained` or `rolled-back`. */
export const DeploymentStatus = Schema.Literals([
  "in-progress",
  "live",
  "drained",
  "rolled-back",
  "failed",
])
export type DeploymentStatus = typeof DeploymentStatus.Type

/** Where an `in-progress` (or finished) deployment stands inside its rollout. */
export const Phase = Schema.Literals([
  "building",
  "build-recorded",
  "rolling-out",
  "live",
  "failed",
])
export type Phase = typeof Phase.Type

export const StepName = Schema.Literals(["build", "migrate", "start-runners", "drain-previous"])
export type StepName = typeof StepName.Type

export const StepStatus = Schema.Literals(["pending", "running", "succeeded", "failed", "skipped"])

/**
 * `<projectId>/<environment>`: one actor per project environment, so a
 * rollout in an environment is serialized by the actor's turns and the key
 * names the environment, never a single release.
 */
export const LifecycleKey = Schema.String.check(
  Schema.isPattern(/^[^/\s]{1,128}\/(?:production|staging|dev)$/u),
)

/** The lifecycle actor's key for a project's environment. */
export const lifecycleKey = (project: {
  readonly projectId: string
  readonly environment: Environment
}) => `${project.projectId}/${project.environment}`

/** The project and environment a lifecycle key names. */
export const splitLifecycleKey = (key: string) => {
  const slash = key.lastIndexOf("/")

  return { projectId: key.slice(0, slash), environment: key.slice(slash + 1) as Environment }
}

const Author = Schema.Struct({ name: Schema.String, image: Schema.NullOr(Schema.String) })

export const RolloutStep = Schema.Struct({
  name: StepName,
  status: StepStatus,
  durationMs: Schema.NullOr(Schema.Int),
  detail: Schema.NullOr(Schema.String),
})

/** A runner; `actorCount` and `cpuPercent` are null until the platform measures them. */
export const RolloutRunner = Schema.Struct({
  id: Schema.String,
  region: Region,
  actorCount: Schema.NullOr(Schema.Int),
  cpuPercent: Schema.NullOr(Schema.Finite),
  health: Schema.Literals(["healthy", "unhealthy", "starting", "draining"]),
})
export type RolloutRunner = typeof RolloutRunner.Type

/** Matches the cloud API's `DeploymentSummary`, plus the organization, environment and phase. */
export const DeploymentSummary = Schema.Struct({
  id: Schema.String,
  organizationId: Schema.String,
  projectId: Schema.String,
  environment: Environment,
  commitSha: Schema.String,
  message: Schema.String,
  author: Author,
  regions: Schema.Array(Region),
  runnerCount: Schema.Int,
  durationMs: Schema.NullOr(Schema.Int),
  status: DeploymentStatus,
  phase: Phase,
  rolledBackFrom: Schema.NullOr(Schema.String),
  imageDigest: Schema.NullOr(Schema.String),
  failure: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtc,
})
export type DeploymentSummary = typeof DeploymentSummary.Type

export const DeploymentDetail = Schema.Struct({
  ...DeploymentSummary.fields,
  steps: Schema.Array(RolloutStep),
  runners: Schema.Array(RolloutRunner),
})
export type DeploymentDetail = typeof DeploymentDetail.Type

export const DeploymentPage = Schema.Struct({
  items: Schema.Array(DeploymentSummary),
  nextCursor: Schema.NullOr(Schema.String),
})

export const BuildLogLine = Schema.Struct({
  index: Schema.Int,
  at: Schema.DateTimeUtc,
  stream: Schema.Literals(["stdout", "stderr"]),
  text: Schema.String,
})

/** Build output from `after` onward; `complete` once the build has ended. */
export const BuildLog = Schema.Struct({
  lines: Schema.Array(BuildLogLine),
  complete: Schema.Boolean,
})

/** Another rollout in this environment is `in-progress`; only one runs at a time. */
export class RolloutInProgress extends Schema.TaggedError<RolloutInProgress>()(
  "RolloutInProgress",
  { deploymentId: Schema.String },
) {}

/** A deployment with this id already exists in the environment. */
export class DeploymentExists extends Schema.TaggedError<DeploymentExists>()("DeploymentExists", {
  deploymentId: Schema.String,
}) {}

/** The environment has no deployment with this id. */
export class DeploymentNotFound extends Schema.TaggedError<DeploymentNotFound>()(
  "DeploymentNotFound",
  { deploymentId: Schema.String },
) {}

/** A rollback target must have been live before and must not be the live deployment. */
export class RollbackTargetInvalid extends Schema.TaggedError<RollbackTargetInvalid>()(
  "RollbackTargetInvalid",
  { deploymentId: Schema.String, status: DeploymentStatus },
) {}

/** The deployment is not waiting for a build result. */
export class NotBuilding extends Schema.TaggedError<NotBuilding>()("NotBuilding", {
  deploymentId: Schema.String,
}) {}

/** A cursor the lifecycle did not issue. */
export class InvalidCursor extends Schema.TaggedError<InvalidCursor>()("InvalidCursor", {}) {}

/**
 * One row per deployment of the environment: the read model of the cloud
 * API's deployment list and detail, and the record rollbacks copy the image
 * and environment snapshot from. `seq` orders deployments within the
 * environment, newest highest.
 */
export const deploymentRollout = Actor.table(
  pgTable(
    "deployment_rollout",
    {
      id: text("id").primaryKey(),
      seq: integer("seq").notNull(),
      organizationId: text("organization_id").notNull(),
      projectId: text("project_id").notNull(),
      environment: text("environment").notNull(),
      commitSha: text("commit_sha").notNull(),
      message: text("message").notNull(),
      authorName: text("author_name").notNull(),
      authorImage: text("author_image"),
      regions: jsonb("regions").$type<ReadonlyArray<string>>().notNull(),
      status: text("status").notNull(),
      phase: text("phase").notNull(),
      rolledBackFrom: text("rolled_back_from"),
      imageDigest: text("image_digest"),
      envSnapshot: text("env_snapshot").notNull(),
      runnerCount: integer("runner_count").notNull().default(0),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
      finishedAt: timestamp("finished_at", { withTimezone: true }),
      failure: text("failure"),
    },
    (table) => [index("deployment_rollout_seq").on(table.seq)],
  ),
)

/** The four rollout steps of each deployment. */
export const rolloutStep = Actor.table(
  pgTable(
    "deployment_rollout_step",
    {
      deploymentId: text("deployment_id").notNull(),
      name: text("name").notNull(),
      status: text("status").notNull(),
      startedAt: timestamp("started_at", { withTimezone: true }),
      durationMs: integer("duration_ms"),
      detail: text("detail"),
    },
    (table) => [primaryKey({ columns: [table.deploymentId, table.name] })],
  ),
)

/** The runners a deployment started. */
export const rolloutRunner = Actor.table(
  pgTable(
    "deployment_rollout_runner",
    {
      deploymentId: text("deployment_id").notNull(),
      runnerId: text("runner_id").notNull(),
      region: text("region").notNull(),
      actorCount: integer("actor_count"),
      cpuPercent: doublePrecision("cpu_percent"),
      health: text("health").notNull(),
    },
    (table) => [primaryKey({ columns: [table.deploymentId, table.runnerId] })],
  ),
)

/** A deployment's build output, one row per line. */
export const rolloutBuildLog = Actor.table(
  pgTable(
    "deployment_rollout_build_log",
    {
      deploymentId: text("deployment_id").notNull(),
      lineIndex: integer("line_index").notNull(),
      at: timestamp("at", { withTimezone: true }).notNull(),
      stream: text("stream").notNull(),
      text: text("text").notNull(),
    },
    (table) => [primaryKey({ columns: [table.deploymentId, table.lineIndex] })],
  ),
)

/** One line of build output. */
const LogLine = Schema.Struct({
  stream: Schema.Literals(["stdout", "stderr"]),
  text: Schema.String,
})

/**
 * The commands below take caller-minted deployment ids, so a retry with the
 * same command id is also answered by the receipt.
 */
const create = {
  deploymentId: Schema.String,
  message: Schema.String,
  author: Author,
  regions: Schema.Array(Region),
  envSnapshot: Schema.String,
}

/**
 * Starts a rollout of `commitSha`. A control plane with a builder builds it in
 * a `build` job; otherwise the build is the caller's, reported with
 * `RecordBuild` or `FailBuild`.
 */
export const Create = Actor.command("Create", {
  payload: { ...create, commitSha: Schema.String },
  success: DeploymentDetail,
  error: Schema.Union([RolloutInProgress, DeploymentExists]),
})

/** Starts a rollout of an earlier deployment's commit, to be built again like `Create`. */
export const Redeploy = Actor.command("Redeploy", {
  payload: { ...create, source: Schema.String },
  success: DeploymentDetail,
  error: Schema.Union([RolloutInProgress, DeploymentExists, DeploymentNotFound]),
})

/** Registers the built image digest and the resolved commit, then rolls out; `envSnapshot` replaces the one given at creation. */
export const RecordBuild = Actor.command("RecordBuild", {
  payload: {
    deploymentId: Schema.String,
    imageDigest: Schema.String,
    commitSha: Schema.String,
    envSnapshot: Schema.optional(Schema.String),
    log: Schema.optional(Schema.Array(LogLine)),
  },
  success: DeploymentDetail,
  error: Schema.Union([DeploymentNotFound, NotBuilding]),
})

/** Records that the build failed; the deployment fails and the live one stays. */
export const FailBuild = Actor.command("FailBuild", {
  payload: { deploymentId: Schema.String, reason: Schema.String },
  success: DeploymentDetail,
  error: Schema.Union([DeploymentNotFound, NotBuilding]),
})

/**
 * Redeploys an earlier live deployment's image and environment snapshot as a
 * new deployment whose `rolledBackFrom` is `target`; build and migrate are skipped.
 */
export const Rollback = Actor.command("Rollback", {
  payload: {
    deploymentId: Schema.String,
    target: Schema.String,
    message: Schema.String,
    author: Author,
  },
  success: DeploymentDetail,
  error: Schema.Union([
    RolloutInProgress,
    DeploymentExists,
    DeploymentNotFound,
    RollbackTargetInvalid,
  ]),
})

export const List = Actor.query("List", {
  payload: {
    status: Schema.optional(DeploymentStatus),
    limit: Schema.optional(Schema.Int),
    cursor: Schema.optional(Schema.String),
  },
  success: DeploymentPage,
  error: InvalidCursor,
})

export const Get = Actor.query("Get", {
  payload: { deploymentId: Schema.String },
  success: DeploymentDetail,
  error: DeploymentNotFound,
})

export const GetBuildLog = Actor.query("GetBuildLog", {
  payload: { deploymentId: Schema.String, after: Schema.optional(Schema.Int) },
  success: BuildLog,
  error: DeploymentNotFound,
})

const JobStep = Schema.Literals(["build", "migrate", "start-runners", "drain-previous"])

/**
 * What a rollout step's job reports; a deterministic failure is a value, so
 * the job is not retried, while a retryable one fails the executor. A build
 * reports the image it built and its output.
 */
export const StepResult = Schema.Union([
  Schema.TaggedStruct("BuildSucceeded", {
    step: Schema.Literal("build"),
    deploymentId: Schema.String,
    imageDigest: Schema.String,
    log: Schema.Array(LogLine),
  }),
  Schema.TaggedStruct("StepSucceeded", {
    step: Schema.Literals(["migrate", "start-runners", "drain-previous"]),
    deploymentId: Schema.String,
    runners: Schema.Array(RolloutRunner),
  }),
  Schema.TaggedStruct("StepFailed", {
    step: JobStep,
    deploymentId: Schema.String,
    reason: Schema.String,
  }),
])

/**
 * One provider call of a rollout: `build`, `migrate`, `start-runners`,
 * `drain-previous`. `commitSha` is the commit a build builds; jobs enqueued
 * before builds existed carry none.
 */
export const RolloutStepJob = Actor.job("RolloutStepJob", {
  payload: {
    step: JobStep,
    deploymentId: Schema.String,
    commitSha: Schema.optional(Schema.String),
    imageDigest: Schema.String,
    envSnapshot: Schema.String,
    regions: Schema.Array(Region),
    replaces: Schema.NullOr(Schema.String),
  },
  success: StepResult,
})

export const StepFinished = Actor.command("StepFinished", { payload: StepResult })

export const StepDeadLettered = Actor.command("StepDeadLettered", {
  payload: Actor.DeadLetter(RolloutStepJob),
})

/** The environment's deployment lifecycle: one actor per `<projectId>/<environment>` in the organization's tenant. */
export const DeploymentLifecycle = Actor.make("DeploymentLifecycle", {
  key: LifecycleKey,
  tables: [deploymentRollout, rolloutStep, rolloutRunner, rolloutBuildLog],
  api: { Create, Redeploy, RecordBuild, FailBuild, Rollback, List, Get, GetBuildLog },
  internal: { StepFinished, StepDeadLettered },
  jobs: {
    RolloutStepJob: {
      job: RolloutStepJob,
      timeout: "20 minutes",
      retry: { times: 3 },
      concurrency: { perActor: 1 },
      onSuccess: StepFinished,
      onDeadLetter: StepDeadLettered,
    },
  },
})
