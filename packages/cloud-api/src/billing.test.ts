import { Effect, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"

import {
  CardPaymentMethod,
  CatalogPlan,
  ComputeUsage,
  LinkPaymentMethod,
  PaymentMethod,
  PlanCatalog,
  Usage,
} from "./billing.ts"

const valid = Schema.is(PaymentMethod)

const visa = CardPaymentMethod.make({
  brand: "visa",
  lastFour: "4242",
  expiryMonth: 7,
  expiryYear: 2031,
})

describe("payment method", () => {
  it("is a card, named by brand, last four digits and expiry, or a Link account, named by its email", () => {
    expect(valid(visa)).toBe(true)
    expect(valid(LinkPaymentMethod.make({ email: "ada@example.com" }))).toBe(true)
  })

  it("accepts a Link account with no email, since Stripe reports none for some", () => {
    expect(valid(LinkPaymentMethod.make({ email: null }))).toBe(true)
  })

  it("rejects a method without its tag, a Link account with no email field, and a card whose expiry month is not a month", () => {
    expect(valid({ brand: "visa", lastFour: "4242", expiryMonth: 7, expiryYear: 2031 })).toBe(false)
    expect(valid({ ...LinkPaymentMethod.make({ email: null }), email: undefined })).toBe(false)
    expect(valid({ ...visa, expiryMonth: 13 })).toBe(false)
  })
})

const wire =
  <T, E>(schema: Schema.Codec<T, E>) =>
  (input: Schema.Json) =>
    Exit.isSuccess(
      Effect.runSyncExit(
        Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(schema)))(
          JSON.stringify(input),
        ),
      ),
    )

const proPlan = {
  id: "pro",
  name: "Pro",
  basePriceCents: 2500,
  currency: "usd",
  allowances: {
    computeUnitHours: 1500,
    computeUnitHourCap: null,
    concurrentConnections: 5000,
  },
  overage: { computeCentsPerUnitHour: 1.5 },
  features: ["compute-overage", "byo-database", "checkout"],
  provisional: false,
}

const freePlan = {
  id: "free",
  name: "Free",
  basePriceCents: 0,
  currency: "usd",
  allowances: {
    computeUnitHours: 750,
    computeUnitHourCap: 750,
    concurrentConnections: 100,
  },
  overage: { computeCentsPerUnitHour: 0 },
  features: ["compute-cap", "byo-database"],
  provisional: false,
}

const teamPlan = {
  ...proPlan,
  id: "team",
  name: "Team",
  basePriceCents: 24_900,
  allowances: { ...proPlan.allowances, computeUnitHours: 16_000 },
}

const computeSizes: Schema.JsonArray = [
  { cpuKind: "shared", cpus: 1, memoryMb: 512, unitsPerHour: 1 },
  { cpuKind: "performance", cpus: 2, memoryMb: 4096, unitsPerHour: 18 },
]

const catalog = (plans: ReadonlyArray<Schema.Json>, extra: Record<string, Schema.Json> = {}) => ({
  plans,
  computeSizes,
  provisional: false,
  ...extra,
})

const strictPlan = Schema.decodeUnknownExit(CatalogPlan, { onExcessProperty: "error" })

