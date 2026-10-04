import { seededSeries } from "../workspace/series.ts"
import type { SettingsSlice } from "./model.ts"

const at = (month: number, day: number, hour = 12, minute = 0): number =>
  Date.UTC(2026, month - 1, day, hour, minute)

/** Fixture settings for the Acme organization and its `storefront` project. Test data. */

export const preferencesSlice: SettingsSlice = {
  preferences: {
    defaultEnvironment: "production",
    openActorLinksInNewTab: false,
    timeZone: "UTC",
    pauseLiveTailOnScroll: true,
    showReplayedCommands: false,
    theme: "system",
  },
}

export const notificationsSlice: SettingsSlice = {
  notifications: [
    { event: "deploy_failed", email: true, slack: false },
    { event: "dead_letter", email: true, slack: false },
    { event: "spend_threshold", email: false, slack: false },
  ],
}

export const profileSlice: SettingsSlice = {
  profile: { name: "Dallen Pyrah", email: "dallen@acme.dev", emailVerified: true },
}

export const organizationSlice: SettingsSlice = {
  organization: { id: "org_acme", name: "Acme", slug: "acme", plan: "pro", role: "owner" },
}

export const projectSlice: SettingsSlice = {
  project: {
    id: "prj_storefront",
    name: "storefront",
    slug: "storefront",
    homeRegion: "us-east-1",
    environment: "production",
  },
}

export const environmentsSlice: SettingsSlice = {
  environments: [
    {
      environment: "production",
      variables: [
        {
          name: "STRIPE_SECRET_KEY",
          usedBy: ["Charge job"],
          updatedAt: at(9, 30),
          updatedBy: "dallen",
        },
        {
          name: "POSTMARK_TOKEN",
          usedBy: ["SendEmail job"],
          updatedAt: at(9, 27),
          updatedBy: "maya",
        },
        {
          name: "OPENAI_API_KEY",
          usedBy: ["CallModel job"],
          updatedAt: at(10, 2, 11, 40),
          updatedBy: "maya",
        },
        { name: "LOG_LEVEL", usedBy: [], updatedAt: at(9, 27), updatedBy: "dallen" },
        { name: "CART_IDLE_TIMEOUT", usedBy: ["Cart"], updatedAt: at(10, 2), updatedBy: null },
      ],
    },
    {
      environment: "staging",
      variables: [
        {
          name: "STRIPE_SECRET_KEY",
          usedBy: ["Charge job"],
          updatedAt: at(9, 24),
          updatedBy: "maya",
        },
        { name: "LOG_LEVEL", usedBy: [], updatedAt: at(9, 24), updatedBy: "maya" },
      ],
    },
    {
      environment: "dev",
      variables: [{ name: "LOG_LEVEL", usedBy: [], updatedAt: at(10, 1), updatedBy: "dallen" }],
    },
  ],
}

export const regionsSlice: SettingsSlice = {
  regions: [
    { id: "us-east-1", city: "Virginia", role: "Home" },
    { id: "us-west-2", city: "Oregon", role: "Available" },
  ],
}

export const domainsSlice: SettingsSlice = {
  domains: [
    {
      id: "dom_api",
      hostname: "api.acme.dev",
      environment: "production",
      status: "active",
      records: [],
    },
    {
      id: "dom_ws",
      hostname: "ws.acme.dev",
      environment: "production",
      status: "pending",
      records: [{ type: "CNAME", name: "ws.acme.dev", value: "storefront.akter.cloud" }],
    },
  ],
}

export const keysSlice: SettingsSlice = {
  keys: [
    {
      id: "key_ci",
      name: "github-actions",
      tail: "ak_live_…3f9a",
      permission: "write",
      projectScoped: true,
      lastUsedAt: at(10, 3, 9, 41),
      expiresAt: null,
    },
    {
      id: "key_bot",
      name: "support-bot",
      tail: "ak_live_…c021",
      permission: "read",
      projectScoped: true,
      lastUsedAt: at(10, 3, 11, 58),
      expiresAt: at(12, 31, 0, 0),
    },
    {
      id: "key_dev",
      name: "local-dev",
      tail: "ak_test_…7e11",
      permission: "admin",
      projectScoped: false,
      lastUsedAt: null,
      expiresAt: null,
    },
  ],
}

export const endpointsSlice: SettingsSlice = {
  endpoints: [
    { label: "HTTP", value: "https://storefront.akter.cloud" },
    { label: "WebSocket", value: "wss://storefront.akter.cloud/ws" },
    { label: "OpenAPI", value: "https://storefront.akter.cloud/openapi.json" },
    { label: "MCP", value: "https://storefront.akter.cloud/mcp" },
  ],
}

