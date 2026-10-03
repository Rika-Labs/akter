import {
  ApiKey,
  AuditEntry,
  BillingSummary,
  EnvVariable,
  Integration,
  Invitation,
  Invoice,
  Project,
  ProjectEndpoints,
  ProjectRegion,
  Region,
  Usage,
} from "@akter/cloud-api"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  dollars,
  formatDay,
  formatExpiry,
  formatInstant,
  formatMonth,
  formatPeriod,
} from "./format.ts"
import {
  memberRoleKey,
  notificationKey,
  parseMemberRoleKey,
  parseNotificationKey,
  parseSpendLimit,
  settingsSeed,
  spendLimitValue,
} from "./keys.ts"
import {
  toAuditEntry,
  toBilling,
  toEndpoints,
  toIntegrations,
  toInvoices,
  toKeys,
  toPendingInvitations,
  toProjectSummary,
  toRegionChoices,
  toUsage,
  toVariable,
} from "./mapping.ts"
import { emptySettings } from "./model.ts"

const decode =
  <T, E>(schema: Schema.Codec<T, E>) =>
  (input: Schema.Json) =>
    Schema.decodeEffect(Schema.toCodecJson(schema))(input)

const run = <A>(effect: Effect.Effect<A, Schema.SchemaError>) => Effect.runPromise(effect)

describe("environment variables", () => {
  it("carries name, users, time and author and has no value field", () =>
    run(
      Effect.gen(function* () {
        const variable = yield* decode(EnvVariable)({
          name: "STRIPE_SECRET_KEY",
          usedBy: ["Charge job", "Refund job"],
          updatedAt: "2026-10-02T11:40:00.000Z",
          updatedBy: { kind: "user", id: "u_1", name: "Maya Chen" },
        })
        const mapped = toVariable(variable)
        expect(mapped).toEqual({
          name: "STRIPE_SECRET_KEY",
          usedBy: ["Charge job", "Refund job"],
          updatedAt: Date.UTC(2026, 9, 2, 11, 40),
          updatedBy: "Maya Chen",
        })
        expect(Object.keys(mapped).toSorted()).toEqual(["name", "updatedAt", "updatedBy", "usedBy"])
      }),
    ))

  it("names a nameless key actor but leaves a nameless person unnamed", () =>
    run(
      Effect.gen(function* () {
        const base = { name: "A", usedBy: [], updatedAt: "2026-10-02T11:40:00.000Z" }
        const key = yield* decode(EnvVariable)({
          ...base,
          updatedBy: { kind: "api-key", id: "k_1", name: null },
        })
        const person = yield* decode(EnvVariable)({
          ...base,
          updatedBy: { kind: "user", id: "u_1", name: null },
        })
        const nobody = yield* decode(EnvVariable)({ ...base, updatedBy: null })
        expect([key, person, nobody].map((entry) => toVariable(entry).updatedBy)).toEqual([
          "API key",
          null,
          null,
        ])
      }),
    ))
})

describe("api keys", () => {
  it("drops revoked keys and shows only the prefix and last four", () =>
    run(
      Effect.gen(function* () {
        const key = (id: string, revokedAt: string | null) => ({
          id,
          organizationId: "org_1",
          name: id,
          prefix: "ak_live",
          lastFour: "3f9a",
          permission: "write" as const,
          projectId: id === "key_org" ? null : "prj_1",
          createdAt: "2026-09-01T00:00:00.000Z",
          createdBy: { kind: "user" as const, id: "u_1", name: "Dallen" },
          lastUsedAt: id === "key_org" ? null : "2026-10-03T09:41:00.000Z",
          expiresAt: null,
          revokedAt,
        })
        const keys = yield* Effect.forEach(
          [
            key("key_org", null),
            key("key_project", null),
            key("key_gone", "2026-10-01T00:00:00.000Z"),
          ],
          (entry) => decode(ApiKey)(entry),
        )
        expect(toKeys(keys)).toEqual([
          {
            id: "key_org",
            name: "key_org",
            tail: "ak_live…3f9a",
            permission: "write",
            projectScoped: false,
            lastUsedAt: null,
            expiresAt: null,
          },
          {
            id: "key_project",
            name: "key_project",
            tail: "ak_live…3f9a",
            permission: "write",
            projectScoped: true,
            lastUsedAt: Date.UTC(2026, 9, 3, 9, 41),
            expiresAt: null,
          },
        ])
      }),
    ))
})

