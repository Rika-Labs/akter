import {
  type DeploymentDetail,
  EnvironmentName,
  MAX_SOURCE_BYTES,
  ProjectId,
  SOURCE_ENTRY,
} from "@akter/cloud-api"
import { Clock, Config, Console, Duration, Effect, Option, Schema, Stream } from "effect"
import { Command, Flag } from "effect/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { fail } from "../../failure.ts"
import { ContextInvalid, packContext } from "./archive.ts"
import { reportFailures, retryTransient, signedIn } from "./client.ts"

/** The rollout ended `failed`; `step` is the step that failed and `detail` why. */
export class DeploymentFailed extends Schema.TaggedError<DeploymentFailed>()("DeploymentFailed", {
  deploymentId: Schema.String,
  step: Schema.String,
  detail: Schema.String,
}) {}

/** The rollout was still in progress when `--timeout` ran out; it goes on without the CLI. */
export class DeploymentTimedOut extends Schema.TaggedError<DeploymentTimedOut>()(
  "DeploymentTimedOut",
  { deploymentId: Schema.String, seconds: Schema.Int },
) {}

const flags = {
  project: Flag.String("project").pipe(
    Flag.withFallbackConfig(Config.String("AKTER_PROJECT")),
    Flag.withSchema(ProjectId),
    Flag.withDescription("The project to deploy to (default AKTER_PROJECT)"),
  ),
  environment: Flag.Literals("env", EnvironmentName.literals).pipe(
    Flag.withDefault("production"),
    Flag.withDescription("The environment to deploy to (default production)"),
  ),
  context: Flag.Directory("context", { mustExist: true }).pipe(
    Flag.withDefault("."),
    Flag.withDescription(
      `The app directory to upload, holding ${SOURCE_ENTRY} (default the current directory)`,
    ),
  ),
  commit: Flag.String("commit").pipe(
    Flag.optional,
    Flag.withDescription(
      "The commit SHA the deployment is labeled with (default the context's git HEAD)",
    ),
  ),
  message: Flag.String("message").pipe(
    Flag.optional,
    Flag.withDescription("The deployment's message (default the commit's subject)"),
  ),
  timeout: Flag.Int("timeout").pipe(
    Flag.withDefault(900),
    Flag.withDescription("Seconds to follow the rollout before giving up on it (default 900)"),
  ),
}

/** Runs `git` in `directory`, answering its trimmed output, or nothing when it fails or is missing. */
const git = (directory: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make("git", ["-C", directory, ...args]))
    const [out] = yield* Effect.all(
      [handle.stdout.pipe(Stream.decodeText, Stream.mkString), handle.stderr.pipe(Stream.runDrain)],
      { concurrency: 2 },
    )

    return Number(yield* handle.exitCode) === 0 ? out.trim() : undefined
  }).pipe(
    Effect.scoped,
    Effect.orElseSucceed(() => undefined),
  )

/**
 * The commit and message a deployment is labeled with: the flags when given,
 * otherwise the context's git `HEAD` and its subject, marked when the working
 * tree has uncommitted changes, since the upload holds them and the commit
 * does not. Outside a repository the commit is the archive digest's first 40
 * hex digits.
 */
const label = Effect.fnUntraced(function* (input: {
  readonly context: string
  readonly digest: string
  readonly commit: string | undefined
  readonly message: string | undefined
}) {
  const head = yield* git(input.context, ["rev-parse", "HEAD"])
  const commitSha = input.commit ?? head ?? input.digest.slice("sha256:".length, 47)

  if (input.message !== undefined) return { commitSha, message: input.message }
  if (input.commit !== undefined || head === undefined) return { commitSha, message: "" }

  const subject = (yield* git(input.context, ["log", "-1", "--format=%s"])) ?? ""
  const dirty = ((yield* git(input.context, ["status", "--porcelain"])) ?? "") !== ""

  return { commitSha, message: dirty ? `${subject} (with uncommitted changes)` : subject }
})

const seconds = (durationMs: number | null) =>
  durationMs === null ? "" : ` in ${(durationMs / 1000).toFixed(1)}s`

/**
 * Follows a deployment until it is `live` or `failed`, printing each rollout
 * step as it starts and ends. While the build runs it prints the build log's
 * new lines on every poll, asking from the index after the last line it
 * printed, and when the build succeeds it prints the rest before the step's
 * end, until the log says it is complete. A failed build prints the build's
 * last lines. Every read retries transient failures, so a brief control-plane
 * outage delays following instead of abandoning a rollout that goes on.
 */
