import { Cron, DateTime, Duration, Effect, Option, Result, Schema, SchemaAST } from "effect"
import type { AnyCommand } from "../members/command.ts"
import { CRON_PREFIX } from "../runtime/cron/key.ts"

/** One `schedules` entry: its tick's timer key, when it ticks, and its zero-input target. */
export interface CronEntry {
  readonly key: string
  /** The first scheduled instant strictly after `afterMs`. */
  readonly next: (afterMs: number) => number
  readonly command: string
  /** Encodes the target's empty input, as an intent carries it. */
  readonly payload: Effect.Effect<string>
}

/** The commands a `schedules` entry may target: those whose payload is `Schema.Void`. */
export type ScheduleTarget<Command extends AnyCommand> = AnyCommand extends Command
  ? AnyCommand
  : Extract<Command, { readonly payload: Schema.Void }>

/** An actor type's cron entries and how late a tick may still fire. */
export interface CronSchedule {
  readonly entries: ReadonlyArray<CronEntry>
  readonly skipMs: number
}

const emptyPayload = (command: AnyCommand) =>
  Schema.encodeEffect(
    Schema.fromJsonString(Schema.toCodecJson(Schema.Struct({ value: command.payload }))),
  )({ value: undefined }).pipe(Effect.orDie)

const ZONE_PREFIX = /^CRON_TZ=(\S+)\s+(.*)$/

const EVERY_PREFIX = /^@every(?:\s+(.*))?$/

const DAY_MS = 86_400_000

/**
 * A declaration's timer key and the first scheduled instant strictly after a
 * time. Offset zones such as `+05:00` are rejected as unknown: they have no
 * daylight saving, so a UTC expression says the same thing. Cron fields are
 * parsed in UTC and `nextInZone` maps the wall-clock times to instants.
 */
const scheduleOf = (declaration: string): Pick<CronEntry, "key" | "next"> => {
  const normalized = declaration.trim().replace(/\s+/g, " ")
  const zoned = ZONE_PREFIX.exec(normalized)
  const zone = zoned?.[1] ?? "UTC"
  const expression = zoned?.[2] ?? normalized
  const every = EVERY_PREFIX.exec(expression)

  if (every !== null) {
    if (zoned !== null)
      throw new Error(`schedules "${declaration}": an interval takes no time zone`)

    const length = Duration.fromInput((every[1] ?? "") as Duration.Input)
    const millis = Option.isSome(length) ? Duration.toMillis(length.value) : Number.NaN

    if (!Number.isSafeInteger(millis) || millis < 1000)
      throw new Error(
        `schedules "${declaration}" needs an interval of whole milliseconds, at least 1 second`,
      )

    return { key: `${CRON_PREFIX}@every ${millis}ms`, next: nextEvery(millis) }
  }

  if (/^[+-]/.test(zone) || Option.isNone(DateTime.zoneMakeNamed(zone)))
    throw new Error(`schedules "${declaration}" names an unknown time zone "${zone}"`)

  const parsed = Cron.parse(expression, "UTC")

  if (Result.isFailure(parsed))
    throw new Error(`schedules "${declaration}" does not parse: ${parsed.failure.message}`)

  return {
    key: `${CRON_PREFIX}${zone} ${canonicalOf(parsed.success)}`,
    next: nextInZone(zone, parsed.success),
  }
}

/**
 * Parses `schedules`. A key is a five- or six-field Effect `Cron.parse`
 * expression evaluated in UTC, the same with a `CRON_TZ=<IANA zone> ` prefix
 * evaluated in that zone, or `@every <duration>`. Whitespace is normalized and
 * the timer key names the zone, so one expression in two zones is two entries.
 * Two declarations with one timer key, an unparsable expression, an unknown
 * zone, a bad interval, or a target that is not a zero-input command of this
 * actor throw.
 */
