import { Schema } from "effect"

/**
 * An organization. These schemas validate the own-API boundary, not
 * third-party provider payloads.
 */
export const Organization = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
})

/** The caller's organizations. */
export const Organizations = Schema.Array(Organization)

/** The caller's organizations. */
export type Organizations = typeof Organizations.Type

/** The API's dashboard body: user, active organization, members, projects and billing. */
export const Dashboard = Schema.Struct({
  user: Schema.Struct({ name: Schema.String, email: Schema.String }),
  organization: Schema.NullOr(Schema.Struct({ ...Organization.fields, role: Schema.String })),
  members: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      email: Schema.String,
      role: Schema.String,
    }),
  ),
  projects: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, status: Schema.String }),
  ),
  billing: Schema.Struct({
    plan: Schema.String,
    status: Schema.String,
    renewalDate: Schema.optionalKey(Schema.String),
  }),
})

/** The API's dashboard body: user, active organization, members, projects and billing. */
export type Dashboard = typeof Dashboard.Type

/** An API error body with an optional message safe to show. */
export const ApiError = Schema.Struct({ message: Schema.optionalKey(Schema.String) })

/** A checkout or portal redirect target. */
export const BillingLink = Schema.Struct({ url: Schema.String })