const follow = Effect.fnUntraced(function* (input: {
  readonly client: Effect.Success<typeof signedIn>["client"]
  readonly projectId: ProjectId
  readonly deployment: DeploymentDetail
  readonly timeoutSeconds: number
}) {
  const params = { projectId: input.projectId, deploymentId: input.deployment.id }
  const deadline = (yield* Clock.currentTimeMillis) + input.timeoutSeconds * 1000
  const printed = new Map<string, string>()
  let detail = input.deployment
  let cursor = 0
  let following = false
  let logComplete = false
  const read = retryTransient("The control plane is unavailable; still following the deployment.")

  const printLog = Effect.gen(function* () {
    const log = yield* read(
      input.client.deployments.getBuildLog({ params, query: { after: cursor } }),
    )
    const last = log.lines.at(-1)

    for (const line of log.lines) yield* Console.log(`    ${line.text}`)

    if (last !== undefined) cursor = last.index + 1
    following = true
    logComplete = log.complete
  })

  while (true) {
    for (const step of detail.steps) {
      if (step.status === "pending" || printed.get(step.name) === step.status) continue

      if (step.name === "build" && step.status === "succeeded" && following && !logComplete)
        yield* printLog

      printed.set(step.name, step.status)
      yield* Console.log(
        `  ${step.name} ${step.status}${step.status === "running" ? "" : seconds(step.durationMs)}`,
      )
    }

    if (
      !logComplete &&
      detail.steps.some((step) => step.name === "build" && step.status === "running")
    )
      yield* printLog

    if (detail.status === "live") return detail

    if (detail.status === "failed") {
      const failed = detail.steps.find((step) => step.status === "failed")

      if (failed?.name === "build") {
        const log = yield* read(input.client.deployments.getBuildLog({ params, query: {} }))

        for (const line of log.lines.slice(-20)) yield* Console.error(`    ${line.text}`)
      }

      return yield* DeploymentFailed.make({
        deploymentId: detail.id,
        step: failed?.name ?? "rollout",
        detail: failed?.detail ?? "no reason was recorded",
      })
    }

    if ((yield* Clock.currentTimeMillis) >= deadline)
      return yield* DeploymentTimedOut.make({
        deploymentId: detail.id,
        seconds: input.timeoutSeconds,
      })

    yield* Effect.sleep(Duration.seconds(1))
    detail = yield* read(input.client.deployments.get({ params }))
  }
})

/**
 * `akter deploy`: uploads the app directory to the control plane's
 * builder, creates a deployment from it, and follows the rollout until it is
 * live or failed.
 */
export const deployCommand = Command.make("deploy", flags, (options) =>
  Effect.gen(function* () {
    const { client, credentials } = yield* signedIn
    const packed = yield* packContext({ context: options.context })

    if (!packed.files.includes(SOURCE_ENTRY))
      return yield* ContextInvalid.make({
        message: `No ${SOURCE_ENTRY} in ${options.context}, or its .akterignore or .gitignore leaves it out; the platform serves the App that file exports by default`,
      })

    if (packed.archive.byteLength > MAX_SOURCE_BYTES)
      return yield* fail({
        reason: "ContextTooLarge",
        message: `The app directory is ${packed.archive.byteLength} bytes compressed; the control plane accepts at most ${MAX_SOURCE_BYTES}. Exclude more files in .akterignore.`,
      })

    yield* Console.log(
      `Uploading ${packed.files.length} files (${packed.archive.byteLength} bytes) from ${options.context} to ${credentials.apiUrl}`,
    )

    const source = yield* client.deployments.uploadSource({
      params: { projectId: options.project },
      payload: packed.archive,
    })
    const { commitSha, message } = yield* label({
      context: options.context,
      digest: source.digest,
      commit: Option.getOrUndefined(options.commit),
      message: Option.getOrUndefined(options.message),
    })
    const deployment = yield* client.deployments.create({
      params: { projectId: options.project },
      payload: {
        environment: options.environment,
        commitSha,
        message,
        source: { digest: source.digest },
      },
    })

    yield* Console.log(
      `Deployment ${deployment.id} of ${commitSha.slice(0, 7)} to ${options.environment} started`,
    )

    const live = yield* follow({
      client,
      projectId: options.project,
      deployment,
      timeoutSeconds: options.timeout,
    })

    const { database } = yield* retryTransient(
      "The control plane is unavailable; retrying the database report.",
    )(
      client.projects.getEnvironment({
        params: { projectId: options.project, environment: options.environment },
      }),
    )
    if (database !== undefined) {
      if (database.latencyWarning)
        yield* Console.error(
          `Warning: database p50 latency${database.latency === null ? "" : ` (${database.latency} ms)`} exceeds 5 ms from the runner region; deployment is not refused.`,
        )
      if (database.runnerCap !== null)
        yield* Console.log(`Database runner cap: ${database.runnerCap}`)
    }

    yield* Console.log(`Deployment ${live.id} is live in ${options.environment}`)
  }).pipe(
    Effect.catchTags({
      ContextInvalid: (error) => fail({ reason: "ContextInvalid", message: error.message }),
      DeploymentFailed: (error) =>
        fail({
          reason: "DeploymentFailed",
          message: `Deployment ${error.deploymentId} failed at ${error.step}: ${error.detail}. The previous deployment, if any, is still serving.`,
          exitCode: 1,
        }),
      DeploymentTimedOut: (error) =>
        fail({
          reason: "DeploymentTimedOut",
          message: `Deployment ${error.deploymentId} was still rolling out after ${error.seconds}s; it continues on the control plane.`,
          exitCode: 1,
        }),
    }),
    reportFailures,
  ),
).pipe(
  Command.withDescription(
    "Upload the app directory, build and roll it out on Akter Cloud, and follow it until it is live",
  ),
)
