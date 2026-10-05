import {
  ApiKeyPermission,
  CapState,
  DomainStatus,
  EnvironmentName,
  IntegrationKind,
  InviteRole,
  NotificationPreference,
  OrganizationPlan,
  PaymentMethod,
  Plan,
  PlanId,
  Preferences,
  RegionId,
  Role,
  StartCheckout,
  UnboundPlan,
  UsageMeterName,
} from "@akter/cloud-api"
import { Match, Schema as S } from "effect"

/**
 * Timestamps are epoch milliseconds, money is whole US cents, and storage and egress are
 * gigabytes, exactly as the control plane reports them; views format them for display.
 */

/** An environment variable as readable: its name and provenance, never its value or any part of it. */
export const Variable = S.Struct({
  name: S.String,
  usedBy: S.Array(S.String),
  updatedAt: S.Finite,
  updatedBy: S.NullOr(S.String),
})
export type Variable = typeof Variable.Type

/** The variables of one environment that exists in the project. */
export const EnvironmentVariables = S.Struct({
  environment: EnvironmentName,
  variables: S.Array(Variable),
})
export type EnvironmentVariables = typeof EnvironmentVariables.Type

/** The project the project-level settings pages act on, and the environment they open on. */
export const ProjectSummary = S.Struct({
  id: S.String,
  name: S.String,
  slug: S.String,
  homeRegion: RegionId,
  environment: EnvironmentName,
})
export type ProjectSummary = typeof ProjectSummary.Type

/** The organization the organization-level settings pages act on, and the plan it is on. */
export const OrganizationSummary = S.Struct({
  id: S.String,
  name: S.String,
  slug: S.String,
  plan: OrganizationPlan,
  role: Role,
})
export type OrganizationSummary = typeof OrganizationSummary.Type

/** The signed-in person, as the profile page shows them. */
export const Profile = S.Struct({ name: S.String, email: S.String, emailVerified: S.Boolean })
export type Profile = typeof Profile.Type

/** A DNS record a domain needs before it can be verified. */
export const DnsRecord = S.Struct({ type: S.String, name: S.String, value: S.String })

/** A custom domain, the environment it serves, and the DNS records it needs. */
export const Domain = S.Struct({
  id: S.String,
  hostname: S.String,
  environment: EnvironmentName,
  status: DomainStatus,
  records: S.Array(DnsRecord),
})
export type Domain = typeof Domain.Type

/** An API key; only its prefix and last four characters are ever readable. */
export const ApiKey = S.Struct({
  id: S.String,
  name: S.String,
  tail: S.String,
  permission: ApiKeyPermission,
  projectScoped: S.Boolean,
  lastUsedAt: S.NullOr(S.Finite),
  expiresAt: S.NullOr(S.Finite),
})
export type ApiKey = typeof ApiKey.Type

/** A URL the project answers on. */
export const Endpoint = S.Struct({ label: S.String, value: S.String })
export type Endpoint = typeof Endpoint.Type

/** A third-party integration and whether it is connected. */
export const Integration = S.Struct({
  kind: IntegrationKind,
  name: S.String,
  detail: S.String,
  status: S.Literals(["connected", "disconnected", "error"]),
})
export type Integration = typeof Integration.Type

/** A member of the organization. */
export const Member = S.Struct({ id: S.String, name: S.String, email: S.String, role: Role })
export type Member = typeof Member.Type

/** An invitation that has not been accepted, declined, canceled or expired. */
export const PendingInvitation = S.Struct({
  id: S.String,
  email: S.String,
  role: InviteRole,
  invitedBy: S.String,
  createdAt: S.Finite,
})
export type PendingInvitation = typeof PendingInvitation.Type

/** A region the project can run in: its home, a replica, or one it could add. */
export const RegionChoice = S.Struct({
  id: RegionId,
  city: S.String,
  role: S.Literals(["Home", "Replica", "Available"]),
})
export type RegionChoice = typeof RegionChoice.Type

