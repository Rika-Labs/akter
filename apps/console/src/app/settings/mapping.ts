import {
  type ActorReference,
  type ApiKey as CloudApiKey,
  type AuditEntry as CloudAuditEntry,
  type BillingSummary,
  type Domain as CloudDomain,
  type Environment,
  type EnvVariable,
  type Integration as CloudIntegration,
  type IntegrationKind,
  type Invitation,
  type Invoice as CloudInvoice,
  type Member as CloudMember,
  type Organization,
  type PlanCatalog,
  type Project,
  type ProjectEndpoints,
  type Region,
  type Role,
  type Usage as CloudUsage,
  type UsageMeterName,
} from "@akter/cloud-api"
import { DateTime, Match, Option, Schema } from "effect"
import {
  type ApiKey,
  type AuditEntry,
  type Billing,
  BillingPlan,
  type Domain,
  type Endpoint,
  type EnvironmentVariables,
  type Integration,
  type Invoice,
  type Member,
  type OrganizationSummary,
  PaidPlan,
  type PendingInvitation,
  type Plans,
  type ProjectSummary,
  type RegionChoice,
  type Usage,
  type UsageMeter,
  type Variable,
} from "./model.ts"
import { browserContext, hostedPageUrl } from "./stripe.ts"

const millis = (instant: DateTime.Utc): number => DateTime.toEpochMillis(instant)

/** The name to show for who did something; a nameless key is still known to be a key. */
export const actorName = (actor: ActorReference): string | null =>
  actor.name ?? (actor.kind === "api-key" ? "API key" : null)

export const toVariable = (variable: EnvVariable): Variable => ({
  name: variable.name,
  usedBy: variable.usedBy,
  updatedAt: millis(variable.updatedAt),
  updatedBy: variable.updatedBy === null ? null : actorName(variable.updatedBy),
})

/** The variables of each environment, in the order the environments were listed. */
export const toEnvironments = (input: {
  readonly environments: ReadonlyArray<Environment>
  readonly variables: ReadonlyArray<ReadonlyArray<Variable>>
}): ReadonlyArray<EnvironmentVariables> =>
  input.environments.map((environment, index) => ({
    environment: environment.name,
    variables: input.variables[index] ?? [],
  }))

export const toProjectSummary = (input: {
  readonly project: Project
  readonly environment: ProjectSummary["environment"]
}): ProjectSummary => ({
  id: input.project.id,
  name: input.project.name,
  slug: input.project.slug,
  homeRegion: input.project.homeRegion,
  environment: input.environment,
})

export const toOrganizationSummary = (input: {
  readonly organization: Organization
  readonly role: Role
}): OrganizationSummary => ({
  id: input.organization.id,
  name: input.organization.name,
  slug: input.organization.slug,
  plan: input.organization.plan,
  role: input.role,
})

export const toDomain = (domain: CloudDomain): Domain => ({
  id: domain.id,
  hostname: domain.hostname,
  environment: domain.environment,
  status: domain.status,
  records: domain.dnsRecords.map((record) => ({
    type: record.type,
    name: record.name,
    value: record.value,
  })),
})

/** Revoked keys are dropped: they no longer authenticate and have nothing left to manage. */
export const toKeys = (keys: ReadonlyArray<CloudApiKey>): ReadonlyArray<ApiKey> =>
  keys.flatMap((key) =>
    key.revokedAt === null
      ? [
          {
            id: key.id,
            name: key.name,
            tail: `${key.prefix}…${key.lastFour}`,
            permission: key.permission,
            projectScoped: key.projectId !== null,
            lastUsedAt: key.lastUsedAt === null ? null : millis(key.lastUsedAt),
            expiresAt: key.expiresAt === null ? null : millis(key.expiresAt),
          },
        ]
      : [],
  )

const join = (base: string, path: string): string =>
  `${base.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`

