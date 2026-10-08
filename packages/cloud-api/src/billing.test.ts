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
    storageGb: 10,
    storageGbCap: null,
    concurrentConnections: 5000,
  },
  overage: { computeCentsPerUnitHour: 1.5, storageCentsPerGbMonth: 50 },
  features: ["compute-overage", "storage-overage", "checkout"],
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
    storageGb: 0.5,
    storageGbCap: 0.5,
    concurrentConnections: 100,
  },
  overage: { computeCentsPerUnitHour: 0, storageCentsPerGbMonth: 0 },
  features: ["compute-cap", "storage-cap"],
  provisional: false,
}

const teamPlan = {
  ...proPlan,
  id: "team",
  name: "Team",
  basePriceCents: 24_900,
  allowances: { ...proPlan.allowances, computeUnitHours: 16_000, storageGb: 50 },
  features: [...proPlan.features, "byo-database", "dedicated-database"],
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

  it("decodes a hard-capped Free plan, a Pro plan billing both overages and a Team plan with its database features", () => {
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

  it("requires the compute sizes, every allowance and both overage rates", () => {
    const { computeSizes: _sizes, ...withoutSizes } = catalog([proPlan])
    expect(validCatalog(withoutSizes)).toBe(false)
    for (const field of [
      "computeUnitHours",
      "computeUnitHourCap",
      "storageGb",
      "storageGbCap",
      "concurrentConnections",
    ] as const) {
      const { [field]: _omitted, ...allowances } = proPlan.allowances
      expect(validPlan({ ...proPlan, allowances })).toBe(false)
    }
    for (const field of ["computeCentsPerUnitHour", "storageCentsPerGbMonth"] as const) {
      const { [field]: _omitted, ...overage } = proPlan.overage
      expect(validPlan({ ...proPlan, overage })).toBe(false)
    }
  })

  it("refuses the command and legacy fields and features that no longer exist", () => {
    for (const feature of ["command-cap", "command-overage", "database-cap"]) {
      expect(validPlan({ ...proPlan, features: [feature] })).toBe(false)
    }
    expect(
      Exit.isFailure(
        strictPlan({ ...proPlan, allowances: { ...proPlan.allowances, commands: 1 } }),
      ),
    ).toBe(true)
    expect(
      Exit.isFailure(
        strictPlan({ ...proPlan, allowances: { ...proPlan.allowances, commandCap: null } }),
      ),
    ).toBe(true)
    expect(
      Exit.isFailure(
        strictPlan({ ...proPlan, overage: { ...proPlan.overage, commandCentsPerMillion: 1 } }),
      ),
    ).toBe(true)
    expect(Exit.isSuccess(strictPlan(proPlan))).toBe(true)
  })

  it("refuses negative compute and storage allowances, caps and rates, and an unknown feature", () => {
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
    expect(validPlan(allowances({ storageGb: -1 }))).toBe(false)
    expect(validPlan(allowances({ storageGbCap: -0.5 }))).toBe(false)
    expect(validPlan(overage({ computeCentsPerUnitHour: -0.3 }))).toBe(false)
    expect(validPlan(overage({ storageCentsPerGbMonth: -50 }))).toBe(false)
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
  { cap: "storage", limit: 0.5, used: 0.5, atCap: true, refusing: true },
]

const meteredProject = {
  projectId: "prj_1",
  name: "Storefront",
  computeUnitHours: 64,
  compute: [sharedRecord, performanceRecord],
  storageGbMonths: 0.12,
  estimatedCostCents: 0,
}

const unmeteredProject = {
  projectId: "prj_2",
  name: "Bring your own",
  computeUnitHours: 0,
  compute: [],
  storageGbMonths: 0,
  estimatedCostCents: 0,
}

const sample = { bytes: 500_000_000, sampledAt: "2026-10-07T23:00:00.000Z" }

const usage = {
  period: "2026-10",
  meters: [
    { meter: "runnerHours", used: 64, included: 750, overage: 0, overageCostCents: 0 },
    { meter: "storageGb", used: 0.5, included: 0.5, overage: 0, overageCostCents: 0 },
  ],
  latestStorageSample: sample,
  caps: usageCaps,
  byProject: [meteredProject, unmeteredProject],
  pricing: { computeCentsPerUnitHour: 0, storageCentsPerGbMonth: 0 },
}

describe("usage report", () => {
  const validUsage = wire(Usage)

  it("decodes compute and storage caps, per-project compute and storage and per-machine-size records", () => {
    expect(validUsage(usage)).toBe(true)
  })

  it("decodes a Pro report billing overage on compute unit-hours and storage, and one with no storage sample yet", () => {
    const billed = {
      ...usage,
      meters: [
        { meter: "runnerHours", used: 1600, included: 1500, overage: 100, overageCostCents: 150 },
        { meter: "storageGb", used: 12, included: 10, overage: 2, overageCostCents: 100 },
      ],
      caps: [],
      pricing: { computeCentsPerUnitHour: 1.5, storageCentsPerGbMonth: 50 },
    }
    expect(validUsage(billed)).toBe(true)
    expect(validUsage({ ...billed, latestStorageSample: null })).toBe(true)
  })

  it("refuses the command and outbound-traffic meters and the command caps that no longer exist", () => {
    const meter = { used: 120, included: 1000, overage: 0, overageCostCents: 0 }
    for (const name of ["commands", "reads", "egressGb"]) {
      expect(validUsage({ ...usage, meters: [{ meter: name, ...meter }] })).toBe(false)
    }
    const commands = {
      cap: "commands",
      limit: 1000,
      used: 1,
      atCap: false,
      refusing: false,
      unitsPerCommand: 1,
    }
    expect(validUsage({ ...usage, caps: [commands] })).toBe(false)
  })

  it("requires the storage sample, the caps, each project's compute and storage, and both prices", () => {
    const { latestStorageSample: _sample, ...noSample } = usage
    const { caps: _caps, ...noCaps } = usage
    expect(validUsage(noSample)).toBe(false)
    expect(validUsage(noCaps)).toBe(false)
    for (const field of ["computeUnitHours", "compute", "storageGbMonths"] as const) {
      const { [field]: _omitted, ...project } = meteredProject
      expect(validUsage({ ...usage, byProject: [project] })).toBe(false)
    }
    expect(validUsage({ ...usage, pricing: { computeCentsPerUnitHour: 1.5 } })).toBe(false)
    expect(validUsage({ ...usage, pricing: { storageCentsPerGbMonth: 50 } })).toBe(false)
  })

  it("refuses a negative rate, negative project compute or storage, a negative storage sample and a negative cap", () => {
    const withProject = (patch: Record<string, Schema.Json>) => ({
      ...usage,
      byProject: [{ ...meteredProject, ...patch }],
    })
    expect(
      validUsage({ ...usage, pricing: { ...usage.pricing, computeCentsPerUnitHour: -1 } }),
    ).toBe(false)
    expect(
      validUsage({ ...usage, pricing: { ...usage.pricing, storageCentsPerGbMonth: -1 } }),
    ).toBe(false)
    expect(validUsage(withProject({ computeUnitHours: -64 }))).toBe(false)
    expect(validUsage(withProject({ storageGbMonths: -0.1 }))).toBe(false)
    expect(validUsage(withProject({ compute: [{ ...sharedRecord, computeUnitHours: -10 }] }))).toBe(
      false,
    )
    expect(validUsage({ ...usage, latestStorageSample: { ...sample, bytes: -1 } })).toBe(false)
    expect(
      validUsage({
        ...usage,
        caps: [{ cap: "storage", limit: -1, used: 0, atCap: false, refusing: false }],
      }),
    ).toBe(false)
  })
})
