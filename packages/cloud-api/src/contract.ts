import { HttpApi, OpenApi } from "effect/http-api"

import { Authentication } from "./auth.ts"
import {
  AccountGroup,
  ApiKeysGroup,
  InvitationsGroup,
  MembersGroup,
  OrganizationsGroup,
} from "./groups/account.ts"
import { AuditGroup, BillingGroup, UsageGroup } from "./groups/billing.ts"
import { DeploymentsGroup } from "./groups/deployments.ts"
import {
  DomainsGroup,
  EnvironmentApiKeysGroup,
  EnvironmentVariablesGroup,
  IntegrationsGroup,
  ProjectsGroup,
  RegionsGroup,
} from "./groups/projects.ts"
import { RuntimeGroup } from "./groups/runtime.ts"

/**
 * The console's control-plane and runtime-inspection API. Every endpoint lives
 * under `/api` and requires `Authentication`; a browser client carries the
 * session cookie and a machine client sends `x-api-key`. Sign-in, sign-up,
 * email verification and password reset are Better Auth's own routes under
 * `/auth`, not part of this API.
 */
export class CloudApi extends HttpApi.make("akter-cloud")
  .add(
    AccountGroup,
    OrganizationsGroup,
    MembersGroup,
    InvitationsGroup,
    ApiKeysGroup,
    ProjectsGroup,
    EnvironmentApiKeysGroup,
    EnvironmentVariablesGroup,
    DomainsGroup,
    RegionsGroup,
    IntegrationsGroup,
    DeploymentsGroup,
    RuntimeGroup,
    BillingGroup,
    UsageGroup,
    AuditGroup,
  )
  .middleware(Authentication)
  .prefix("/api")
  .annotateMerge(OpenApi.annotations({ title: "Akter Cloud API" })) {}
