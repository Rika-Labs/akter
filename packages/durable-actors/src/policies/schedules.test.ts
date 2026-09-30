import { DateTime } from "effect"
import { describe, expect, it } from "vitest"
import { Actor } from "../index.ts"
import { resolveSchedules } from "./schedules.ts"

const Tick = Actor.command("Tick")

const entryOf = (declaration: string) => {
  const [entry] = resolveSchedules({ declared: { [declaration]: Tick }, commands: [Tick] })

  return entry!
}

/** The scheduled instants after `from`, as ISO strings; expectations below come from tz data via GNU date. */
const ticks = (declaration: string, from: string, count: number) => {
  const entry = entryOf(declaration)
  const out: Array<string> = []
  let at = Date.parse(from)

  for (let index = 0; index < count; index++) {
    at = entry.next(at)
    out.push(DateTime.formatIso(DateTime.makeUnsafe(at)))
  }

  return out
}

describe("cron schedules in a time zone", () => {
  it("fires a time a spring-forward gap skips once, at the first instant after the gap", () => {
    expect(ticks("CRON_TZ=America/New_York 30 2 * * *", "2027-03-13T12:00:00Z", 2)).toEqual([
      "2027-03-14T07:00:00.000Z",
      "2027-03-15T06:30:00.000Z",
    ])
    expect(ticks("CRON_TZ=America/New_York */15 * * * *", "2027-03-14T06:40:00Z", 3)).toEqual([
      "2027-03-14T06:45:00.000Z",
      "2027-03-14T07:00:00.000Z",
      "2027-03-14T07:15:00.000Z",
    ])
    expect(ticks("CRON_TZ=America/New_York 30 2 * * *", "2027-03-14T07:00:00Z", 1)).toEqual([
      "2027-03-15T06:30:00.000Z",
    ])
  })

  it("fires a time a fall-back transition repeats once, at its first occurrence", () => {
    expect(ticks("CRON_TZ=America/New_York 30 1 * * *", "2026-10-31T12:00:00Z", 2)).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
    ])

    for (const from of ["2026-11-01T05:30:00Z", "2026-11-01T05:59:59Z", "2026-11-01T06:10:00Z"])
      expect(ticks("CRON_TZ=America/New_York 30 1 * * *", from, 1)).toEqual([
        "2026-11-02T06:30:00.000Z",
      ])

    expect(ticks("CRON_TZ=America/New_York 0 * * * *", "2026-11-01T04:30:00Z", 3)).toEqual([
      "2026-11-01T05:00:00.000Z",
      "2026-11-01T07:00:00.000Z",
      "2026-11-01T08:00:00.000Z",
    ])
    expect(ticks("CRON_TZ=America/New_York 0 * * * *", "2026-11-01T06:20:00Z", 1)).toEqual([
      "2026-11-01T07:00:00.000Z",
    ])
  })

  it("follows southern-hemisphere and half-hour transitions", () => {
    expect(ticks("CRON_TZ=Australia/Sydney 30 2 * * *", "2026-10-03T00:00:00Z", 2)).toEqual([
      "2026-10-03T16:00:00.000Z",
      "2026-10-04T15:30:00.000Z",
    ])
    expect(ticks("CRON_TZ=Australia/Sydney 30 2 * * *", "2027-04-03T00:00:00Z", 2)).toEqual([
      "2027-04-03T15:30:00.000Z",
      "2027-04-04T16:30:00.000Z",
    ])
    expect(ticks("CRON_TZ=Australia/Lord_Howe 15 2 * * *", "2026-10-03T00:00:00Z", 2)).toEqual([
      "2026-10-03T15:30:00.000Z",
      "2026-10-04T15:15:00.000Z",
    ])
    expect(ticks("CRON_TZ=Australia/Lord_Howe 45 1 * * *", "2027-04-03T00:00:00Z", 2)).toEqual([
      "2027-04-03T14:45:00.000Z",
      "2027-04-04T15:15:00.000Z",
    ])
  })

  it("gives the same expression different instants in different zones and UTC", () => {
    expect(ticks("0 8 * * *", "2026-09-28T00:00:00Z", 1)).toEqual(["2026-09-28T08:00:00.000Z"])
    expect(ticks("CRON_TZ=UTC 0 8 * * *", "2026-09-28T00:00:00Z", 1)).toEqual([
      "2026-09-28T08:00:00.000Z",
    ])
    expect(ticks("CRON_TZ=America/New_York 0 8 * * *", "2026-09-28T00:00:00Z", 1)).toEqual([
      "2026-09-28T12:00:00.000Z",
    ])
    expect(ticks("CRON_TZ=Europe/London 0 8 * * *", "2026-09-28T00:00:00Z", 1)).toEqual([
      "2026-09-28T07:00:00.000Z",
    ])
    expect(ticks("CRON_TZ=Asia/Kolkata 0 8 * * *", "2026-09-28T00:00:00Z", 1)).toEqual([
      "2026-09-28T02:30:00.000Z",
    ])
  })
})

describe("fixed-interval schedules", () => {
  it("fires on whole multiples of the interval since the Unix epoch", () => {
    const ninety = 90 * 60_000

    expect(ticks("@every 90 minutes", "1970-01-01T00:00:00Z", 2)).toEqual([
      "1970-01-01T01:30:00.000Z",
      "1970-01-01T03:00:00.000Z",
    ])
    expect(Date.parse("2026-09-28T01:30:00Z") % ninety).toBe(0)
    expect(ticks("@every 90 minutes", "2026-09-28T01:29:59.999Z", 1)).toEqual([
      "2026-09-28T01:30:00.000Z",
    ])
    expect(ticks("@every 90 minutes", "2026-09-28T01:30:00Z", 1)).toEqual([
      "2026-09-28T03:00:00.000Z",
    ])
    expect(ticks("@every 1 hour", "2026-11-01T04:30:00Z", 3)).toEqual([
      "2026-11-01T05:00:00.000Z",
      "2026-11-01T06:00:00.000Z",
      "2026-11-01T07:00:00.000Z",
    ])
  })
})
