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

const computePlan = {
  id: "pro",
  name: "Pro",
  basePriceCents: 2900,
  currency: "usd",
  allowances: {
    commands: 5_000_000,
    commandCap: null,
    computeUnitHours: 1460,
    computeUnitHourCap: null,
    concurrentConnections: 1000,
  },
  overage: { commandCentsPerMillion: 40, computeCentsPerUnitHour: 0.3 },
  features: ["command-overage", "compute-overage", "checkout"],
  provisional: true,
}

const storagePlan = {
  id: "free",
  name: "Free",
  basePriceCents: 0,
  currency: "usd",
  allowances: {
    commands: 1_000_000,
    commandCap: 1_000_000,
    storageGb: 1,
    concurrentConnections: 50,
  },
  overage: { commandCentsPerMillion: 0, storageCentsPerGbMonth: 25 },
  features: ["command-cap", "storage-overage", "storage-cap"],
  provisional: false,
}

const catalog = (plans: ReadonlyArray<Schema.Json>) => ({
  plans,
  readCommandWeight: 0.1,
  provisional: true,
})

const computeSizes: Schema.JsonArray = [
  { cpuKind: "shared", cpus: 1, memoryMb: 512, unitsPerHour: 1.5 },
  { cpuKind: "performance", cpus: 2, memoryMb: 4096, unitsPerHour: 7 },
]

describe("plan catalog", () => {
  const validCatalog = wire(PlanCatalog)
  const validPlan = wire(CatalogPlan)

  it("decodes compute allowances, a nullable compute cap and a compute overage rate with no storage fields", () => {
    const capped = {
      ...computePlan,
      allowances: { ...computePlan.allowances, computeUnitHourCap: 730 },
      features: ["command-cap", "compute-cap"],
    }
    expect(validCatalog({ ...catalog([computePlan, capped]), computeSizes })).toBe(true)
  })

  it("decodes per-size compute unit weights taken from the pricing configuration", () => {
    expect(validCatalog({ ...catalog([computePlan]), computeSizes })).toBe(true)
    expect(validCatalog({ ...catalog([computePlan]), computeSizes: [] })).toBe(true)
  })

  it("refuses a size whose weight is not positive or whose machine has no whole CPU or memory", () => {
    const size = { cpuKind: "shared", cpus: 1, memoryMb: 512, unitsPerHour: 1.5 }
    const withSize = (patch: Record<string, Schema.Json>) => ({
      ...catalog([computePlan]),
      computeSizes: [{ ...size, ...patch }],
    })
    expect(validCatalog(withSize({}))).toBe(true)
    expect(validCatalog(withSize({ unitsPerHour: 0 }))).toBe(false)
    expect(validCatalog(withSize({ unitsPerHour: -1.5 }))).toBe(false)
    expect(validCatalog(withSize({ cpus: 0 }))).toBe(false)
    expect(validCatalog(withSize({ cpus: 0.5 }))).toBe(false)
    expect(validCatalog(withSize({ memoryMb: 0 }))).toBe(false)
    expect(validCatalog(withSize({ memoryMb: 512.5 }))).toBe(false)
    expect(validCatalog(withSize({ cpuKind: "dedicated" }))).toBe(false)
  })

  it("still decodes a storage-era plan that carries no compute fields", () => {
    expect(validCatalog(catalog([storagePlan]))).toBe(true)
  })

  it("refuses negative compute allowances, caps and rates, and an unknown feature", () => {
    const allowances = (patch: Record<string, Schema.Json>) => ({
      ...computePlan,
      allowances: { ...computePlan.allowances, ...patch },
    })
    expect(validPlan(allowances({ computeUnitHours: -1 }))).toBe(false)
    expect(validPlan(allowances({ computeUnitHourCap: -0.5 }))).toBe(false)
    expect(
      validPlan({
        ...computePlan,
        overage: { ...computePlan.overage, computeCentsPerUnitHour: -0.3 },
      }),
    ).toBe(false)
    expect(validPlan({ ...computePlan, features: ["compute-limit"] })).toBe(false)
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

const computeCaps: Schema.JsonArray = [
  { cap: "compute", limit: 1460, used: 64, atCap: false, refusing: false },
  { cap: "commands", limit: 1000, used: 120, atCap: false, refusing: false, unitsPerCommand: 10 },
]

const meteredProject = {
  projectId: "prj_1",
  name: "Storefront",
  commands: 120,
  computeUnitHours: 64,
  compute: [sharedRecord, performanceRecord],
  estimatedCostCents: 0,
}

const computeProjects: Schema.JsonArray = [
  meteredProject,
  { projectId: "prj_2", name: "Unmetered", commands: 0, estimatedCostCents: 0 },
]

const computeUsage = {
  period: "2026-10",
  meters: [
    { meter: "commands", used: 120, included: 1000, overage: 0, overageCostCents: 0 },
    { meter: "runnerHours", used: 64, included: 1460, overage: 0, overageCostCents: 0 },
    { meter: "egressGb", used: 2.5, included: 100, overage: 0, overageCostCents: 0 },
  ],
  caps: computeCaps,
  commandsPerDay: [{ day: "2026-10-07", commands: 120 }],
  byProject: computeProjects,
  pricing: { freeCommands: 1000, readCommandWeight: 0.1, computeCentsPerUnitHour: 0.3 },
}

const storageUsage = {
  period: "2026-09",
  meters: [
    { meter: "commands", used: 900, included: 1000, overage: 0, overageCostCents: 0 },
    { meter: "storageGb", used: 1.2, included: 1, overage: 0.2, overageCostCents: 5 },
  ],
  latestStorageSample: { bytes: 1_200_000_000, sampledAt: "2026-09-30T23:00:00.000Z" },
  caps: [
    { cap: "storage", limit: 1_000_000_000, used: 1_200_000_000, atCap: true, refusing: true },
  ],
  commandsPerDay: [{ day: "2026-09-30", commands: 900 }],
  byProject: [
    {
      projectId: "prj_1",
      name: "Storefront",
      commands: 900,
      storageGbMonths: 1.2,
      estimatedCostCents: 5,
    },
  ],
  pricing: { freeCommands: 1000, readCommandWeight: 0.1, storagePerGbCents: 25 },
}

describe("usage report", () => {
  const validUsage = wire(Usage)

  it("decodes compute caps, project compute unit-hours and per-machine-size records with no storage fields", () => {
    expect(validUsage(computeUsage)).toBe(true)
  })

  it("still decodes a storage-era report that carries no compute fields", () => {
    expect(validUsage(storageUsage)).toBe(true)
  })

  it("refuses a negative compute rate, negative project compute and a negative compute cap", () => {
    const withProject = (patch: Record<string, Schema.Json>) => ({
      ...computeUsage,
      byProject: [{ ...meteredProject, ...patch }],
    })
    expect(
      validUsage({
        ...computeUsage,
        pricing: { ...computeUsage.pricing, computeCentsPerUnitHour: -1 },
      }),
    ).toBe(false)
    expect(validUsage(withProject({ computeUnitHours: -64 }))).toBe(false)
    expect(validUsage(withProject({ compute: [{ ...sharedRecord, computeUnitHours: -10 }] }))).toBe(
      false,
    )
    expect(
      validUsage({
        ...computeUsage,
        caps: [{ cap: "compute", limit: -1, used: 64, atCap: false, refusing: false }],
      }),
    ).toBe(false)
  })
})