describe("plan catalog", () => {
  const validCatalog = wire(PlanCatalog)
  const validPlan = wire(CatalogPlan)

  it("decodes customer Postgres on Free, Pro and Team with only compute allowances and overage", () => {
    expect(validCatalog(catalog([freePlan, proPlan, teamPlan]))).toBe(true)
  })

  it("decodes per-size compute unit weights taken from the pricing configuration", () => {
    expect(validCatalog(catalog([proPlan], { computeSizes: [] }))).toBe(true)
  })

  it("refuses a size whose weight is not positive or whose machine has no whole CPU or memory", () => {
    const size = { cpuKind: "shared", cpus: 1, memoryMb: 512, unitsPerHour: 1.5 }
    const withSize = (patch: Record<string, Schema.Json>) =>
      catalog([proPlan], { computeSizes: [{ ...size, ...patch }] })
    expect(validCatalog(withSize({}))).toBe(true)
    expect(validCatalog(withSize({ unitsPerHour: 0 }))).toBe(false)
    expect(validCatalog(withSize({ unitsPerHour: -1.5 }))).toBe(false)
    expect(validCatalog(withSize({ cpus: 0 }))).toBe(false)
    expect(validCatalog(withSize({ cpus: 0.5 }))).toBe(false)
    expect(validCatalog(withSize({ memoryMb: 0 }))).toBe(false)
    expect(validCatalog(withSize({ memoryMb: 512.5 }))).toBe(false)
    expect(validCatalog(withSize({ cpuKind: "dedicated" }))).toBe(false)
  })

  it("requires the compute sizes, every allowance and the compute overage rate", () => {
    const { computeSizes: _sizes, ...withoutSizes } = catalog([proPlan])
    expect(validCatalog(withoutSizes)).toBe(false)
    for (const field of [
      "computeUnitHours",
      "computeUnitHourCap",
      "concurrentConnections",
    ] as const) {
      const { [field]: _omitted, ...allowances } = proPlan.allowances
      expect(validPlan({ ...proPlan, allowances })).toBe(false)
    }
    expect(validPlan({ ...proPlan, overage: {} })).toBe(false)
  })

  it("refuses removed command and storage billing fields and managed database features", () => {
    for (const feature of [
      "command-cap",
      "command-overage",
      "database-cap",
      "storage-cap",
      "storage-overage",
      "dedicated-database",
    ]) {
      expect(validPlan({ ...proPlan, features: [feature] })).toBe(false)
    }
    for (const field of ["commands", "commandCap", "storageGb", "storageGbCap"])
      expect(
        Exit.isFailure(
          strictPlan({ ...proPlan, allowances: { ...proPlan.allowances, [field]: 1 } }),
        ),
      ).toBe(true)
    for (const field of ["commandCentsPerMillion", "storageCentsPerGbMonth"])
      expect(
        Exit.isFailure(strictPlan({ ...proPlan, overage: { ...proPlan.overage, [field]: 50 } })),
      ).toBe(true)
    expect(Exit.isSuccess(strictPlan(proPlan))).toBe(true)
  })

  it("refuses negative compute allowances, caps and rates, and an unknown feature", () => {
    const allowances = (patch: Record<string, Schema.Json>) => ({
      ...proPlan,
      allowances: { ...proPlan.allowances, ...patch },
    })
    const overage = (patch: Record<string, Schema.Json>) => ({
      ...proPlan,
      overage: { ...proPlan.overage, ...patch },
    })
    expect(validPlan(allowances({ computeUnitHours: -1 }))).toBe(false)
    expect(validPlan(allowances({ computeUnitHourCap: -0.5 }))).toBe(false)
    expect(validPlan(overage({ computeCentsPerUnitHour: -0.3 }))).toBe(false)
    expect(validPlan({ ...proPlan, features: ["compute-limit"] })).toBe(false)
  })
})

const sharedRecord = {
  environmentId: "env_production",
  cpuKind: "shared",
  cpus: 1,
  memoryMb: 1024,
  machineHours: 10,
  computeUnitHours: 13.7,
}

const performanceRecord = {
  environmentId: "env_staging",
  cpuKind: "performance",
  cpus: 2,
  memoryMb: 4096,
  machineHours: 1.5,
  computeUnitHours: 0.9,
}

describe("compute usage dimensions", () => {
  const validRecord = wire(ComputeUsage)

  it("accepts any non-negative unit-hours, since machine size weights come from the pricing configuration", () => {
    expect(validRecord(sharedRecord)).toBe(true)
    expect(validRecord(performanceRecord)).toBe(true)
    expect(validRecord({ ...sharedRecord, machineHours: 0, computeUnitHours: 0 })).toBe(true)
    expect(validRecord({ ...sharedRecord, machineHours: 0, computeUnitHours: 2 })).toBe(true)
  })

  it("refuses negative hours, a machine with no whole CPU or memory, an unknown CPU kind and an empty environment", () => {
    expect(validRecord({ ...sharedRecord, machineHours: -10 })).toBe(false)
    expect(validRecord({ ...sharedRecord, computeUnitHours: -13.7 })).toBe(false)
    expect(validRecord({ ...sharedRecord, cpus: 0 })).toBe(false)
    expect(validRecord({ ...sharedRecord, cpus: -1 })).toBe(false)
    expect(validRecord({ ...sharedRecord, cpus: 1.5 })).toBe(false)
    expect(validRecord({ ...sharedRecord, memoryMb: 0 })).toBe(false)
    expect(validRecord({ ...sharedRecord, memoryMb: 1024.5 })).toBe(false)
    expect(validRecord({ ...sharedRecord, cpuKind: "dedicated" })).toBe(false)
    expect(validRecord({ ...sharedRecord, environmentId: "" })).toBe(false)
  })
})

