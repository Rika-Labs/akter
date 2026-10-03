import { Effect, Layer, Schema } from "effect"
import { it } from "@effect/vitest"
import { describe, expect } from "vitest"

import {
  COMMANDS_METER,
  Pricing,
  PricingLive,
  PricingConfigSchema,
  STORAGE_METER,
  UnknownPlan,
  defaultPricingConfig,
  stripeTiers,
} from "./pricing.ts"

const pricing = <A, E>(program: Effect.Effect<A, E, Pricing>) =>
  Effect.scoped(
    Layer.build(PricingLive()).pipe(
      Effect.flatMap((context) => program.pipe(Effect.provideContext(context))),
    ),
  )

const estimate = (tierId: string, commands: number, storageGbMonths: number) =>
  pricing(Pricing.use((service) => service.estimate(tierId, { commands, storageGbMonths })))

describe("plans", () => {
  it("validates configured tiers, fixed read weight and nonnegative prices", () => {
    const valid = Schema.is(PricingConfigSchema)
    expect(valid(defaultPricingConfig)).toBe(true)
    expect(valid({ ...defaultPricingConfig, readCommandWeight: 1 })).toBe(false)
    expect(
      valid({
        ...defaultPricingConfig,
        tiers: [...defaultPricingConfig.tiers, defaultPricingConfig.tiers[0]],
      }),
    ).toBe(false)
    expect(
      valid({
        ...defaultPricingConfig,
        tiers: defaultPricingConfig.tiers.map((tier) => ({ ...tier, basePriceCents: -1 })),
      }),
    ).toBe(false)
    expect(
      valid({
        ...defaultPricingConfig,
        tiers: defaultPricingConfig.tiers.map((tier) =>
          tier.id === "free" ? { ...tier, commandQuota: null } : tier,
        ),
      }),
    ).toBe(false)
  })
  it("lists the four plans with their connection caps and provisional flags", () => {
    expect(
      defaultPricingConfig.tiers.map((tier) => [
        tier.id,
        tier.basePriceCents,
        tier.concurrentConnections,
        tier.provisional,
        tier.commandQuota,
      ]),
    ).toEqual([
      ["free", 0, 100, false, 1_000_000],
      ["pro", 2500, 5000, true, null],
      ["team", 24_900, 50_000, true, null],
      ["enterprise", 250_000, 100_000, true, null],
    ])
  })

  it.effect("looks plans up and rejects an unknown one", () =>
    Effect.gen(function* () {
      expect(
        (yield* pricing(Pricing.use((service) => service.tier("team")))).includedCommands,
      ).toBe(300_000_000)
      expect(yield* pricing(Effect.flip(Pricing.use((service) => service.tier("gold"))))).toEqual(
        UnknownPlan.make({ tierId: "gold" }),
      )
    }),
  )

  it.effect("weights reads at a fifth of a command", () =>
    Effect.gen(function* () {
      expect(
        yield* pricing(
          Pricing.use((service) => Effect.succeed(service.weightedCommands(1000, 500))),
        ),
      ).toBe(1100)
    }),
  )
})

describe("cost estimates", () => {
  it.effect("charges only the base price inside every allowance", () =>
    Effect.gen(function* () {
      expect(yield* estimate("pro", 25_000_000, 10)).toMatchObject({
        baseCents: 2500,
        commandOverageCents: 0,
        storageCents: 0,
        totalCents: 2500,
        provisional: true,
        commandQuotaExceeded: false,
      })
    }),
  )

  it.effect("prices overage per million commands and per GB-month", () =>
    Effect.gen(function* () {
      expect(yield* estimate("pro", 30_000_000, 12)).toMatchObject({
        commandOverageCents: 500,
        storageCents: 60,
        totalCents: 3060,
      })
      expect(yield* estimate("team", 400_000_000, 101)).toMatchObject({
        commandOverageCents: 6000,
        storageCents: 30,
        totalCents: 24_900 + 6000 + 30,
      })
      expect(yield* estimate("enterprise", 6_000_000_000, 1000)).toMatchObject({
        commandOverageCents: 50_000,
        storageCents: 0,
        totalCents: 300_000,
      })
    }),
  )

  it.effect("rounds a fraction of a cent up and absorbs weighting noise", () =>
    Effect.gen(function* () {
      expect((yield* estimate("pro", 25_000_001, 0)).commandOverageCents).toBe(1)
      expect((yield* estimate("pro", 25_000_000.2, 0)).commandOverageCents).toBe(1)
      expect((yield* estimate("pro", 25_000_000, 10.01)).storageCents).toBe(1)
    }),
  )

  it.effect("reports the real cost of unbounded usage instead of capping it", () =>
    Effect.gen(function* () {
      expect((yield* estimate("pro", 5_025_000_000, 0)).totalCents).toBe(2500 + 500_000)
    }),
  )

  it.effect("flags a free plan over its hard command quota and a paid plan never", () =>
    Effect.gen(function* () {
      expect((yield* estimate("free", 1_000_000, 0)).commandQuotaExceeded).toBe(false)
      expect((yield* estimate("free", 1_000_001, 0)).commandQuotaExceeded).toBe(true)
      expect((yield* estimate("pro", 9_000_000_000, 0)).commandQuotaExceeded).toBe(false)
    }),
  )

  it.effect("rejects an unknown plan", () =>
    Effect.gen(function* () {
      expect(
        yield* pricing(
          Effect.flip(
            Pricing.use((service) => service.estimate("gold", { commands: 0, storageGbMonths: 0 })),
          ),
        ),
      ).toEqual(UnknownPlan.make({ tierId: "gold" }))
    }),
  )
})

describe("Stripe catalog from pricing", () => {
  it("sells the paid plans with allowances as free first tiers", () => {
    const catalog = stripeTiers(defaultPricingConfig)

    expect(catalog.map((tier) => tier.id)).toEqual(["pro", "team", "enterprise"])
    expect(catalog.map((tier) => tier.basePriceCents)).toEqual([2500, 24_900, 250_000])
    expect(catalog[0]!.usage).toEqual([
      {
        meter: COMMANDS_METER,
        displayName: "Commands",
        unitAmountDecimal: "0.0001",
        includedUnits: 25_000_000,
      },
      {
        meter: STORAGE_METER,
        displayName: "Storage (GB-months)",
        unitAmountDecimal: "30",
        includedUnits: 10,
      },
    ])
    expect(catalog[1]!.usage[0]!.unitAmountDecimal).toBe("0.00006")
    expect(catalog[2]!.usage[0]!.unitAmountDecimal).toBe("0.00005")
  })
})
