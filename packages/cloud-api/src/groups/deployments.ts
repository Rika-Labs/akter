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
import { ReadErrors, WriteErrors } from "../errors.ts"
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
    error: WriteErrors,
  }).annotate(
    OpenApi.Description,
    "Stores a gzip-compressed tar of a build context for the project and answers its digest, the SHA-256 of the bytes sent. Sending the same bytes again answers the same digest. A deployment created with `source` naming that digest is built from it by the control plane's builder. A control plane without a builder answers 501 `NotImplemented`, and an archive over 64 MiB is a 409 `Conflict`.",
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
