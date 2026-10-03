import {
  defaultPricingConfig,
  type PricingConfig,
  PricingLive,
  StripeBillingLocal,
  stripeTiers,
} from "@akter/billing"
import { BunCrypto } from "@effect/platform-bun"
import { ActorTest } from "@rikalabs/akter/testing"
import { DateTime, Effect, Layer, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "vitest"
import { createDatabase } from "./fixtures.ts"
import { type MeterEvent, UsageActor, UsageActorLive, usageKey } from "./metering-actor.ts"
import { RepositoryLive } from "./repository.ts"
import { hoursInMonth, usageReport } from "./usage.ts"

/** Small allowances expose accidentally applying an organization's allowance separately to each project. */
const pricing: PricingConfig = {
  ...defaultPricingConfig,
  tiers: defaultPricingConfig.tiers.map((tier) =>
    tier.id === "pro"
      ? {
          ...tier,
          includedCommands: 10,
          commandOverageCentsPerMillion: 1_000_000,
          includedStorageGb: 1,
          storageCentsPerGbMonth: 30,
        }
      : tier,
  ),
}

const live = (url: Redacted.Redacted<string>) =>
  Layer.merge(UsageActorLive(), RepositoryLive).pipe(
    Layer.provide(
      StripeBillingLocal({
        tiers: stripeTiers(pricing),
        webhookSecret: Redacted.make("usage-local-test-secret"),
      }),
    ),
    Layer.provideMerge(PricingLive(pricing)),
    Layer.provideMerge(ActorTest.layer({ database: url })),
    Layer.provideMerge(BunCrypto.layer),
  )

type Services = Layer.Success<ReturnType<typeof live>>

const run = <A, E>(body: Effect.Effect<A, E, Services>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const cryptoContext = yield* Layer.build(BunCrypto.layer)
        const url = yield* createDatabase("usage_report").pipe(Effect.provideContext(cryptoContext))
        const context = yield* Layer.build(live(url))

        return yield* body.pipe(Effect.provideContext(context))
      }),
    ),
  )

