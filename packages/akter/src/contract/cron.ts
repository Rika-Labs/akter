import { Cron, DateTime, Option } from "effect"

/** A parsed `cron` option: the next due instant strictly after a given one. */
export interface CronSchedule {
  readonly next: (after: number) => number
}

const every = /^@every\s+(\d+(?:\.\d+)?)\s*([a-z]+)$/

const units: ReadonlyMap<string, number> = new Map([
  ["millis", 1],
  ["second", 1_000],
  ["seconds", 1_000],
  ["minute", 60_000],
  ["minutes", 60_000],
  ["hour", 3_600_000],
  ["hours", 3_600_000],
  ["day", 86_400_000],
  ["days", 86_400_000],
  ["week", 604_800_000],
  ["weeks", 604_800_000],
])
const zoned = /^CRON_TZ=(\S+)\s+(.+)$/

/**
 * Parses a `cron` option: a five- or six-field expression in UTC, `CRON_TZ=<IANA zone>
 * <expression>`, or `@every <n> <unit>` of at least one second anchored to the Unix epoch. The
 * zone is explicit so the next due instant never depends on the host's local time; fixed offsets
 * and unknown zones are refused. Throws on anything else.
 */
const parse = (expression: string): CronSchedule => {
  const interval = every.exec(expression.trim())
  if (interval !== null) {
    const millis = Number(interval[1]) * (units.get(interval[2] ?? "") ?? Number.NaN)
    if (!Number.isFinite(millis) || millis < 1_000)
      throw new Error(
        `Invalid cron schedule '${expression}': @every needs a finite duration of at least one second`,
      )
    return { next: (after) => (Math.floor(after / millis) + 1) * millis }
  }
  const explicit = zoned.exec(expression.trim())
  const zoneName = explicit?.[1] ?? "UTC"
  const zone = /^[+-]/.test(zoneName) ? Option.none() : DateTime.zoneMakeNamed(zoneName)
  if (Option.isNone(zone))
    throw new Error(
      `Invalid cron schedule '${expression}': '${zoneName}' is not a named IANA time zone`,
    )
  const cron = Cron.parseUnsafe(explicit?.[2] ?? expression, "UTC")
  return {
    next:
      zoneName === "UTC"
        ? (after) => Cron.next(cron, after).getTime()
        : nextInZone(zone.value, cron),
  }
}

const offsetAt = (zone: DateTime.TimeZone, ms: number) =>
  DateTime.zonedOffset(DateTime.makeZonedUnsafe(ms, { timeZone: zone }))

/**
 * Maps a wall time written as UTC milliseconds to its first occurrence in the zone. A gap maps
 * to the transition instant, found by bisecting between the offsets either side of that day.
 */
const instantOf = (zone: DateTime.TimeZone, wall: number) => {
  const before = offsetAt(zone, wall - 86_400_000)
  const after = offsetAt(zone, wall + 86_400_000)
  for (const offset of before >= after ? [before, after] : [after, before])
    if (offsetAt(zone, wall - offset) === offset) return wall - offset

  let low = wall - Math.max(before, after)
  let high = wall - Math.min(before, after)
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (middle + offsetAt(zone, middle) >= wall) high = middle
    else low = middle
  }
  return high
}

/** Repeated wall times never schedule their second occurrence, even when resuming in that hour. */
const nextInZone = (zone: DateTime.TimeZone.Named, cron: Cron.Cron) => (after: number) => {
  let wall = after + offsetAt(zone, after)
  for (;;) {
    wall = Cron.next(cron, wall).getTime()
    const instant = instantOf(zone, wall)
    if (instant > after) return instant
  }
}

/** Cron schedules of `cron` actions. */
export const Crons = { parse }