/** A plan that is paid for through a Stripe subscription. */
export const PaidPlan = StartCheckout.fields.plan
export type PaidPlan = typeof PaidPlan.Type

/** Where the subscription's payments stand; `free` means there is no paid subscription. */
export const PaymentStatus = Plan.fields.paymentStatus.schema
export type PaymentStatus = typeof PaymentStatus.Type

/**
 * The plan an organization's billing account is on. `id` is the plan whose limits apply now and
 * `subscribed` the plan the subscription bills; they differ while a payment is failing, which
 * withdraws paid limits without ending the subscription. `paymentStatus` is null when the control
 * plane does not report one. It is tagged `known`, like the contract's plan, so it is told from an
 * `unbound` one by its tag.
 */
export const BillingPlan = S.TaggedStruct("known", {
  id: PlanId,
  name: S.String,
  subscribed: PlanId,
  paymentStatus: S.NullOr(PaymentStatus),
  basePriceCents: S.Finite,
  provisional: S.Boolean,
  renewsAt: S.NullOr(S.Finite),
  monthToDateCents: S.Finite,
})
export type BillingPlan = typeof BillingPlan.Type

/**
 * The Stripe subscription as the control plane reports it. `plan` is `unbound` when the
 * organization has no billing account: it has no plan, price or allowances, and is never Free.
 */
export const Billing = S.Struct({
  plan: S.Union([BillingPlan, UnboundPlan]),
  paymentMethod: S.NullOr(PaymentMethod),
  billingEmail: S.NullOr(S.String),
  spendLimit: S.Struct({ limitCents: S.NullOr(S.Finite), currentCents: S.Finite }),
  caps: S.Array(CapState),
})
export type Billing = typeof Billing.Type

/**
 * The plan billing prices the organization on, or undefined when it has no billing account. The
 * control plane reports every cap `unbound` exactly then, so pages that read only caps agree.
 */
export const billedPlan = (billing: Billing): BillingPlan | undefined =>
  Match.valueTags(billing.plan, { unbound: () => undefined, known: (plan) => plan })

/**
 * One plan of the control plane's catalog. `commandCap` is the hard stop in commands, null when
 * overage is billed instead; `storageCap` says whether the included storage is a hard stop.
 * `checkout` is the plan Checkout and plan changes take, null for a plan that is not bought.
 */
export const PlanOffer = S.Struct({
  id: PlanId,
  name: S.String,
  basePriceCents: S.Finite,
  includedCommands: S.Finite,
  commandCap: S.NullOr(S.Finite),
  commandCentsPerMillion: S.Finite,
  storageGb: S.Finite,
  storageCap: S.Boolean,
  storageCentsPerGbMonth: S.Finite,
  connections: S.Finite,
  checkout: S.NullOr(PaidPlan),
  provisional: S.Boolean,
})
export type PlanOffer = typeof PlanOffer.Type

/** The plan catalog, cheapest first; `provisional` is true while any plan's prices are. */
export const Plans = S.Struct({
  plans: S.Array(PlanOffer),
  readCommandWeight: S.Finite,
  provisional: S.Boolean,
})
export type Plans = typeof Plans.Type

/** An invoice; `pdfUrl` is null until Stripe has rendered one. */
export const Invoice = S.Struct({
  id: S.String,
  number: S.String,
  periodStart: S.Finite,
  amountCents: S.Finite,
  status: S.Literals(["draft", "open", "paid", "void", "uncollectible"]),
  pdfUrl: S.NullOr(S.String),
})
export type Invoice = typeof Invoice.Type

/**
 * One usage meter against what the plan includes. The `commands` meter counts command equivalents:
 * commands plus reads at the pricing's read weight. The `reads` meter is informational, and its
 * allowance is what is left of the shared one in read units.
 */
export const UsageMeter = S.Struct({
  meter: UsageMeterName,
  label: S.String,
  used: S.Finite,
  included: S.Finite,
  overage: S.Finite,
  overageCostCents: S.Finite,
  unit: S.Literals(["count", "hours", "gigabytes"]),
})
export type UsageMeter = typeof UsageMeter.Type

