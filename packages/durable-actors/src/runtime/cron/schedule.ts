import { Crypto, Cron, DateTime, Duration, Effect, Option, Result, Schema, SchemaAST } from "effect"
import { SqlClient, type Statement } from "effect/unstable/sql"
import { type ActorRef, System } from "../../identity/caller.ts"
import type { AnyCommand } from "../../members/command.ts"
import { CRON_PREFIX } from "./key.ts"
import { databaseTime } from "../turn/admission.ts"
import { bucketOf, CallerJson, OutboxRuntime } from "../turn/outbox.ts"

export { CRON_PREFIX }

/** One `policy.cron` entry: its tick's timer key, when it ticks, and its zero-input target. */
export interface CronEntry {
  readonly key: string
  /** The first scheduled instant strictly after `afterMs`. */
  readonly next: (afterMs: number) => number
  readonly command: string
  /** Encodes the target's empty input, as an intent carries it. */
  readonly payload: Effect.Effect<string>
}

/** An actor type's cron entries and how late a tick may still fire. */
export interface CronSchedule {
  readonly entries: ReadonlyArray<CronEntry>
  readonly skipMs: number
}

const emptyPayload = (command: AnyCommand) =>
  Schema.encodeEffect(
    Schema.fromJsonString(Schema.toCodecJson(Schema.Struct({ value: command.input }))),
  )({ value: undefined }).pipe(Effect.orDie)

const ZONE_PREFIX = /^CRON_TZ=(\S+)\s+(.*)$/

const EVERY_PREFIX = /^@every(?:\s+(.*))?$/

const DAY_MS = 86_400_000

/** A declaration's timer key and the first scheduled instant strictly after a time. */
const scheduleOf = (declaration: string): Pick<CronEntry, "key" | "next"> => {
  const normalized = declaration.trim().replace(/\s+/g, " ")
  const zoned = ZONE_PREFIX.exec(normalized)
  const zone = zoned?.[1] ?? "UTC"
  const expression = zoned?.[2] ?? normalized
  const every = EVERY_PREFIX.exec(expression)

  if (every !== null) {
    if (zoned !== null)
      throw new Error(`policy.cron "${declaration}": an interval takes no time zone`)

    // The declared text is only a string here; `fromInput` rejects one that is not a duration.
    const length = Duration.fromInput((every[1] ?? "") as Duration.Input)
    const millis = Option.isSome(length) ? Duration.toMillis(length.value) : Number.NaN

    if (!Number.isSafeInteger(millis) || millis < 1000)
      throw new Error(
        `policy.cron "${declaration}" needs an interval of whole milliseconds, at least 1 second`,
      )

    return { key: `${CRON_PREFIX}@every ${millis}ms`, next: nextEvery(millis) }
  }

  // Offsets such as +05:00 resolve as zones too, but they have no daylight
  // saving to follow, so a UTC expression says the same thing.
  if (/^[+-]/.test(zone) || Option.isNone(DateTime.zoneMakeNamed(zone)))
    throw new Error(`policy.cron "${declaration}" names an unknown time zone "${zone}"`)

  // Fields are read in UTC; `nextInZone` maps wall-clock times to instants.
  const parsed = Cron.parse(expression, "UTC")

  if (Result.isFailure(parsed))
    throw new Error(`policy.cron "${declaration}" does not parse: ${parsed.failure.message}`)

  return {
    key: `${CRON_PREFIX}${zone} ${canonicalOf(parsed.success)}`,
    next: nextInZone(zone, parsed.success),
  }
}

/**
 * Parses `policy.cron`. A key is a five- or six-field Effect `Cron.parse`
 * expression evaluated in UTC, the same with a `CRON_TZ=<IANA zone> ` prefix
 * evaluated in that zone, or `@every <duration>`. Whitespace is normalized and
 * the timer key names the zone, so one expression in two zones is two entries.
 * Two declarations with one timer key, an unparsable expression, an unknown
 * zone, a bad interval, or a target that is not a zero-input command of this
 * actor throw.
 */
