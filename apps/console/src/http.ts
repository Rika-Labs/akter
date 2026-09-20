import { Schema } from "effect"

// These schemas validate the own-API boundary, not third-party provider payloads.
export const Organization = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
})

export const Organizations = Schema.Array(Organization)

export type Organizations = typeof Organizations.Type

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

export type Dashboard = typeof Dashboard.Type

export const ApiError = Schema.Struct({ message: Schema.optionalKey(Schema.String) })

export const BillingLink = Schema.Struct({ url: Schema.String })
