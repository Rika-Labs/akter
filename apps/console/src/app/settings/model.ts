import { Schema as S } from "effect"

/** A runtime variable; secrets show only their last characters. */
export const Variable = S.Struct({
  name: S.String,
  value: S.String,
  secret: S.Boolean,
  usedBy: S.String,
  updated: S.String,
  environment: S.String,
})
export type Variable = typeof Variable.Type

/** A custom or default domain and whether its DNS checks out. */
export const Domain = S.Struct({
  host: S.String,
  status: S.Literals(["Active", "Pending DNS", "Default"]),
  detail: S.String,
})

/** An API key; only its prefix and last characters are ever shown. */
export const ApiKey = S.Struct({
  name: S.String,
  masked: S.String,
  scope: S.String,
  lastUsed: S.String,
})
export type ApiKey = typeof ApiKey.Type

/** A third-party integration and whether it is connected. */
export const Integration = S.Struct({
  id: S.String,
  name: S.String,
  detail: S.String,
  connected: S.Boolean,
})

/** A member of the organization, or a pending invitation when `pending`. */
export const Member = S.Struct({
  name: S.String,
  email: S.String,
  role: S.String,
  pending: S.Boolean,
})
export type Member = typeof Member.Type

/** A monthly invoice from Stripe. */
export const Invoice = S.Struct({ number: S.String, period: S.String, amount: S.Finite })

/** One usage meter against what the plan includes. */
export const UsageMeter = S.Struct({
  label: S.String,
  used: S.Finite,
  included: S.Finite,
  unit: S.Literals(["count", "hours", "gigabytes"]),
})
export type UsageMeter = typeof UsageMeter.Type

/** Usage and estimated cost per project. */
export const ProjectUsage = S.Struct({
  project: S.String,
  commands: S.String,
  runnerHours: S.String,
  storage: S.String,
  estimate: S.Finite,
})

/** One entry in the organization's audit log. */
export const AuditEntry = S.Struct({
  key: S.String,
  time: S.String,
  person: S.String,
  action: S.String,
  target: S.String,
})

/** A region the project can run in. */
export const RegionChoice = S.Struct({
  id: S.String,
  place: S.String,
  role: S.Literals(["Home", "Replica", "Available"]),
})

/** Everything the settings pages read, loaded once when Settings opens. */
export const SettingsPage = S.TaggedStruct("SettingsPage", {
  variables: S.Array(Variable),
  domains: S.Array(Domain),
  keys: S.Array(ApiKey),
  endpoints: S.Array(S.Struct({ label: S.String, value: S.String })),
  integrations: S.Array(Integration),
  members: S.Array(Member),
  plan: S.Struct({ name: S.String, price: S.String, renews: S.String }),
  monthToDate: S.Finite,
  spendLimit: S.Finite,
  card: S.Struct({ brand: S.String, last4: S.String, expires: S.String }),
  billingEmail: S.String,
  invoices: S.Array(Invoice),
  usageMonth: S.String,
  meters: S.Array(UsageMeter),
  commandsPerDay: S.Array(S.Finite),
  projects: S.Array(ProjectUsage),
  audit: S.Array(AuditEntry),
  regions: S.Array(RegionChoice),
})
export type SettingsPage = typeof SettingsPage.Type