describe("project", () => {
  it("joins endpoint paths onto the base URL whichever way the slashes fall", () =>
    run(
      Effect.gen(function* () {
        const endpoints = yield* decode(ProjectEndpoints)({
          httpBaseUrl: "https://storefront.akter.cloud/",
          webSocketUrl: "wss://storefront.akter.cloud/ws",
          openApiPath: "/openapi.json",
          mcpPath: "mcp",
        })
        expect(toEndpoints(endpoints)).toEqual([
          { label: "HTTP", value: "https://storefront.akter.cloud/" },
          { label: "WebSocket", value: "wss://storefront.akter.cloud/ws" },
          { label: "OpenAPI", value: "https://storefront.akter.cloud/openapi.json" },
          { label: "MCP", value: "https://storefront.akter.cloud/mcp" },
        ])
      }),
    ))

  it("lists every integration, disconnected when the project has none of that kind", () =>
    run(
      Effect.gen(function* () {
        const listed = yield* Effect.forEach(
          [
            { kind: "github", status: "connected", label: "acme/storefront", connectedAt: null },
            { kind: "pagerduty", status: "error", label: null, connectedAt: null },
          ] as const,
          (entry) => decode(Integration)(entry),
        )
        const mapped = toIntegrations(listed)
        expect(mapped.map((entry) => [entry.kind, entry.status])).toEqual([
          ["github", "connected"],
          ["slack", "disconnected"],
          ["datadog", "disconnected"],
          ["opentelemetry", "disconnected"],
          ["pagerduty", "error"],
        ])
        expect(mapped[0]?.detail).toBe("acme/storefront")
        expect(mapped[4]?.detail).toBe("Page on-call when a deploy rolls back")
      }),
    ))

  it("marks the environment's home and replicas and offers the rest of the catalog", () =>
    run(
      Effect.gen(function* () {
        const catalog = yield* Effect.forEach(
          [
            { id: "us-east-1", city: "Virginia" },
            { id: "us-west-2", city: "Oregon" },
          ] as const,
          (entry) => decode(Region)(entry),
        )
        const flat = (entry: ProjectRegion) => ({ ...entry.region, home: entry.home })
        const running = (home: boolean) =>
          decode(ProjectRegion)({
            region: { id: "us-west-2", city: "Oregon" },
            home,
            tenantCount: 0,
            database: { engine: "postgres", version: "17", sizeBytes: 0 },
            storage: { usedBytes: 0, limitBytes: 0 },
            cpuPercent: 0,
            connections: { used: 0, limit: 0 },
            runners: 0,
            shardGroup: "g1",
            backups: { pointInTimeRecovery: false, latestBackupAt: null },
            largestTables: [],
          })
        expect(toRegionChoices({ catalog, running: [flat(yield* running(true))] })).toEqual([
          { id: "us-west-2", city: "Oregon", role: "Home" },
          { id: "us-east-1", city: "Virginia", role: "Available" },
        ])
        expect(toRegionChoices({ catalog, running: [flat(yield* running(false))] })[0]?.role).toBe(
          "Replica",
        )
      }),
    ))

  it("keeps the environment the context chose, not one invented from the project", () =>
    run(
      Effect.gen(function* () {
        const project = yield* decode(Project)({
          id: "prj_1",
          organizationId: "org_1",
          name: "Storefront",
          slug: "storefront",
          status: "live",
          homeRegion: "us-east-1",
          createdAt: "2026-09-01T00:00:00.000Z",
        })
        expect(toProjectSummary({ project, environment: "staging" })).toEqual({
          id: "prj_1",
          name: "Storefront",
          slug: "storefront",
          homeRegion: "us-east-1",
          environment: "staging",
        })
      }),
    ))
})