/** The rules usage is priced by, as the control plane reports them with each period. */
export const UsagePricing = S.Struct({
  freeCommands: S.Finite,
  readCommandWeight: S.Finite,
  storagePerGbCents: S.Finite,
  provisional: S.Boolean,
})
export type UsagePricing = typeof UsagePricing.Type

/**
 * Usage for one billing period; a project's `reads` is null when the control plane omits it.
 * `latestStorageSample` (bytes, summed over serving deployments' tenants) and `caps` describe now,
 * whatever the period; the sample is null before any tenant was sampled.
 */
export const Usage = S.Struct({
  period: S.String,
  meters: S.Array(UsageMeter),
  latestStorageSample: S.NullOr(S.Struct({ bytes: S.Finite, sampledAt: S.Finite })),
  caps: S.Array(CapState),
  commandsPerDay: S.Array(S.Struct({ day: S.String, commands: S.Finite })),
  projects: S.Array(
    S.Struct({
      id: S.String,
      name: S.String,
      commands: S.Finite,
      reads: S.NullOr(S.Finite),
      estimatedCostCents: S.Finite,
    }),
  ),
  pricing: UsagePricing,
})
export type Usage = typeof Usage.Type

/** One entry in the organization's audit log. */
export const AuditEntry = S.Struct({
  id: S.String,
  at: S.Finite,
  person: S.String,
  action: S.String,
  target: S.String,
})
export type AuditEntry = typeof AuditEntry.Type

/** The slices a settings page can load; each one is read from one endpoint group and has its own source. */
export const SettingsSection = S.Literals([
  "preferences",
  "notifications",
  "profile",
  "organization",
  "project",
  "environments",
  "regions",
  "domains",
  "keys",
  "endpoints",
  "integrations",
  "members",
  "invitations",
  "billing",
  "plans",
  "invoices",
  "usage",
  "audit",
])
export type SettingsSection = typeof SettingsSection.Type

/**
 * What the settings pages read. A route loads only the slices it renders, so every other slice
 * holds its empty value: an empty array, or null for a single record. `unknownPlan` is set when
 * billing or usage could not be read because the organization's stored plan is not in the pricing
 * configuration, which leaves that slice null. `sampleSections` names the slices that hold sample
 * data rather than the control plane's answer; nothing they show may be acted on.
 */
export const SettingsPage = S.TaggedStruct("SettingsPage", {
  preferences: S.NullOr(Preferences),
  notifications: S.Array(NotificationPreference),
  profile: S.NullOr(Profile),
  organization: S.NullOr(OrganizationSummary),
  project: S.NullOr(ProjectSummary),
  environments: S.Array(EnvironmentVariables),
  regions: S.Array(RegionChoice),
  domains: S.Array(Domain),
  keys: S.Array(ApiKey),
  endpoints: S.Array(Endpoint),
  integrations: S.Array(Integration),
  members: S.Array(Member),
  invitations: S.Array(PendingInvitation),
  billing: S.NullOr(Billing),
  plans: S.NullOr(Plans),
  invoices: S.Array(Invoice),
  usage: S.NullOr(Usage),
  audit: S.Array(AuditEntry),
  auditTruncated: S.Boolean,
  unknownPlan: S.Boolean,
  sampleSections: S.Array(SettingsSection),
})
export type SettingsPage = typeof SettingsPage.Type

/** The part of a settings page one endpoint group supplies. */
export type SettingsSlice = Partial<Omit<SettingsPage, "_tag" | "sampleSections">>

/** A settings page with nothing loaded. */
export const emptySettings: SettingsPage = SettingsPage.make({
  preferences: null,
  notifications: [],
  profile: null,
  organization: null,
  project: null,
  environments: [],
  regions: [],
  domains: [],
  keys: [],
  endpoints: [],
  integrations: [],
  members: [],
  invitations: [],
  billing: null,
  plans: null,
  invoices: [],
  usage: null,
  audit: [],
  auditTruncated: false,
  unknownPlan: false,
  sampleSections: [],
})