export const resolveCron = ({
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
      throw new Error(`policy.cron "${declaration}" must name a command of this actor`)

    if (!SchemaAST.isVoid(command.input.ast))
      throw new Error(`policy.cron "${declaration}" must name a command without input`)

    const duplicate = declarations.get(key)

    if (duplicate !== undefined)
      throw new Error(`policy.cron "${declaration}" repeats the schedule of "${duplicate}"`)

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
 * the candidates, since no zone changes its offset twice within two days.
 */
const instantOf = (zone: DateTime.TimeZone, wall: number) => {
  const before = offsetAt(zone, wall - DAY_MS)
  const after = offsetAt(zone, wall + DAY_MS)

  // A larger offset gives an earlier instant, so a repeated time resolves to
  // its first occurrence.
  for (const offset of before >= after ? [before, after] : [after, before]) {
    if (offsetAt(zone, wall - offset) === offset) return wall - offset
  }

  // `wall` falls in a gap: find the first instant whose wall clock reaches it.
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

const tickId = (now: number, dueAt: number, retryWindowMs: number) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie)

    return `v1.${now}.${Math.max(dueAt, now) + retryWindowMs}.${uuid}`
  })

/** A tick row as `writeTicks` inserts it. */
type TickInsert = {
  readonly routing_key: bigint
  readonly intent_id: string
  readonly kind: "intent"
  readonly bucket: number
  readonly due_at_ms: number
  readonly scheduled_at_ms: number
  readonly tenant_id: string
  readonly actor_type: string
  readonly actor_id: string
  readonly timer_key: string
  readonly target_type: string
  readonly target_id: string
  readonly command: string
  readonly payload: string
  readonly caller: string
}

/**
 * Writes the first tick of every entry `ref` has no pending tick for. The
 * timer-key unique index makes concurrent writers, and entries that already
 * tick, no-ops.
 */
export const writeTicks = Effect.fnUntraced(function* (
  routingKey: bigint,
  ref: ActorRef,
  entries: ReadonlyArray<CronEntry>,
  now: number,
) {
  if (entries.length === 0) return

  const sql = yield* SqlClient.SqlClient
  const { retryWindowMs } = yield* OutboxRuntime

  const caller = yield* Schema.encodeEffect(CallerJson)(System.make({ source: "cron", ref })).pipe(
    Effect.orDie,
  )

  const rows: Array<TickInsert> = []

  for (const entry of entries) {
    const dueAt = entry.next(now)

    rows.push({
      routing_key: routingKey,
      intent_id: yield* tickId(now, dueAt, retryWindowMs),
      kind: "intent",
      bucket: bucketOf(routingKey),
      due_at_ms: dueAt,
      scheduled_at_ms: dueAt,
      tenant_id: ref.tenant,
      actor_type: ref.actor,
      actor_id: ref.id,
      timer_key: entry.key,
      target_type: ref.actor,
      target_id: ref.id,
      command: entry.command,
      payload: yield* entry.payload,
      caller,
    })
  }

  yield* sql`INSERT INTO actor_outbox ${sql.insert(rows)}
    ON CONFLICT (routing_key, tenant_id, actor_type, actor_id, timer_key)
      WHERE timer_key IS NOT NULL
    DO NOTHING`
})

/**
 * Writes a singleton's missing ticks in its default tenant at startup. Every
 * runner does this; the generation and timer-key unique indexes keep one row
 * per entry however many start at once.
 */