describe("invitations", () => {
  it("keeps only invitations still waiting for an answer", () =>
    run(
      Effect.gen(function* () {
        const invitation = (id: string, status: string) => ({
          id,
          organizationId: "org_1",
          email: `${id}@acme.dev`,
          role: "member",
          status,
          invitedBy: { id: "u_1", name: "Dallen" },
          createdAt: "2026-09-30T16:05:00.000Z",
          expiresAt: "2026-10-07T16:05:00.000Z",
        })
        const listed = yield* Effect.forEach(
          ["pending", "accepted", "declined", "canceled", "expired"],
          (status) => decode(Invitation)(invitation(`inv_${status}`, status)),
        )
        expect(toPendingInvitations(listed).map((entry) => entry.id)).toEqual(["inv_pending"])
      }),
    ))
})

describe("billing", () => {
  it("keeps cents whole and leaves a missing card, email and renewal null", () =>
    run(
      Effect.gen(function* () {
        const summary = yield* decode(BillingSummary)({
          plan: {
            id: "free",
            name: "Free",
            basePriceCents: 0,
            currency: "usd",
            renewsAt: null,
            monthToDateEstimateCents: 1999,
          },
          paymentMethod: null,
          billingEmail: null,
          spendLimit: { limitCents: null, currentSpendCents: 1999 },
        })
        expect(toBilling(summary)).toEqual({
          plan: {
            id: "free",
            name: "Free",
            basePriceCents: 0,
            renewsAt: null,
            monthToDateCents: 1999,
          },
          card: null,
          billingEmail: null,
          spendLimit: { limitCents: null, currentCents: 1999 },
        })
        expect(dollars(1999)).toBe(19.99)
      }),
    ))

  it("orders invoices newest first by the period they cover", () =>
    run(
      Effect.gen(function* () {
        const invoice = (number: string, start: string) => ({
          id: number,
          number,
          periodStart: start,
          periodEnd: "2026-12-31T00:00:00.000Z",
          amountCents: 100,
          currency: "usd" as const,
          status: "paid" as const,
          pdfUrl: null,
        })
        const listed = yield* Effect.forEach(
          [
            invoice("INV-7", "2026-07-01T00:00:00.000Z"),
            invoice("INV-9", "2026-09-01T00:00:00.000Z"),
            invoice("INV-8", "2026-08-01T00:00:00.000Z"),
          ],
          (entry) => decode(Invoice)(entry),
        )
        expect(toInvoices(listed).map((entry) => entry.number)).toEqual(["INV-9", "INV-8", "INV-7"])
      }),
    ))
})

describe("usage", () => {
  it("labels each meter with its own unit and keeps a zero allowance zero", () =>
    run(
      Effect.gen(function* () {
        const meter = (name: string, used: number, included: number) => ({
          meter: name,
          used,
          included,
          overage: 0,
          overageCostCents: 0,
        })
        const usage = yield* decode(Usage)({
          period: "2026-09",
          meters: [
            meter("commands", 41_200_000, 100_000_000),
            meter("reads", 5, 10),
            meter("runnerHours", 1488, 2000),
            meter("storageGb", 276, 100),
            meter("egressGb", 88, 0),
          ],
          commandsPerDay: [{ day: "2026-09-01", commands: 7 }],
          byProject: [
            { projectId: "prj_1", name: "storefront", commands: 7, estimatedCostCents: 40 },
          ],
          pricing: { freeCommands: 0, readCommandWeight: 0.1, storagePerGbCents: 15 },
        })
        const mapped = toUsage(usage)
        expect(mapped.meters.map((entry) => [entry.label, entry.unit, entry.included])).toEqual([
          ["Commands", "count", 100_000_000],
          ["Reads", "count", 10],
          ["Runner hours", "hours", 2000],
          ["Storage", "gigabytes", 100],
          ["Egress", "gigabytes", 0],
        ])
        expect(mapped.projects).toEqual([
          { id: "prj_1", name: "storefront", commands: 7, estimatedCostCents: 40 },
        ])
      }),
    ))
})

