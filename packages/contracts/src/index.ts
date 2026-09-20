import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

export class Unavailable extends Schema.TaggedError<Unavailable>()(
  "Unavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

export class Conflict extends Schema.TaggedError<Conflict>()(
  "Conflict",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

export const Name = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(120),
)

export const Project = Schema.Struct({
  id: Schema.String,
  name: Name,
  status: Schema.Literals(["active", "archived"]),
})

export const Organization = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  role: Schema.String,
})

export const Billing = Schema.Struct({
  plan: Schema.Literals(["free", "pro"]),
  status: Schema.String,
  renewalDate: Schema.optional(Schema.String),
})

export const Session = Schema.Struct({
  user: Schema.Struct({ id: Schema.String, name: Schema.String, email: Schema.String }),
  activeOrganizationId: Schema.NullOr(Schema.String),
})

export const Dashboard = Schema.Struct({
  user: Schema.Struct({ name: Schema.String, email: Schema.String }),
  organization: Schema.NullOr(Organization),
  members: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      email: Schema.String,
      role: Schema.String,
    }),
  ),
  billing: Billing,
  projects: Schema.Array(Project),
})

export const OrganizationInput = Schema.Struct({
  name: Name,
  slug: Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), Schema.isMaxLength(80)),
})

const errors = [Unauthorized, Forbidden, Unavailable, Conflict] as const

export class Api extends HttpApi.make("project").add(
  HttpApiGroup.make("health").add(
    HttpApiEndpoint.get("health", "/health", {
      success: Schema.Struct({ status: Schema.Literal("ok") }),
    }),
  ),
  HttpApiGroup.make("account").add(
    HttpApiEndpoint.get("session", "/api/session", { success: Session, error: errors }),
    HttpApiEndpoint.get("dashboard", "/api/dashboard", { success: Dashboard, error: errors }),
    HttpApiEndpoint.post("organization", "/api/organization", {
      payload: OrganizationInput,
      success: Organization,
      error: errors,
    }),
    HttpApiEndpoint.get("projects", "/api/projects", {
      success: Schema.Array(Project),
      error: errors,
    }),
    HttpApiEndpoint.post("createProject", "/api/projects", {
      payload: Schema.Struct({ name: Name }),
      success: Project,
      error: errors,
    }),
    HttpApiEndpoint.post("checkout", "/api/billing/checkout", {
      payload: Schema.Struct({ plan: Schema.Literal("pro") }),
      success: Schema.Struct({ url: Schema.String }),
      error: errors,
    }),
    HttpApiEndpoint.post("portal", "/api/billing/portal", {
      payload: Schema.Struct({}),
      success: Schema.Struct({ url: Schema.String }),
      error: errors,
    }),
  ),
) {}