export const integrationsSlice: SettingsSlice = {
  integrations: [
    {
      kind: "github",
      name: "GitHub",
      detail: "acme/storefront",
      status: "connected",
    },
    {
      kind: "slack",
      name: "Slack",
      detail: "Deploy and dead-letter alerts in a channel",
      status: "disconnected",
    },
    { kind: "datadog", name: "Datadog", detail: "Send metrics and traces", status: "disconnected" },
    {
      kind: "opentelemetry",
      name: "OpenTelemetry",
      detail: "otlp.acme.dev:4317",
      status: "connected",
    },
    {
      kind: "pagerduty",
      name: "PagerDuty",
      detail: "Page on-call when a deploy rolls back",
      status: "disconnected",
    },
  ],
}

export const membersSlice: SettingsSlice = {
  members: [
    { id: "mem_dallen", name: "Dallen Pyrah", email: "dallen@acme.dev", role: "owner" },
    { id: "mem_maya", name: "Maya Chen", email: "maya@acme.dev", role: "admin" },
    { id: "mem_sam", name: "Sam Okafor", email: "sam@acme.dev", role: "member" },
    { id: "mem_priya", name: "Priya Raman", email: "priya@acme.dev", role: "member" },
  ],
}

export const invitationsSlice: SettingsSlice = {
  invitations: [
    {
      id: "inv_lee",
      email: "lee@acme.dev",
      role: "member",
      invitedBy: "Dallen Pyrah",
      createdAt: at(9, 30, 16, 5),
    },
  ],
}

export const billingSlice: SettingsSlice = {
  billing: {
    plan: {
      id: "pro",
      name: "Pro",
      subscribed: "pro",
      paymentStatus: "active",
      basePriceCents: 2500,
      provisional: true,
      renewsAt: at(11, 1, 0, 0),
      monthToDateCents: 20_670,
    },
    card: { brand: "Visa", lastFour: "4242", expiryMonth: 8, expiryYear: 2028 },
    billingEmail: "billing@acme.dev",
    spendLimit: { limitCents: 50_000, currentCents: 20_670 },
  },
}

export const invoicesSlice: SettingsSlice = {
  invoices: [
    {
      id: "inv_0009",
      number: "INV-0009",
      periodStart: at(9, 1, 0, 0),
      amountCents: 18_840,
      status: "paid",
      pdfUrl: null,
    },
    {
      id: "inv_0008",
      number: "INV-0008",
      periodStart: at(8, 1, 0, 0),
      amountCents: 15_195,
      status: "paid",
      pdfUrl: null,
    },
    {
      id: "inv_0007",
      number: "INV-0007",
      periodStart: at(7, 1, 0, 0),
      amountCents: 9_710,
      status: "paid",
      pdfUrl: null,
    },
  ],
}

export const usageSlice: SettingsSlice = {
  usage: {
    period: "2026-09",
    meters: [
      {
        meter: "commands",
        label: "Commands",
        used: 41_200_000,
        included: 25_000_000,
        overage: 16_200_000,
        overageCostCents: 1620,
        unit: "count",
      },
      {
        meter: "reads",
        label: "Reads",
        used: 9_000_000,
        included: 0,
        overage: 9_000_000,
        overageCostCents: 0,
        unit: "count",
      },
      {
        meter: "storageGb",
        label: "Storage",
        used: 6.4,
        included: 10,
        overage: 0,
        overageCostCents: 0,
        unit: "gigabytes",
      },
    ],
    commandsPerDay: seededSeries({
      length: 30,
      base: 1_380_000,
      volatility: 260_000,
      seed: 51,
    }).map((value, index) => ({
      day: `2026-09-${String(index + 1).padStart(2, "0")}`,
      commands: Math.round(value),
    })),
    projects: [
      {
        id: "prj_storefront",
        name: "storefront",
        commands: 38_000_000,
        reads: 8_200_000,
        estimatedCostCents: 1490,
      },
      {
        id: "prj_bot",
        name: "support-bot",
        commands: 3_100_000,
        reads: 790_000,
        estimatedCostCents: 125,
      },
      {
        id: "prj_tools",
        name: "internal-tools",
        commands: 100_000,
        reads: 10_000,
        estimatedCostCents: 5,
      },
    ],
    pricing: {
      freeCommands: 1_000_000,
      readCommandWeight: 0.2,
      storagePerGbCents: 30,
      provisional: true,
    },
  },
}

export const auditSlice: SettingsSlice = {
  audit: [
    {
      id: "e1",
      at: at(10, 2, 14, 2),
      person: "Dallen Pyrah",
      action: "deploy.created",
      target: "storefront@a3f9c21",
    },
    {
      id: "e2",
      at: at(10, 2, 11, 40),
      person: "Maya Chen",
      action: "variable.updated",
      target: "OPENAI_API_KEY",
    },
    {
      id: "e3",
      at: at(10, 1, 18, 12),
      person: "Dallen Pyrah",
      action: "key.created",
      target: "local-dev",
    },
    {
      id: "e4",
      at: at(10, 1, 9, 30),
      person: "Maya Chen",
      action: "deploy.rolled_back",
      target: "storefront@5d2e7c3",
    },
    {
      id: "e5",
      at: at(9, 30, 16, 5),
      person: "Dallen Pyrah",
      action: "member.invited",
      target: "lee@acme.dev",
    },
  ],
  auditTruncated: false,
}
