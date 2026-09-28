import { Crypto, Cron, Effect, Result, Schema, SchemaAST } from "effect"
import { SqlClient, type Statement } from "effect/unstable/sql"
import { type ActorRef, System } from "../../identity/caller.ts"
import type { AnyCommand } from "../../members/command.ts"
import { CRON_CALLER, CRON_PREFIX } from "./key.ts"
import { databaseTime } from "../turn/admission.ts"
import { bucketOf, CallerJson, OutboxRuntime } from "../turn/outbox.ts"

export { CRON_PREFIX }

/** One `policy.cron` entry: its tick's timer key, parsed schedule, and zero-input target. */
export interface CronEntry {
  readonly key: string
  readonly schedule: Cron.Cron
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

/**
 * Parses `policy.cron`. Expressions are Effect `Cron.parse` five- or six-field
 * strings evaluated in UTC; whitespace is normalized, so the timer key is the
 * same however an expression is spaced. Two expressions with the same
 * schedule, an unparsable expression, or a target that is not a zero-input
 * command of this actor throw.
 */
export const resolveCron = ({
  declared,
  commands,
}: {
  readonly declared: Readonly<Record<string, AnyCommand>> | undefined
  readonly commands: ReadonlyArray<AnyCommand>
}): ReadonlyArray<CronEntry> => {
  const entries: Array<CronEntry> = []

  for (const [expression, command] of Object.entries(declared ?? {})) {
    const parsed = Cron.parse(expression, "UTC")

    if (Result.isFailure(parsed))
      throw new Error(`policy.cron "${expression}" does not parse: ${parsed.failure.message}`)

    if (!commands.includes(command))
      throw new Error(`policy.cron "${expression}" must name a command of this actor`)

    if (!SchemaAST.isVoid(command.input.ast))
      throw new Error(`policy.cron "${expression}" must name a command without input`)

    const key = `${CRON_PREFIX}${canonicalOf(parsed.success)}`

    const duplicate = entries.find(
      (entry) => entry.key === key || Cron.Equivalence(entry.schedule, parsed.success),
    )

    if (duplicate !== undefined)
      throw new Error(
        `policy.cron "${expression}" repeats the schedule of "${duplicate.key.slice(CRON_PREFIX.length)}"`,
      )

    entries.push({
      key,
      schedule: parsed.success,
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

/** The first tick of `entry` strictly after `afterMs`. */
const nextTick = (entry: CronEntry, afterMs: number) => Cron.next(entry.schedule, afterMs).getTime()

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
 * tick, no-ops. An application timer staged under an entry's key before
 * `$cron:` was reserved gives the key up and stays due as a plain intent, so
 * it still fires once and the entry ticks from this write on.
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
    const dueAt = nextTick(entry, now)

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

  // A conflict with a cron row changes nothing and returns nothing. A conflict
  // with an application intent is a no-op update that returns that intent,
  // so the usual first turn, whose ticks are already pending, stays one statement.
  const legacy = (yield* sql<{ timer_key: string; intent_id: string }>`INSERT INTO actor_outbox AS o
      ${sql.insert(rows)}
      ON CONFLICT (routing_key, tenant_id, actor_type, actor_id, timer_key)
        WHERE timer_key IS NOT NULL
      DO UPDATE SET timer_key = o.timer_key WHERE strpos(o.caller, ${CRON_CALLER}) = 0
      RETURNING o.timer_key, o.intent_id`).filter(
    (row) => !rows.some((tick) => tick.intent_id === row.intent_id),
  )

  if (legacy.length === 0) return

  yield* sql`UPDATE actor_outbox SET timer_key = NULL
    WHERE routing_key = ${routingKey} AND intent_id IN ${sql.in(legacy.map((row) => row.intent_id))}`

  const freed = new Set(legacy.map((row) => row.timer_key))
  yield* sql`INSERT INTO actor_outbox ${sql.insert(rows.filter((row) => freed.has(row.timer_key)))}`
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
  readonly caller: string
  readonly timer_key: string | null
  readonly scheduled_at: string | null
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
    const dueAt = nextTick(entry, now)

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
    /** A tick is a `$cron:` row the runtime wrote, which names a cron caller. */
    isTick: (row: ClaimedTick) =>
      row.timer_key?.startsWith(CRON_PREFIX) === true && row.caller.includes(CRON_CALLER),
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
      const scheduledAt = Number(row.scheduled_at ?? row.claimed_until)
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
