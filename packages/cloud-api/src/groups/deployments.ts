import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"

import {
  BuildLog,
  CreateDeployment,
  DeploymentDetail,
  DeploymentStatus,
  DeploymentSummary,
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
  HttpApiEndpoint.get("get", "/projects/:projectId/deployments/:deploymentId", {
    params: deploymentParams,
    success: DeploymentDetail,
    error: ReadErrors,
  }),
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
  }),
  HttpApiEndpoint.post("redeploy", "/projects/:projectId/deployments/:deploymentId/redeploy", {
    params: deploymentParams,
    success: DeploymentDetail,
    error: WriteErrors,
  }),
) {}