export const bootstrapTicks = Effect.fnUntraced(function* (
  routingKey: bigint,
  ref: ActorRef,
  entries: ReadonlyArray<CronEntry>,
) {
  if (entries.length === 0) return

  const sql = yield* SqlClient.SqlClient

  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id)
        VALUES (${routingKey}, ${ref.tenant}, ${ref.actor}, ${ref.id}) ON CONFLICT DO NOTHING`
      yield* writeTicks(routingKey, ref, entries, yield* databaseTime)
    }),
  )
})

/** The claimed tick row the relay settles. */
export interface ClaimedTick {
  readonly tenant_id: string
  readonly actor_type: string
  readonly actor_id: string
  readonly routing_key: string
  readonly intent_id: string
  readonly command: string
  readonly payload: string
  readonly timer_key: string | null
  readonly scheduled_at: string
  readonly claimed_until: string
}

/**
 * Settles claimed `$cron:` rows for one relay. A tick is delivered like any
 * intent unless it is older than its type's skip window, and after its
 * receipt commits the row is rewritten, in place and under the same claim, to
 * the first tick after now with a fresh id. A tick whose entry this runner
 * does not declare is deleted once it is past the skip window and otherwise
 * released with backoff, so a runner that still declares it can fire it. A
 * tick whose stored target differs from its entry's delivers the entry's.
 */
export const cronTicks = ({
  sql,
  crypto,
  schedules,
  retryWindowMs,
}: {
  readonly sql: SqlClient.SqlClient
  readonly crypto: Crypto.Crypto
  readonly schedules: () => ReadonlyMap<string, CronSchedule>
  readonly retryWindowMs: number
}) => {
  const entryOf = (row: ClaimedTick) =>
    schedules()
      .get(row.actor_type)
      ?.entries.find((entry) => entry.key === row.timer_key)

  const rewrite = Effect.fnUntraced(function* (
    row: ClaimedTick,
    entry: CronEntry,
    claim: Statement.Fragment,
  ) {
    const now = yield* databaseTime
    const dueAt = entry.next(now)

    const id = yield* tickId(now, dueAt, retryWindowMs).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
    )

    const payload = yield* entry.payload
    yield* sql`UPDATE actor_outbox SET intent_id = ${id},
        command = ${entry.command}, payload = ${payload}, due_at_ms = ${dueAt},
        scheduled_at_ms = ${dueAt}, attempts = 0, last_error = NULL, ambiguous = false
      WHERE ${claim}`
  })

  return {
    /** A tick is a `$cron:` row; application intents may not use the prefix. */
    isTick: (row: ClaimedTick) => row.timer_key?.startsWith(CRON_PREFIX) === true,
    /**
     * Settles a tick that must not fire and returns undefined, or returns the
     * command and payload the relay delivers on this claim.
     */
    settleUnfired: Effect.fnUntraced(function* (
      row: ClaimedTick,
      claim: Statement.Fragment,
      backoffMs: number,
    ) {
      const schedule = schedules().get(row.actor_type)
      const entry = entryOf(row)
      const now = yield* databaseTime
      const scheduledAt = Number(row.scheduled_at)
      const stale = schedule !== undefined && now - scheduledAt > schedule.skipMs

      const annotations = {
        actor: row.actor_type,
        id: row.actor_id,
        tenant: row.tenant_id,
        timerKey: row.timer_key,
        commandId: row.intent_id,
      }

      if (entry === undefined) {
        if (stale) {
          yield* Effect.logInfo("Cron tick removed").pipe(Effect.annotateLogs(annotations))
          yield* sql`DELETE FROM actor_outbox WHERE ${claim}`
        } else yield* sql`UPDATE actor_outbox SET due_at_ms = ${now + backoffMs} WHERE ${claim}`

        return undefined
      }

      if (stale) {
        yield* Effect.logInfo("Cron tick skipped").pipe(
          Effect.annotateLogs({ ...annotations, lateMs: now - scheduledAt }),
        )
        yield* rewrite(row, entry, claim)

        return undefined
      }

      if (row.command === entry.command) return { command: row.command, payload: row.payload }

      // An expression this deployment maps to another command delivers that
      // command on this claim, unless the tick already fired under its old one.
      const fired = yield* sql`SELECT 1 FROM actor_receipts
        WHERE routing_key = ${BigInt(row.routing_key)} AND tenant_id = ${row.tenant_id}
          AND actor_type = ${row.actor_type} AND actor_id = ${row.actor_id}
          AND command_id = ${row.intent_id}`

      if (fired.length > 0) {
        yield* rewrite(row, entry, claim)

        return undefined
      }

      return { command: entry.command, payload: yield* entry.payload }
    }),
    /** Replaces a delivered tick's row with the entry's next tick. */
    settleFired: (row: ClaimedTick, claim: Statement.Fragment) =>
      Effect.suspend(() => {
        const entry = entryOf(row)

        return entry === undefined
          ? sql`DELETE FROM actor_outbox WHERE ${claim}`.pipe(Effect.asVoid)
          : rewrite(row, entry, claim)
      }),
  }
}