export const toEndpoints = (endpoints: ProjectEndpoints): ReadonlyArray<Endpoint> => [
  { label: "HTTP", value: endpoints.httpBaseUrl },
  { label: "WebSocket", value: endpoints.webSocketUrl },
  { label: "OpenAPI", value: join(endpoints.httpBaseUrl, endpoints.openApiPath) },
  { label: "MCP", value: join(endpoints.httpBaseUrl, endpoints.mcpPath) },
]

const integrationKinds: ReadonlyArray<
  Readonly<{ kind: IntegrationKind; name: string; detail: string }>
> = [
  { kind: "github", name: "GitHub", detail: "Deploy on push to a branch" },
  { kind: "slack", name: "Slack", detail: "Deploy and dead-letter alerts in a channel" },
  { kind: "datadog", name: "Datadog", detail: "Send metrics and traces" },
  { kind: "opentelemetry", name: "OpenTelemetry", detail: "Export traces to an OTLP endpoint" },
  { kind: "pagerduty", name: "PagerDuty", detail: "Page on-call when a deploy rolls back" },
]

/** Every integration Akter supports; one the project has not touched reads as disconnected. */
export const toIntegrations = (
  integrations: ReadonlyArray<CloudIntegration>,
): ReadonlyArray<Integration> =>
  integrationKinds.map((known) => {
    const current = integrations.find((integration) => integration.kind === known.kind)
    return {
      kind: known.kind,
      name: known.name,
      detail: current?.label ?? known.detail,
      status: current?.status ?? "disconnected",
    }
  })

export const toMember = (member: CloudMember): Member => ({
  id: member.id,
  name: member.user.name,
  email: member.user.email,
  role: member.role,
})

/** Only invitations still waiting for an answer; accepted ones are members and the rest are over. */
export const toPendingInvitations = (
  invitations: ReadonlyArray<Invitation>,
): ReadonlyArray<PendingInvitation> =>
  invitations.flatMap((invitation) =>
    invitation.status === "pending"
      ? [
          {
            id: invitation.id,
            email: invitation.email,
            role: invitation.role,
            invitedBy: invitation.invitedBy.name,
            createdAt: millis(invitation.createdAt),
          },
        ]
      : [],
  )

/**
 * The home region and replicas come from the environment's own regions; every other region in the
 * catalog is available to add.
 */
export const toRegionChoices = (input: {
  readonly catalog: ReadonlyArray<Region>
  readonly running: ReadonlyArray<Region & Readonly<{ home: boolean }>>
}): ReadonlyArray<RegionChoice> => {
  const { catalog, running } = input
  const inUse = running.map((entry) => ({
    id: entry.id,
    city: entry.city,
    role: entry.home ? ("Home" as const) : ("Replica" as const),
  }))
  const available = catalog.flatMap((region) =>
    running.some((entry) => entry.id === region.id)
      ? []
      : [{ id: region.id, city: region.city, role: "Available" as const }],
  )
  return [...inUse, ...available]
}

/** An organization without a billing account keeps its `unbound` plan, which has no price or allowances. */
export const toBilling = (billing: BillingSummary): Billing => ({
  plan: Match.valueTags(billing.plan, {
    unbound: (plan) => plan,
    known: (plan) =>
      BillingPlan.make({
        id: plan.id,
        name: plan.name,
        subscribed: plan.subscribedId ?? plan.id,
        paymentStatus: plan.paymentStatus ?? null,
        basePriceCents: plan.basePriceCents,
        provisional: plan.provisional ?? false,
        renewsAt: plan.renewsAt === null ? null : millis(plan.renewsAt),
        monthToDateCents: plan.monthToDateEstimateCents,
      }),
  }),
  card:
    billing.paymentMethod === null
      ? null
      : {
          brand: billing.paymentMethod.brand,
          lastFour: billing.paymentMethod.lastFour,
          expiryMonth: billing.paymentMethod.expiryMonth,
          expiryYear: billing.paymentMethod.expiryYear,
        },
  billingEmail: billing.billingEmail,
  spendLimit: {
    limitCents: billing.spendLimit.limitCents,
    currentCents: billing.spendLimit.currentSpendCents,
  },
  caps: billing.caps ?? [],
})