const usageCaps: Schema.JsonArray = [
  { cap: "compute", limit: 750, used: 64, atCap: false, refusing: false },
  { cap: "connections", limit: 100, used: 100, atCap: true, refusing: true },
]

const meteredProject = {
  projectId: "prj_1",
  name: "Storefront",
  computeUnitHours: 64,
  compute: [sharedRecord, performanceRecord],
  estimatedCostCents: 0,
}

const unmeteredProject = {
  projectId: "prj_2",
  name: "Bring your own",
  computeUnitHours: 0,
  compute: [],
  estimatedCostCents: 0,
}

const usage = {
  period: "2026-10",
  meters: [{ meter: "runnerHours", used: 64, included: 750, overage: 0, overageCostCents: 0 }],
  caps: usageCaps,
  byProject: [meteredProject, unmeteredProject],
  pricing: { computeCentsPerUnitHour: 0 },
}

describe("usage report", () => {
  const validUsage = wire(Usage)

  it("decodes compute and connection caps, per-project compute and per-machine-size records without storage", () => {
    expect(validUsage(usage)).toBe(true)
    expect(
      Exit.isSuccess(Schema.decodeUnknownExit(Usage, { onExcessProperty: "error" })(usage)),
    ).toBe(true)
  })

  it("decodes a Pro report billing overage only on compute unit-hours", () => {
    const billed = {
      ...usage,
      meters: [
        { meter: "runnerHours", used: 1600, included: 1500, overage: 100, overageCostCents: 150 },
      ],
      caps: [],
      pricing: { computeCentsPerUnitHour: 1.5 },
    }
    expect(validUsage(billed)).toBe(true)
  })

  it("refuses removed command, storage and outbound-traffic meters, caps and storage fields", () => {
    const meter = { used: 120, included: 1000, overage: 0, overageCostCents: 0 }
    for (const name of ["commands", "reads", "egressGb", "storageGb"]) {
      expect(validUsage({ ...usage, meters: [{ meter: name, ...meter }] })).toBe(false)
    }
    for (const cap of ["commands", "storage"])
      expect(
        validUsage({
          ...usage,
          caps: [{ cap, limit: 1000, used: 1, atCap: false, refusing: false }],
        }),
      ).toBe(false)
    const strict = Schema.decodeUnknownExit(Usage, { onExcessProperty: "error" })
    for (const extra of [
      { latestStorageSample: null },
      { byProject: [{ ...meteredProject, storageGbMonths: 0.12 }] },
      { pricing: { ...usage.pricing, storageCentsPerGbMonth: 50 } },
    ])
      expect(Exit.isFailure(strict({ ...usage, ...extra }))).toBe(true)
  })

  it("requires the caps, each project's compute and the compute price", () => {
    const { caps: _caps, ...noCaps } = usage
    expect(validUsage(noCaps)).toBe(false)
    for (const field of ["computeUnitHours", "compute"] as const) {
      const { [field]: _omitted, ...project } = meteredProject
      expect(validUsage({ ...usage, byProject: [project] })).toBe(false)
    }
    expect(validUsage({ ...usage, pricing: {} })).toBe(false)
  })

  it("refuses a negative rate, negative project compute and a negative cap", () => {
    const withProject = (patch: Record<string, Schema.Json>) => ({
      ...usage,
      byProject: [{ ...meteredProject, ...patch }],
    })
    expect(
      validUsage({ ...usage, pricing: { ...usage.pricing, computeCentsPerUnitHour: -1 } }),
    ).toBe(false)
    expect(validUsage(withProject({ computeUnitHours: -64 }))).toBe(false)
    expect(validUsage(withProject({ compute: [{ ...sharedRecord, computeUnitHours: -10 }] }))).toBe(
      false,
    )
    expect(
      validUsage({
        ...usage,
        caps: [{ cap: "compute", limit: -1, used: 0, atCap: false, refusing: false }],
      }),
    ).toBe(false)
  })
})
