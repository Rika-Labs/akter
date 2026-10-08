import { Schema } from "effect"

import {
  ActorReference,
  DeploymentId,
  DomainId,
  EnvironmentName,
  Name,
  NonNegative,
  NonNegativeInt,
  OrganizationId,
  ProjectId,
  RegionId,
  Slug,
  Timestamp,
} from "./primitives.ts"

export const ProjectStatus = Schema.Literals(["empty", "live", "deploying", "failed"])
export type ProjectStatus = typeof ProjectStatus.Type

export const Region = Schema.Struct({ id: RegionId, city: Schema.String })
export type Region = typeof Region.Type

export const Project = Schema.Struct({
  id: ProjectId,
  organizationId: OrganizationId,
  name: Schema.String,
  slug: Slug,
  status: ProjectStatus,
  homeRegion: RegionId,
  createdAt: Timestamp,
})
export type Project = typeof Project.Type

export const CreateProject = Schema.Struct({ name: Name, slug: Slug, homeRegion: RegionId })
export type CreateProject = typeof CreateProject.Type

export const UpdateProject = Schema.Struct({
  name: Schema.optional(Name),
  slug: Schema.optional(Slug),
})
export type UpdateProject = typeof UpdateProject.Type

export const Environment = Schema.Struct({
  name: EnvironmentName,
  projectId: ProjectId,
  currentDeploymentId: Schema.NullOr(DeploymentId),
  database: Schema.optionalKey(
    Schema.Struct({
      configured: Schema.Boolean,
      engine: Schema.Literal("postgres"),
    }),
  ),
})
export type Environment = typeof Environment.Type

export const CreateEnvironment = Schema.Struct({ name: EnvironmentName })
export type CreateEnvironment = typeof CreateEnvironment.Type

/** An environment variable as readable: its name and provenance, never its value or any part of it. */
export const EnvVariable = Schema.Struct({
  name: Schema.String,
  usedBy: Schema.Array(Schema.String),
  updatedAt: Timestamp,
  updatedBy: Schema.NullOr(ActorReference),
})
export type EnvVariable = typeof EnvVariable.Type

export const EnvVariableName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,255}$/)),
)
export type EnvVariableName = typeof EnvVariableName.Type

/** The write-only value of a variable, at most 64 KiB. */
export const SetEnvVariable = Schema.Struct({
  value: Schema.String.pipe(Schema.check(Schema.isMaxLength(65536))),
})
export type SetEnvVariable = typeof SetEnvVariable.Type

/** The text of a `.env` file, at most 1 MiB. */
export const ImportEnvVariables = Schema.Struct({
  content: Schema.String.pipe(Schema.check(Schema.isMaxLength(1048576))),
})
export type ImportEnvVariables = typeof ImportEnvVariables.Type

export const ImportEnvVariablesResult = Schema.Struct({
  created: Schema.Array(Schema.String),
  updated: Schema.Array(Schema.String),
})
export type ImportEnvVariablesResult = typeof ImportEnvVariablesResult.Type

export const DomainStatus = Schema.Literals(["pending", "verifying", "active"])
export type DomainStatus = typeof DomainStatus.Type

export const DnsRecord = Schema.Struct({
  type: Schema.Literals(["A", "AAAA", "CNAME", "TXT"]),
  name: Schema.String,
  value: Schema.String,
})
export type DnsRecord = typeof DnsRecord.Type

export const Hostname = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(253),
    Schema.isPattern(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
  ),
)
export type Hostname = typeof Hostname.Type

export const Domain = Schema.Struct({
  id: DomainId,
  hostname: Hostname,
  environment: EnvironmentName,
  status: DomainStatus,
  dnsRecords: Schema.Array(DnsRecord),
  createdAt: Timestamp,
})
export type Domain = typeof Domain.Type

export const AddDomain = Schema.Struct({ hostname: Hostname, environment: EnvironmentName })
export type AddDomain = typeof AddDomain.Type

export const OwnedTable = Schema.Struct({
  name: Schema.String,
  actor: Schema.String,
  rows: NonNegativeInt,
  sizeBytes: NonNegativeInt,
  region: RegionId,
})
export type OwnedTable = typeof OwnedTable.Type

/** One region of an environment: its database, load and largest owned tables. */
export const ProjectRegion = Schema.Struct({
  region: Region,
  home: Schema.Boolean,
  tenantCount: NonNegativeInt,
  database: Schema.Struct({
    engine: Schema.String,
    version: Schema.String,
    sizeBytes: NonNegativeInt,
  }),
  storage: Schema.Struct({ usedBytes: NonNegativeInt, limitBytes: NonNegativeInt }),
  cpuPercent: NonNegative,
  connections: Schema.Struct({ used: NonNegativeInt, limit: NonNegativeInt }),
  runners: NonNegativeInt,
  shardGroup: Schema.String,
  backups: Schema.Struct({
    pointInTimeRecovery: Schema.Boolean,
    latestBackupAt: Schema.NullOr(Timestamp),
  }),
  largestTables: Schema.Array(OwnedTable),
})
export type ProjectRegion = typeof ProjectRegion.Type

export const AddRegion = Schema.Struct({ region: RegionId })
export type AddRegion = typeof AddRegion.Type

export const SetHomeRegion = Schema.Struct({ region: RegionId })
export type SetHomeRegion = typeof SetHomeRegion.Type

export const ProjectEndpoints = Schema.Struct({
  httpBaseUrl: Schema.String,
  webSocketUrl: Schema.String,
  openApiPath: Schema.String,
  mcpPath: Schema.String,
})
export type ProjectEndpoints = typeof ProjectEndpoints.Type

export const IntegrationKind = Schema.Literals([
  "github",
  "slack",
  "datadog",
  "opentelemetry",
  "pagerduty",
])
export type IntegrationKind = typeof IntegrationKind.Type

export const Integration = Schema.Struct({
  kind: IntegrationKind,
  status: Schema.Literals(["connected", "disconnected", "error"]),
  label: Schema.NullOr(Schema.String),
  connectedAt: Schema.NullOr(Timestamp),
})
export type Integration = typeof Integration.Type

/** Write-only settings for key-based integrations; OAuth integrations send none and follow the returned URL. */
export const ConnectIntegration = Schema.Struct({
  settings: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
export type ConnectIntegration = typeof ConnectIntegration.Type

export const IntegrationConnection = Schema.Struct({
  redirectUrl: Schema.NullOr(Schema.String),
  integration: Integration,
})
export type IntegrationConnection = typeof IntegrationConnection.Type