const isPaidPlan = Schema.is(PaidPlan)

/**
 * The catalog as the Billing page offers it. Only a plan the catalog sells through Checkout, and
 * which Checkout and plan changes accept, can be chosen.
 */
export const toPlans = (catalog: PlanCatalog): Plans => ({
  plans: catalog.plans.map((plan) => ({
    id: plan.id,
    name: plan.name,
    basePriceCents: plan.basePriceCents,
    includedCommands: plan.allowances.commands,
    commandCap: plan.features.includes("command-cap") ? plan.allowances.commandCap : null,
    commandCentsPerMillion: plan.overage.commandCentsPerMillion,
    storageGb: plan.allowances.storageGb,
    storageCap: plan.features.includes("storage-cap"),
    storageCentsPerGbMonth: plan.overage.storageCentsPerGbMonth,
    connections: plan.allowances.concurrentConnections,
    checkout: plan.features.includes("checkout") && isPaidPlan(plan.id) ? plan.id : null,
    provisional: plan.provisional,
  })),
  readCommandWeight: catalog.readCommandWeight,
  provisional: catalog.provisional,
})

/** Newest first, by the start of the period each invoice covers; a PDF off Stripe is dropped. */
export const toInvoices = (invoices: ReadonlyArray<CloudInvoice>): ReadonlyArray<Invoice> =>
  invoices
    .map((invoice) => ({
      id: invoice.id,
      number: invoice.number,
      periodStart: millis(invoice.periodStart),
      amountCents: invoice.amountCents,
      status: invoice.status,
      pdfUrl:
        invoice.pdfUrl === null
          ? null
          : Option.getOrNull(hostedPageUrl(invoice.pdfUrl, browserContext())),
    }))
    .toSorted((a, b) => b.periodStart - a.periodStart)

const meters: Readonly<
  Record<UsageMeterName, Readonly<{ label: string; unit: UsageMeter["unit"] }>>
> = {
  commands: { label: "Commands", unit: "count" },
  reads: { label: "Reads", unit: "count" },
  runnerHours: { label: "Runner hours", unit: "hours" },
  storageGb: { label: "Storage", unit: "gigabytes" },
  egressGb: { label: "Egress", unit: "gigabytes" },
}

export const toUsage = (usage: CloudUsage): Usage => ({
  period: usage.period,
  meters: usage.meters.map((meter) => ({
    meter: meter.meter,
    label: meters[meter.meter].label,
    unit: meters[meter.meter].unit,
    used: meter.used,
    included: meter.included,
    overage: meter.overage,
    overageCostCents: meter.overageCostCents,
  })),
  latestStorageSample:
    usage.latestStorageSample == null
      ? null
      : {
          bytes: usage.latestStorageSample.bytes,
          sampledAt: millis(usage.latestStorageSample.sampledAt),
        },
  caps: usage.caps ?? [],
  commandsPerDay: usage.commandsPerDay.map((day) => ({ day: day.day, commands: day.commands })),
  projects: usage.byProject.map((project) => ({
    id: project.projectId,
    name: project.name,
    commands: project.commands,
    reads: project.reads ?? null,
    estimatedCostCents: project.estimatedCostCents,
  })),
  pricing: {
    freeCommands: usage.pricing.freeCommands,
    readCommandWeight: usage.pricing.readCommandWeight,
    storagePerGbCents: usage.pricing.storagePerGbCents,
    provisional: usage.pricing.provisional ?? false,
  },
})

/** A target is shown by name when it has one, otherwise by id, otherwise by its kind. */
export const toAuditEntry = (entry: CloudAuditEntry): AuditEntry => ({
  id: entry.id,
  at: millis(entry.at),
  person: actorName(entry.actor) ?? entry.actor.id,
  action: entry.action,
  target: entry.target.name ?? entry.target.id ?? entry.target.type,
})
