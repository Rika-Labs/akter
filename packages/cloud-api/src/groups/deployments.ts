import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"

import {
  BuildLog,
  CreateDeployment,
  DeploymentDetail,
  DeploymentStatus,
  DeploymentSummary,
  RecordBuild,
  FailBuild,
  SourceArchive,
} from "../deployments.ts"
import { PayloadTooLarge, ReadErrors, WriteErrors } from "../errors.ts"
import { logQuery, RunnerLogPage } from "../logs.ts"
import {
  DeploymentId,
  EnvironmentName,
  NonNegativeInt,
  Page,
  pageQuery,
  ProjectId,
} from "../primitives.ts"

const projectParams = { projectId: ProjectId }
const deploymentParams = { ...projectParams, deploymentId: DeploymentId }

export class DeploymentsGroup extends HttpApiGroup.make("deployments").add(
  HttpApiEndpoint.get("getEnvironmentLogs", "/projects/:projectId/environments/:environment/logs", {
    params: { ...projectParams, environment: EnvironmentName },
    query: logQuery,
    success: RunnerLogPage,
    error: ReadErrors,
  }).annotate(
    OpenApi.Description,
    "Reads recent stdout/stderr from the environment's current deployment. Authorization is checked on every read, including resumed polls, and suspended organizations remain readable. Defaults: since five minutes ago, limit 100, wait 0. Since must be within the past hour; limit is 1–200 and wait is 0–20 seconds. A cursor resumes the same authorized resource and takes precedence over since. Follow by repeating bounded long polls with wait 20 and the returned cursor. Provider retention is recent and best-effort, not an archive; output lost beyond retention cannot be recovered. No current deployment returns an empty page. Text is clipped at 4096 UTF-8 bytes; truncated signals clipping or more available lines.",
  ),
  HttpApiEndpoint.get("getLogs", "/projects/:projectId/deployments/:deploymentId/logs", {
    params: deploymentParams,
    query: logQuery,
    success: RunnerLogPage,
    error: ReadErrors,
  }).annotate(
    OpenApi.Description,
    "Reads only the authorized deployment's customer runner stdout/stderr, with the same bounds and cursor protocol as environment logs. A deployment from another project or organization is not visible. Runner identifiers come only from the deployment's stored runner records, never from the cursor or caller input.",
  ),
  HttpApiEndpoint.get("list", "/projects/:projectId/deployments", {
    params: projectParams,
    query: {
      ...pageQuery,
      environment: Schema.optional(EnvironmentName),
      status: Schema.optional(DeploymentStatus),
    },
    success: Page(DeploymentSummary),
    error: ReadErrors,
  }),
  HttpApiEndpoint.post("create", "/projects/:projectId/deployments", {
    params: projectParams,
    payload: CreateDeployment,
    success: DeploymentDetail,
    error: WriteErrors,
  }),
  HttpApiEndpoint.post("uploadSource", "/projects/:projectId/sources", {
    params: projectParams,
    payload: Schema.Uint8Array.pipe(
      HttpApiSchema.asUint8Array({ contentType: "application/gzip" }),
    ),
    success: SourceArchive,
    error: [...WriteErrors, PayloadTooLarge],
  }).annotate(
    OpenApi.Description,
    "Stores a gzip-compressed tar of a build context for the project and answers its digest, the SHA-256 of the bytes sent. Sending the same bytes again answers the same digest. A deployment created with `source` naming that digest is built from it by the control plane's builder. Access and the builder are checked before the body is read: a caller without write access answers 403 and a control plane without a builder 501 `NotImplemented`. A body over 64 MiB answers 413 `PayloadTooLarge`, before any byte is read when its `content-length` says so, and as soon as it passes the limit otherwise.",
  ),
  HttpApiEndpoint.get("get", "/projects/:projectId/deployments/:deploymentId", {
    params: deploymentParams,
    success: DeploymentDetail,
    error: ReadErrors,
  }),
  HttpApiEndpoint.post("recordBuild", "/projects/:projectId/deployments/:deploymentId/build", {
    params: deploymentParams,
    payload: RecordBuild,
    success: DeploymentDetail,
    error: WriteErrors,
  }),
  HttpApiEndpoint.post(
    "failBuild",
    "/projects/:projectId/deployments/:deploymentId/build-failure",
    {
      params: deploymentParams,
      payload: FailBuild,
      success: DeploymentDetail,
      error: WriteErrors,
    },
  ),
  HttpApiEndpoint.get("getBuildLog", "/projects/:projectId/deployments/:deploymentId/build-log", {
    params: deploymentParams,
    query: { after: Schema.optional(NonNegativeInt) },
    success: BuildLog,
    error: ReadErrors,
  }),
  HttpApiEndpoint.post("rollback", "/projects/:projectId/deployments/:deploymentId/rollback", {
    params: deploymentParams,
    success: DeploymentDetail,
    error: WriteErrors,
  }).annotate(
    OpenApi.Description,
    "Rolls the environment back to the earlier deployment named by `deploymentId`. That deployment must have reached `live` before (status `live`, `drained` or `rolled-back`) and must not be the one live now; otherwise the answer is 409. The build is not repeated: a new deployment in the same environment redeploys that deployment's image and environment-variable snapshot, its `rolledBackFrom` is `deploymentId`, and its build and migrate steps are `skipped`. The new deployment starts `in-progress` and becomes `live` or `failed`. When it becomes `live`, the deployment that was live ends `rolled-back`; if it fails, that deployment stays `live`. The target keeps its own status. A second rollout in the environment while one is `in-progress` answers 409. The response is the new deployment.",
  ),
  HttpApiEndpoint.post("redeploy", "/projects/:projectId/deployments/:deploymentId/redeploy", {
    params: deploymentParams,
    success: DeploymentDetail,
    error: WriteErrors,
  }),
) {}