describe("audit log", () => {
  it("shows the most specific name for who and what", () =>
    run(
      Effect.gen(function* () {
        const entry = (
          actor: { kind: "user" | "api-key"; id: string; name: string | null },
          target: { type: string; id: string | null; name: string | null },
        ) =>
          decode(AuditEntry)({
            id: "e1",
            at: "2026-10-02T14:02:00.000Z",
            actor,
            action: "deploy.created",
            target,
            ipAddress: null,
          })
        const named = toAuditEntry(
          yield* entry(
            { kind: "user", id: "u_1", name: "Dallen" },
            { type: "deployment", id: "dep_1", name: "storefront@a3f9c21" },
          ),
        )
        expect(named).toEqual({
          id: "e1",
          at: Date.UTC(2026, 9, 2, 14, 2),
          person: "Dallen",
          action: "deploy.created",
          target: "storefront@a3f9c21",
        })
        const bare = toAuditEntry(
          yield* entry(
            { kind: "user", id: "u_2", name: null },
            { type: "deployment", id: "dep_2", name: null },
          ),
        )
        expect([bare.person, bare.target]).toEqual(["u_2", "dep_2"])
        const typed = toAuditEntry(
          yield* entry(
            { kind: "api-key", id: "k_1", name: null },
            { type: "organization", id: null, name: null },
          ),
        )
        expect([typed.person, typed.target]).toEqual(["API key", "organization"])
      }),
    ))
})

describe("formatting", () => {
  it("writes UTC instants, months and days the same everywhere", () => {
    expect(formatInstant(Date.UTC(2026, 9, 2, 14, 2))).toBe("Oct 2, 14:02")
    expect(formatInstant(Date.UTC(2026, 0, 5, 9, 7))).toBe("Jan 5, 09:07")
    expect(formatMonth(Date.UTC(2026, 11, 31, 23, 59))).toBe("December 2026")
    expect(formatMonth(Date.UTC(2027, 0, 1, 0, 0))).toBe("January 2027")
    expect(formatPeriod("2026-09")).toBe("September 2026")
    expect(formatPeriod("2026-13")).toBe("2026-13")
    expect(formatDay("2026-09-03")).toBe("Sep 3")
    expect(formatDay("Sep 3")).toBe("Sep 3")
    expect(formatExpiry({ month: 8, year: 2028 })).toBe("08 / 28")
  })
})

describe("setting keys", () => {
  it("round-trips the keys that carry an event, a member and a spend limit", () => {
    expect(
      parseNotificationKey(notificationKey({ channel: "slack", event: "dead_letter" })),
    ).toEqual({
      channel: "slack",
      event: "dead_letter",
    })
    expect(parseNotificationKey("notify.sms.dead_letter")).toBeUndefined()
    expect(parseNotificationKey("openInNewTab")).toBeUndefined()
    expect(parseMemberRoleKey(memberRoleKey("mem_9"))).toBe("mem_9")
    expect(parseMemberRoleKey("inviteRole")).toBeUndefined()
    expect(parseSpendLimit(spendLimitValue(null))).toBeNull()
    expect(parseSpendLimit(spendLimitValue(0))).toBe(0)
    expect(parseSpendLimit(spendLimitValue(50_000))).toBe(50_000)
    expect(parseSpendLimit("12.5")).toBeUndefined()
    expect(parseSpendLimit("-1")).toBeUndefined()
  })

  it("seeds switches and selects from what the control plane reports, not from unset", () => {
    const seed = settingsSeed({
      ...emptySettings,
      preferences: {
        defaultEnvironment: "staging",
        openActorLinksInNewTab: true,
        timeZone: "Europe/Dublin",
        pauseLiveTailOnScroll: false,
        showReplayedCommands: true,
        theme: "dark",
      },
      notifications: [{ event: "dead_letter", email: true, slack: false }],
      billing: {
        plan: { id: "pro", name: "Pro", basePriceCents: 2000, renewsAt: null, monthToDateCents: 0 },
        card: null,
        billingEmail: null,
        spendLimit: { limitCents: null, currentCents: 0 },
      },
      members: [{ id: "mem_1", name: "Maya", email: "maya@acme.dev", role: "admin" }],
    })
    expect(seed.toggles).toEqual({
      openInNewTab: true,
      pauseOnScroll: false,
      showReplayed: true,
      "notify.email.dead_letter": true,
      "notify.slack.dead_letter": false,
    })
    expect(seed.choices).toEqual({
      defaultEnvironment: "staging",
      timeZone: "Europe/Dublin",
      spendLimit: "none",
      "role-mem_1": "admin",
    })
  })
})