export const resolveSchedules = ({
  declared,
  commands,
}: {
  readonly declared: Readonly<Record<string, AnyCommand>> | undefined
  readonly commands: ReadonlyArray<AnyCommand>
}): ReadonlyArray<CronEntry> => {
  const entries: Array<CronEntry> = []
  const declarations = new Map<string, string>()

  for (const [declaration, command] of Object.entries(declared ?? {})) {
    const { key, next } = scheduleOf(declaration)

    if (!commands.includes(command))
      throw new Error(`schedules "${declaration}" must name a command of this actor`)

    if (!SchemaAST.isVoid(command.payload.ast))
      throw new Error(`schedules "${declaration}" must name a command without input`)

    const duplicate = declarations.get(key)

    if (duplicate !== undefined)
      throw new Error(`schedules "${declaration}" repeats the schedule of "${duplicate}"`)

    declarations.set(key, declaration)
    entries.push({
      key,
      next,
      command: command.tag,
      payload: emptyPayload(command),
    })
  }

  return entries
}

const field = (values: ReadonlySet<number>, size: number) =>
  values.size === 0 || values.size === size ? "*" : [...values].join(",")

/** One spelling per parsed schedule, so equivalent expressions share a timer key. */
const canonicalOf = (cron: Cron.Cron) => {
  const seconds = [...cron.seconds]

  const fields = [
    field(cron.minutes, 60),
    field(cron.hours, 24),
    cron.days.size === 0 ? "*" : [...cron.days].join(","),
    field(cron.months, 12),
    cron.weekdays.size === 0 ? "*" : [...cron.weekdays].join(","),
  ]

  return (
    seconds.length === 1 && seconds[0] === 0 ? fields : [field(cron.seconds, 60), ...fields]
  ).join(" ")
}

/** Interval ticks fall on whole multiples of the interval since the Unix epoch. */
const nextEvery = (millis: number) => (afterMs: number) =>
  (Math.floor(afterMs / millis) + 1) * millis

const offsetAt = (zone: DateTime.TimeZone, ms: number) =>
  DateTime.zonedOffset(DateTime.makeZonedUnsafe(ms, { timeZone: zone }))

/**
 * The earliest instant whose wall clock in `zone` shows `wall` (a wall-clock
 * time written as UTC milliseconds), or, when a spring-forward gap skips
 * `wall`, the first instant after that gap. Offsets a day either side bound
 * the candidates, since no zone changes its offset twice within two days. A
 * larger offset gives an earlier instant, so candidates are tried larger
 * offset first and a repeated time resolves to its first occurrence; a gap is
 * resolved by bisecting for the first instant whose wall clock reaches `wall`.
 */
const instantOf = (zone: DateTime.TimeZone, wall: number) => {
  const before = offsetAt(zone, wall - DAY_MS)
  const after = offsetAt(zone, wall + DAY_MS)

  for (const offset of before >= after ? [before, after] : [after, before]) {
    if (offsetAt(zone, wall - offset) === offset) return wall - offset
  }

  let low = wall - Math.max(before, after)
  let high = wall - Math.min(before, after)

  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)

    if (middle + offsetAt(zone, middle) >= wall) high = middle
    else low = middle
  }

  return high
}

/**
 * The first scheduled instant after `afterMs`: a matching wall-clock time at
 * its first occurrence, or the first instant after a gap that skips one. A
 * repeated time's second occurrence is never scheduled, however late the tick
 * is rewritten, so it cannot fire twice.
 */
const nextInZone = (zone: string, cron: Cron.Cron) => {
  if (zone === "UTC") return (afterMs: number) => Cron.next(cron, afterMs).getTime()

  const named = DateTime.zoneMakeNamedUnsafe(zone)

  return (afterMs: number) => {
    let wall = afterMs + offsetAt(named, afterMs)

    for (;;) {
      wall = Cron.next(cron, wall).getTime()
      const instant = instantOf(named, wall)

      if (instant > afterMs) return instant
    }
  }
}
