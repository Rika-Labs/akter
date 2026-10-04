import { describe, expect, it } from "vitest"
import type { Billing, Usage, UsageMeter } from "../settings/model.ts"
import { capReached } from "./model.ts"

const billing = (input: {
  readonly plan: Billing["plan"]["id"]
  readonly limitCents: number | null
  readonly currentCents: number
}): Billing => ({
  plan: {
    id: input.plan,
    name: input.plan,
    subscribed: input.plan,
    paymentStatus: input.plan === "free" ? "free" : "active",
    basePriceCents: 0,
    provisional: true,
    renewsAt: null,
    monthToDateCents: input.currentCents,
  },
  card: null,
  billingEmail: null,
  spendLimit: { limitCents: input.limitCents, currentCents: input.currentCents },
})

const commands = (used: number, included: number): UsageMeter => ({
  meter: "commands",
  label: "Commands",
  used,
  included,
  overage: Math.max(0, used - included),
  overageCostCents: 0,
  unit: "count",
})

const usage = (meters: ReadonlyArray<UsageMeter>): Usage => ({
  period: "2026-10",
  meters,
  commandsPerDay: [],
  projects: [],
  pricing: {
    freeCommands: 1_000_000,
    readCommandWeight: 0.2,
    storagePerGbCents: 30,
    provisional: true,
  },
})

describe("capReached", () => {
  it("reports Free's command allowance from the moment it is used up", () => {
    const free = billing({ plan: "free", limitCents: null, currentCents: 0 })
    expect(capReached({ billing: free, usage: usage([commands(999_999.8, 1_000_000)]) })).toBe(
      undefined,
    )
    expect(capReached({ billing: free, usage: usage([commands(1_000_000, 1_000_000)]) })).toEqual({
      cap: "commands",
      period: "2026-10",
      limit: 1_000_000,
    })
  })

  it("treats a paid allowance as billable overage, not a cap", () => {
    const pro = billing({ plan: "pro", limitCents: null, currentCents: 4_100 })
    expect(capReached({ billing: pro, usage: usage([commands(41_000_000, 25_000_000)]) })).toBe(
      undefined,
    )
  })

  it("reports a spend limit only once the estimate is past it", () => {
    const meters = usage([commands(10, 25_000_000)])
    const at = billing({ plan: "pro", limitCents: 2_500, currentCents: 2_500 })
    const past = billing({ plan: "pro", limitCents: 2_500, currentCents: 2_501 })
    const unlimited = billing({ plan: "pro", limitCents: null, currentCents: 900_000 })
    expect(capReached({ billing: at, usage: meters })).toBe(undefined)
    expect(capReached({ billing: past, usage: meters })).toEqual({
      cap: "spend",
      period: "2026-10",
      limit: 2_500,
    })
    expect(capReached({ billing: unlimited, usage: meters })).toBe(undefined)
  })

  it("prefers the hard cap when Free is past both", () => {
    const free = billing({ plan: "free", limitCents: 0, currentCents: 1 })
    expect(capReached({ billing: free, usage: usage([commands(1_200_000, 1_000_000)]) })?.cap).toBe(
      "commands",
    )
  })
})
