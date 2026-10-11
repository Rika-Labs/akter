import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"

import { ReadErrors, WriteErrors } from "../errors.ts"
import { DomainId, EnvironmentName, OrganizationId, ProjectId, RegionId } from "../primitives.ts"
import {
  AddDomain,
  AddRegion,
  ConnectIntegration,
  CreateEnvironment,
  CreateEnvironmentApiKey,
  CreatedEnvironmentApiKey,
  CreateProject,
  Domain,
  Environment,
  EnvironmentApiKey,
  EnvVariable,
  EnvVariableName,
  ImportEnvVariables,
  ImportEnvVariablesResult,
  Integration,
  IntegrationConnection,
  IntegrationKind,
  Project,
  ProjectEndpoints,
  ProjectRegion,
  Region,
  SetEnvVariable,
  SetHomeRegion,
  UpdateProject,
} from "../projects.ts"

const projectParams = { projectId: ProjectId }
const environmentParams = { ...projectParams, environment: EnvironmentName }

export class ProjectsGroup extends HttpApiGroup.make("projects").add(
  HttpApiEndpoint.get("list", "/organizations/:organizationId/projects", {
    params: { organizationId: OrganizationId },
    success: Schema.Array(Project),
    error: ReadErrors,
  }),
  HttpApiEndpoint.post("create", "/organizations/:organizationId/projects", {
    params: { organizationId: OrganizationId },
    payload: CreateProject,
    success: Project,
    error: WriteErrors,
  }),
  HttpApiEndpoint.get("get", "/projects/:projectId", {
    params: projectParams,
    success: Project,
    error: ReadErrors,
  }),
  HttpApiEndpoint.patch("update", "/projects/:projectId", {
    params: projectParams,
    payload: UpdateProject,
    success: Project,
    error: WriteErrors,
  }),
  HttpApiEndpoint.delete("delete", "/projects/:projectId", {
    params: projectParams,
    error: WriteErrors,
  }),
  HttpApiEndpoint.get("listEnvironments", "/projects/:projectId/environments", {
    params: projectParams,
    success: Schema.Array(Environment),
    error: ReadErrors,
  }),
  HttpApiEndpoint.post("createEnvironment", "/projects/:projectId/environments", {
    params: projectParams,
    payload: CreateEnvironment,
    success: Environment,
    error: WriteErrors,
  }),
  HttpApiEndpoint.get("getEnvironment", "/projects/:projectId/environments/:environment", {
    params: environmentParams,
    success: Environment,
    error: ReadErrors,
  }),
  HttpApiEndpoint.delete("deleteEnvironment", "/projects/:projectId/environments/:environment", {
    params: environmentParams,
    error: WriteErrors,
  }),
  HttpApiEndpoint.get("getEndpoints", "/projects/:projectId/environments/:environment/endpoints", {
    params: environmentParams,
    success: ProjectEndpoints,
    error: ReadErrors,
  }),
) {}

export class EnvironmentApiKeysGroup extends HttpApiGroup.make("environmentApiKeys").add(
  HttpApiEndpoint.get("list", "/projects/:projectId/environments/:environment/api-keys", {
    params: environmentParams,
    success: Schema.Array(EnvironmentApiKey),
    error: ReadErrors,
  }),
  HttpApiEndpoint.post("create", "/projects/:projectId/environments/:environment/api-keys", {
    params: environmentParams,
    payload: CreateEnvironmentApiKey,
    success: CreatedEnvironmentApiKey,
    error: WriteErrors,
  }),
  HttpApiEndpoint.delete(
    "revoke",
    "/projects/:projectId/environments/:environment/api-keys/:keyId",
    {
      params: { ...environmentParams, keyId: Schema.String },
      error: WriteErrors,
    },
  ),
) {}

export class EnvironmentVariablesGroup extends HttpApiGroup.make("environmentVariables").add(
  HttpApiEndpoint.get("list", "/projects/:projectId/environments/:environment/variables", {
    params: environmentParams,
    success: Schema.Array(EnvVariable),
    error: ReadErrors,
  }),
  HttpApiEndpoint.put("set", "/projects/:projectId/environments/:environment/variables/:name", {
    params: { ...environmentParams, name: EnvVariableName },
    payload: SetEnvVariable,
    success: EnvVariable,
    error: WriteErrors,
  }),
  HttpApiEndpoint.delete(
    "delete",
    "/projects/:projectId/environments/:environment/variables/:name",
    {
      params: { ...environmentParams, name: EnvVariableName },
      error: WriteErrors,
    },
  ),
  HttpApiEndpoint.post(
    "import",
    "/projects/:projectId/environments/:environment/variables/import",
    {
      params: environmentParams,
      payload: ImportEnvVariables,
      success: ImportEnvVariablesResult,
      error: WriteErrors,
    },
  ),
) {}

export class DomainsGroup extends HttpApiGroup.make("domains").add(
  HttpApiEndpoint.get("list", "/projects/:projectId/domains", {
    params: projectParams,
    success: Schema.Array(Domain),
    error: ReadErrors,
  }),
  HttpApiEndpoint.post("add", "/projects/:projectId/domains", {
    params: projectParams,
    payload: AddDomain,
    success: Domain,
    error: WriteErrors,
  }),
  HttpApiEndpoint.post("verify", "/projects/:projectId/domains/:domainId/verify", {
    params: { ...projectParams, domainId: DomainId },
    success: Domain,
    error: WriteErrors,
  }),
  HttpApiEndpoint.delete("remove", "/projects/:projectId/domains/:domainId", {
    params: { ...projectParams, domainId: DomainId },
    error: WriteErrors,
  }),
) {}

export class RegionsGroup extends HttpApiGroup.make("regions").add(
  HttpApiEndpoint.get("catalog", "/regions", {
    success: Schema.Array(Region),
    error: ReadErrors,
  }),
  HttpApiEndpoint.get("list", "/projects/:projectId/environments/:environment/regions", {
    params: environmentParams,
    success: Schema.Array(ProjectRegion),
    error: ReadErrors,
  }),
  HttpApiEndpoint.post("add", "/projects/:projectId/regions", {
    params: projectParams,
    payload: AddRegion,
    success: Region,
    error: WriteErrors,
  }),
  HttpApiEndpoint.delete("remove", "/projects/:projectId/regions/:region", {
    params: { ...projectParams, region: RegionId },
    error: WriteErrors,
  }),
  HttpApiEndpoint.put("setHome", "/projects/:projectId/home-region", {
    params: projectParams,
    payload: SetHomeRegion,
    success: Project,
    error: WriteErrors,
  }),
) {}

export class IntegrationsGroup extends HttpApiGroup.make("integrations").add(
  HttpApiEndpoint.get("list", "/projects/:projectId/integrations", {
    params: projectParams,
    success: Schema.Array(Integration),
    error: ReadErrors,
  }),
  HttpApiEndpoint.post("connect", "/projects/:projectId/integrations/:kind", {
    params: { ...projectParams, kind: IntegrationKind },
    payload: ConnectIntegration,
    success: IntegrationConnection,
    error: WriteErrors,
  }),
  HttpApiEndpoint.delete("disconnect", "/projects/:projectId/integrations/:kind", {
    params: { ...projectParams, kind: IntegrationKind },
    error: WriteErrors,
  }),
) {}
