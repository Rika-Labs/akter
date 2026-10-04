import { Context, type Effect, Schema } from "effect"
import type { Environment, Region, RolloutRunner } from "./contract.ts"

/**
 * A provider step failed. `retryable` failures are tried again with backoff;
 * any other failure is final and fails the rollout, leaving the live
 * deployment as it was.
 */
export class PlatformFailure extends Schema.TaggedError<PlatformFailure>()("PlatformFailure", {
  reason: Schema.String,
  retryable: Schema.Boolean,
}) {
  override get message() {
    return this.reason
  }
}

/** The release a step acts on. `jobId` is stable across attempts: use it as the provider's idempotency key. */
export interface Release {
  readonly jobId: string
  readonly organizationId: string
  readonly projectId: string
  readonly environment: Environment
  readonly deploymentId: string
  readonly imageDigest: string
  readonly envSnapshot: string
  readonly regions: ReadonlyArray<string>
}

/** What a build is asked to build: a deployment's commit. `jobId` is stable across attempts. */
export interface BuildRequest {
  readonly jobId: string
  readonly organizationId: string
  readonly projectId: string
  readonly environment: Environment
  readonly deploymentId: string
  readonly commitSha: string
}

/** A built image: its content-addressed digest or local image id, and the build's output. */
export interface Build {
  readonly imageDigest: string
  readonly log: ReadonlyArray<{ readonly stream: "stdout" | "stderr"; readonly text: string }>
}

/**
 * Provider calls of a rollout. Each runs in a job, may be retried and so must
 * be idempotent under `jobId`, and has no database capability in the
 * actor's executor context. `build` is present only on a control plane that
 * builds images itself; without it the build is the caller's, recorded with
 * `RecordBuild`.
 */
export class RolloutPlatform extends Context.Service<
  RolloutPlatform,
  {
    /** Builds a deployment's commit into an image. Skipped by a rollback. */
    readonly build?: (request: BuildRequest) => Effect.Effect<Build, PlatformFailure>
    /** Applies the release's migrations. Skipped by a rollback. */
    readonly migrate: (release: Release) => Effect.Effect<void, PlatformFailure>
    /** Starts the release's runners and resolves once each answers ready; on failure nothing it started may serve. */
    readonly start: (
      release: Release,
    ) => Effect.Effect<ReadonlyArray<RolloutRunner>, PlatformFailure>
    /** Drains a replaced deployment's runners once its replacement is live; `replacedBy` is `deploymentId` when it cleans up a release that never went live. */
    readonly drain: (input: {
      readonly jobId: string
      readonly organizationId: string
      readonly projectId: string
      readonly environment: Environment
      readonly deploymentId: string
      readonly replacedBy: string
      readonly regions: ReadonlyArray<Region>
    }) => Effect.Effect<void, PlatformFailure>
  }
>()("@akter/deployments/lifecycle/platform/RolloutPlatform") {}

/** The routing flip could not be applied, for example because the environment's current deployment is not the one expected. */
export class ActivationRefused extends Schema.TaggedError<ActivationRefused>()(
  "ActivationRefused",
  { reason: Schema.String },
) {}

/** A release as the control plane's own tables record it. */
export type ReleaseRecord = Omit<Release, "jobId"> & { readonly rolledBackFrom?: string | null }

/**
 * Control-plane writes that must commit with the lifecycle's own rows. Both
 * run inside the actor's turn transaction, so they may use a `SqlClient`
 * captured when the layer is built and must not call a provider or wait. A
 * defect rolls the turn back and it is retried.
 */
export class RolloutRouting extends Context.Service<
  RolloutRouting,
  {
    /** Registers the immutable release, such as the edge's deployment row, in the turn that records its image (a build, or a rollback). */
    readonly register: (release: ReleaseRecord) => Effect.Effect<void>
    /**
     * Makes the release the environment's current deployment, compare-and-set
     * from `previousDeploymentId`, in the turn that marks it live and retires
     * the previous one. It must write nothing when it refuses.
     */
    readonly activate: (
      release: ReleaseRecord & {
        readonly previousDeploymentId: string | null
        readonly initiator?: string
      },
    ) => Effect.Effect<void, ActivationRefused>
  }
>()("@akter/deployments/lifecycle/platform/RolloutRouting") {}