const project = Effect.fnUntraced(function* (organization: string, id: string, name: string) {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO cloud_project (id, organization_id, name, slug, home_region)
    VALUES (${id}, ${organization}, ${name}, ${id}, 'us-east-1')`
  yield* sql`INSERT INTO cloud_meter_tenant (deployment_id, tenant, organization_id, project_id)
    VALUES ('usage-cell', ${id}, ${organization}, ${id})`
})

const importHour = Effect.fnUntraced(function* (
  tenant: string,
  iso: string,
  commands: number,
  reads: number,
  byteHours: number,
) {
  const hour = DateTime.toEpochMillis(DateTime.makeUnsafe(iso))
  const events: Array<typeof MeterEvent.Type> = []
  for (let index = 0; index < commands + reads; index += 1) {
    events.push({
      eventId: `${hour}-${index}`,
      kind: index < commands ? "command" : "read",
      actorType: "Counter",
      actorId: tenant,
      commandId: index < commands ? `${hour}-command-${index}` : null,
      requestToken: index >= commands ? `${hour}-read-${index}` : null,
      hour,
    })
  }
  events.push({ eventId: `${hour}-storage`, kind: "storage", hour, storageByteHours: byteHours })
  const actor = yield* UsageActor.get(yield* usageKey("usage-cell", tenant))

  return yield* actor.Import({ events })
})

describe("usageReport from actor-imported real Postgres usage", () => {
  it("applies shared allowances once, keeps reads weighted by fifths, and attributes only variable costs to projects", () =>
    run(
      Effect.gen(function* () {
        yield* project("org-shared", "project-a", "Alpha")
        yield* project("org-shared", "project-b", "Beta")
        yield* project("org-other", "project-c", "Other organization")
        yield* importHour("project-a", "2024-02-01T00:00:00Z", 6, 5, 2_000_000_000 * 696)
        yield* importHour("project-b", "2024-02-29T23:00:00Z", 7, 10, 500_000_000 * 696)
        yield* importHour("project-c", "2024-02-15T10:00:00Z", 50, 50, 99_000_000_000 * 696)
        yield* importHour("project-a", "2024-01-31T23:00:00Z", 40, 30, 30_000_000_000)
        yield* importHour("project-b", "2024-03-01T00:00:00Z", 60, 70, 40_000_000_000)

        const report = yield* usageReport("org-shared", "pro", "2024-02")
        const sql = yield* SqlClient.SqlClient
        const shiftedSession = yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SET LOCAL TIME ZONE 'America/New_York'`
            return yield* usageReport("org-shared", "pro", "2024-02")
          }),
        )
        expect(shiftedSession).toEqual(report)
        expect(report.meters).toEqual([
          { meter: "commands", used: 16, included: 10, overage: 6, overageCostCents: 6 },
          { meter: "reads", used: 15, included: 0, overage: 15, overageCostCents: 0 },
          { meter: "storageGb", used: 2.5, included: 1, overage: 1.5, overageCostCents: 45 },
        ])
        expect(report.commandsPerDay).toEqual([
          { day: "2024-02-01", commands: 6 },
          { day: "2024-02-29", commands: 7 },
        ])
        expect(report.byProject).toEqual([
          {
            projectId: "project-a",
            name: "Alpha",
            commands: 6,
            reads: 5,
            storageGbMonths: 2,
            estimatedCostCents: 38,
          },
          {
            projectId: "project-b",
            name: "Beta",
            commands: 7,
            reads: 10,
            storageGbMonths: 0.5,
            estimatedCostCents: 13,
          },
        ])
        expect(report.byProject.reduce((sum, entry) => sum + entry.estimatedCostCents, 0)).toBe(51)
        expect(report.pricing).toEqual({
          freeCommands: 1_000_000,
          readCommandWeight: 0.2,
          storagePerGbCents: 30,
          provisional: true,
        })
        expect((yield* usageReport("org-other", "pro", "2024-02")).byProject).toHaveLength(1)
        expect((yield* usageReport("org-never", "pro", "2024-02")).byProject).toEqual([])
      }),
    ))

  it("uses the actual hours of regular and leap February and preserves both sides of a one-command read boundary", () =>
    run(
      Effect.gen(function* () {
        yield* project("org-calendar", "project-calendar", "Calendar")
        yield* importHour("project-calendar", "2023-02-01T00:00:00Z", 9, 4, 1_000_000_000 * 672)
        yield* importHour("project-calendar", "2024-02-01T00:00:00Z", 9, 5, 1_000_000_000 * 696)
        expect(hoursInMonth("2023-02")).toBe(28 * 24)
        expect(hoursInMonth("2024-02")).toBe(29 * 24)

        const regular = yield* usageReport("org-calendar", "pro", "2023-02")
        const leap = yield* usageReport("org-calendar", "pro", "2024-02")
        expect(regular.meters).toEqual([
          { meter: "commands", used: 9.8, included: 10, overage: 0, overageCostCents: 0 },
          { meter: "reads", used: 4, included: 5, overage: 0, overageCostCents: 0 },
          { meter: "storageGb", used: 1, included: 1, overage: 0, overageCostCents: 0 },
        ])
        expect(leap.meters).toEqual([
          { meter: "commands", used: 10, included: 10, overage: 0, overageCostCents: 0 },
          { meter: "reads", used: 5, included: 5, overage: 0, overageCostCents: 0 },
          { meter: "storageGb", used: 1, included: 1, overage: 0, overageCostCents: 0 },
        ])
        yield* importHour("project-calendar", "2024-02-02T00:00:00Z", 0, 1, 0)
        const over = yield* usageReport("org-calendar", "pro", "2024-02")
        expect(over.meters[0]?.used).toBe(10.2)
        expect(over.meters[0]?.overage).toBeCloseTo(0.2)
        expect(over.meters[0]?.overageCostCents).toBe(1)
        expect(over.byProject[0]?.estimatedCostCents).toBe(1)
      }),
    ))

  it("keeps a DST-crossing UTC month and its last day unchanged in a New York SQL session", () =>
    run(
      Effect.gen(function* () {
        yield* project("org-timezone", "project-timezone", "UTC calendar")
        yield* importHour("project-timezone", "2024-03-01T00:00:00Z", 9, 5, 0)
        yield* importHour("project-timezone", "2024-03-31T23:00:00Z", 4, 3, 0)
        yield* importHour("project-timezone", "2024-04-01T00:00:00Z", 20, 25, 0)
        const sql = yield* SqlClient.SqlClient
        const report = yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SET LOCAL TIME ZONE 'America/New_York'`
            return yield* usageReport("org-timezone", "pro", "2024-03")
          }),
        )
        expect(report.commandsPerDay).toEqual([
          { day: "2024-03-01", commands: 9 },
          { day: "2024-03-31", commands: 4 },
        ])
        expect(report.byProject).toEqual([
          {
            projectId: "project-timezone",
            name: "UTC calendar",
            commands: 13,
            reads: 8,
            storageGbMonths: 0,
            estimatedCostCents: 5,
          },
        ])
        expect(report.meters[0]?.used).toBe(14.6)
        expect(report).toEqual(yield* usageReport("org-timezone", "pro", "2024-03"))
      }),
    ))
})
