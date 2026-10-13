import { describe, expect, it } from "vitest"
import { DateTime } from "effect"
import { Crons } from "./cron.ts"

const next = (expression: string, after: string) =>
  DateTime.formatIso(DateTime.makeUnsafe(Crons.parse(expression).next(Date.parse(after))))

describe("cron action instants", () => {
  it("does not lose a skipped spring wall time or replay gap ticks after the transition", () => {
    const daily = "CRON_TZ=America/New_York 30 2 * * *"
    expect(next(daily, "2027-03-14T06:59:59.999Z")).toBe("2027-03-14T07:00:00.000Z")
    expect(next(daily, "2027-03-14T07:00:00.000Z")).toBe("2027-03-15T06:30:00.000Z")
    expect(next("CRON_TZ=America/New_York */15 * * * *", "2027-03-14T06:59:59Z")).toBe(
      "2027-03-14T07:00:00.000Z",
    )
    expect(next("CRON_TZ=America/New_York */15 * * * *", "2027-03-14T07:00:00Z")).toBe(
      "2027-03-14T07:15:00.000Z",
    )
  })

  it("does not schedule the second autumn occurrence, even when resuming inside the repeated hour", () => {
    const daily = "CRON_TZ=America/New_York 30 1 * * *"
    expect(next(daily, "2026-11-01T05:29:59.999Z")).toBe("2026-11-01T05:30:00.000Z")
    for (const after of ["2026-11-01T05:30:00Z", "2026-11-01T05:59:59Z", "2026-11-01T06:10:00Z"])
      expect(next(daily, after)).toBe("2026-11-02T06:30:00.000Z")
    expect(next("CRON_TZ=America/New_York 0 * * * *", "2026-11-01T05:00:00Z")).toBe(
      "2026-11-01T07:00:00.000Z",
    )
  })

  it("handles southern-hemisphere and non-hour gaps and folds without a one-hour assumption", () => {
    expect(next("CRON_TZ=Australia/Sydney 30 2 * * *", "2026-10-03T00:00:00Z")).toBe(
      "2026-10-03T16:00:00.000Z",
    )
    expect(next("CRON_TZ=Australia/Lord_Howe 15 2 * * *", "2026-10-03T00:00:00Z")).toBe(
      "2026-10-03T15:30:00.000Z",
    )
    expect(next("CRON_TZ=Australia/Lord_Howe 45 1 * * *", "2027-04-03T14:45:00Z")).toBe(
      "2027-04-04T15:15:00.000Z",
    )
  })

  it("keeps UTC expressions and epoch-anchored intervals independent of transitions", () => {
    expect(next("30 1 * * *", "2026-11-01T00:00:00Z")).toBe("2026-11-01T01:30:00.000Z")
    expect(next("CRON_TZ=UTC 30 1 * * *", "2026-11-01T00:00:00Z")).toBe("2026-11-01T01:30:00.000Z")
    expect(next("@every 90 seconds", "1970-01-01T00:01:29.999Z")).toBe("1970-01-01T00:01:30.000Z")
    expect(next("@every 90 seconds", "1970-01-01T00:01:30Z")).toBe("1970-01-01T00:03:00.000Z")
  })

  it("refuses intervals that cannot produce a finite millisecond tick", () => {
    for (const expression of ["@every 999 millis", `@every ${"9".repeat(310)} weeks`])
      expect(() => Crons.parse(expression)).toThrow(/finite duration of at least one second/)
    expect(next("@every 1.5 seconds", "1970-01-01T00:00:00Z")).toBe("1970-01-01T00:00:01.500Z")
  })
})
