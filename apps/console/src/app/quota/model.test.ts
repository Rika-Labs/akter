import type { CapState } from "@akter/cloud-api"
import { describe, expect, it } from "vitest"
import type { Billing } from "../settings/model.ts"
import { CapNotice, capNotice, spendLimitReached } from "./model.ts"

const clear: ReadonlyArray<CapState> = [
  { cap: "commands", limit: 5_000_000, used: 1_200_000, atCap: false, refusing: false },
  { cap: "spend", limit: null, used: 0, atCap: false, refusing: false },
  { cap: "connections", limit: 100, used: 4, atCap: false, refusing: false },
  { cap: "storage", limit: 500_000_000, used: 120_000_000, atCap: false, refusing: false },
]

const changing = (...changed: ReadonlyArray<CapState>): ReadonlyArray<CapState> =>
  clear.map((cap) => changed.find((entry) => entry.cap === cap.cap) ?? cap)

const notice = (caps: ReadonlyArray<CapState>) => capNotice({ caps, period: "2026-10" })

describe("capNotice", () => {
  it("stays quiet while no cap refuses, and without cap state at all", () => {
    expect(notice(clear)).toBe(undefined)
    expect(notice([])).toBe(undefined)
  })

  it("follows the edge's refusal, not usage reaching the limit", () => {
    const reached = changing({
      cap: "spend",
      limit: 2_500,
      used: 2_500,
      atCap: true,
      refusing: false,
    })
    expect(notice(reached)).toBe(undefined)
    const refusing = changing({
      cap: "spend",
      limit: 2_500,
      used: 2_499,
      atCap: false,
      refusing: true,
    })
    expect(notice(refusing)).toEqual(CapNotice.SpendCap({ period: "2026-10", limitCents: 2_500 }))
  })

  it("reports the storage cap with the largest tenant's latest sample and its limit", () => {
    const storage = changing({
      cap: "storage",
      limit: 500_000_000,
      used: 512_340_000,
      atCap: true,
      refusing: true,
    })
    expect(notice(storage)).toEqual(
      CapNotice.StorageCap({ usedBytes: 512_340_000, limitBytes: 500_000_000 }),
    )
  })

  it("explains a hard cap before a spend limit or connections", () => {
    const all = changing(
      { cap: "spend", limit: 0, used: 1, atCap: true, refusing: true },
      { cap: "connections", limit: 100, used: 100, atCap: true, refusing: true },
      { cap: "storage", limit: 500_000_000, used: 600_000_000, atCap: true, refusing: true },
      { cap: "commands", limit: 5_000_000, used: 5_000_000, atCap: true, refusing: true },
    )
    expect(notice(all)).toEqual(CapNotice.CommandCap({ period: "2026-10", commands: null }))
    expect(notice(changing(...all.filter((cap) => cap.cap !== "commands")))).toEqual(
      CapNotice.StorageCap({ usedBytes: 600_000_000, limitBytes: 500_000_000 }),
    )
    expect(
      notice(
        changing({ cap: "connections", limit: 5_000, used: 5_000, atCap: true, refusing: true }),
      ),
    ).toEqual(CapNotice.ConnectionCap({ open: 5_000, limit: 5_000 }))
  })

  it("quotes the command cap in commands once a command no longer fits, though a read still does", () => {
    const commands = (used: number, unitsPerCommand: number): CapState => ({
      cap: "commands",
      limit: 5_000_000,
      used,
      atCap: used >= 5_000_000,
      refusing: used + unitsPerCommand > 5_000_000,
      unitsPerCommand,
    })
    expect(notice(changing(commands(999_999 * 5, 5)))).toBe(undefined)
    expect(notice(changing(commands(999_999 * 5 + 1, 5)))).toEqual(
      CapNotice.CommandCap({ period: "2026-10", commands: 1_000_000 }),
    )
    expect(notice(changing(commands(4_999_997, 4)))).toEqual(
      CapNotice.CommandCap({ period: "2026-10", commands: 1_250_000 }),
    )
    const { unitsPerCommand: _weight, ...unweighed } = commands(4_999_999, 5)
    expect(notice(changing(unweighed))).toEqual(
      CapNotice.CommandCap({ period: "2026-10", commands: null }),
    )
  })

  it("reads an organization without a billing account as unbound, never as a reached cap", () => {
    const unbound: ReadonlyArray<CapState> = clear.map((cap) => ({
      cap: cap.cap,
      limit: null,
      used: cap.used,
      atCap: false,
      refusing: true,
      reason: "unbound",
    }))
    expect(notice(unbound)).toEqual(CapNotice.Unbound())
    expect(notice([...unbound.slice(1), ...clear.slice(0, 1)])).toEqual(CapNotice.Unbound())
  })

  it("does not quote a refusing cap that has no limit", () => {
    expect(
      notice(changing({ cap: "commands", limit: null, used: 9, atCap: false, refusing: true })),
    ).toBe(undefined)
  })
})

describe("spendLimitReached", () => {
  const billing = (currentCents: number): Billing => ({
    plan: {
      id: "pro",
      name: "Pro",
      subscribed: "pro",
      paymentStatus: "active",
      basePriceCents: 2_500,
      provisional: true,
      renewsAt: null,
      monthToDateCents: currentCents,
    },
    card: null,
    billingEmail: null,
    spendLimit: { limitCents: null, currentCents },
    caps: [],
  })

  it("treats a limit the estimate has reached as refusing right away, and one above it as not", () => {
    expect(spendLimitReached({ limitCents: 2_500, billing: billing(2_499) })).toBe(false)
    expect(spendLimitReached({ limitCents: 2_500, billing: billing(2_500) })).toBe(true)
    expect(spendLimitReached({ limitCents: 0, billing: billing(0) })).toBe(true)
  })
})
