import {
  Cause,
  Clock,
  Crypto,
  Deferred,
  Effect,
  Exit,
  FiberSet,
  Option,
  Queue,
  Random,
  Result,
  Schema,
  Semaphore,
} from "effect"
import { SqlClient, Statement } from "effect/unstable/sql"
import type { ActorError } from "../../errors/actor.ts"
import { Outcome, Request } from "../request.ts"
import { type RegisteredEffect } from "../registration.ts"
import { ActorRef, principal } from "../../identity/caller.ts"
import { progressPool } from "../effects/progress.ts"
import { CRON_PREFIX } from "../cron/key.ts"
import { type CronSchedule, cronTicks } from "../cron/schedule.ts"
import { TurnHooks } from "./hooks.ts"
import { count as tally, Metrics } from "../telemetry/metrics.ts"
import { SpanNames } from "../telemetry/spans.ts"
import { databaseTime, FrameworkClock } from "./admission.ts"
import { BUCKETS, CallerJson } from "./outbox.ts"
import type {
  Handoff,
  SubscriptionError,
  SubscriptionClaim,
  SubscriptionSlots,
  SubscriptionWork,
} from "../subscriptions/relay.ts"

/**
 * A drain whose deliveries keep staging due work after this many rounds, each
 * of which claimed every row then due, is a delivery loop.
 */
const DRAIN_ROUNDS = 100

/** The relay and executor pool settings of one runner, resolved from `Actors.layer`. */
export interface RelaySettings {
  /** Durable polling interval; each wait is jittered by ±10%. */
  readonly pollMs: number
  /** Intent rows claimed by one claim statement at most. */
  readonly passLimit: number
  /** Intents delivered at once on this runner. */
  readonly deliveryConcurrency: number
  /** How long a claimed intent stays out of every runner's scans. */
  readonly claimLeaseMs: () => number
  /** Cap on intent redelivery backoff. */
  readonly maxBackoffMs: number
  /** Effect attempts running at once on this runner. */
  readonly executorConcurrency: number
  /** An attempt's claim; renewed every third of it while the attempt runs. */
  readonly executorLeaseMs: number
  /** How long after its due time a relay-written command id stays retryable. */
  readonly retryWindowMs: number
  /**
   * How often a running attempt renews its claim and checks for a
   * cancellation committed on another runner; at most a third of the lease.
   */
  readonly cancelCheckMs?: number | undefined
}

/** An executor this runner has, by actor type and effect tag. */
interface LocalExecutor {
  readonly actor: string
  readonly effect: string
  readonly registered: RegisteredEffect
}

interface ClaimedRow {
  /**
   * `skipped-*` rows claim nothing; they report a probe whose candidates were
   * all taken or locked. A `work` row carries claimed subscription work in `work`.
   */
  readonly kind: "intent" | "effect" | "skipped-intent" | "skipped-effect" | "work"
  readonly routing_key: string
  readonly intent_id: string
  readonly attempts: number
  readonly last_error: string | null
  readonly ambiguous: boolean
  readonly tenant_id: string
  readonly actor_type: string
  readonly actor_id: string
  readonly target_type: string
  readonly target_id: string
  readonly command: string
  readonly payload: string
  /** The payload version of an effect row's `payload`; 0 for every other kind. */
  readonly payload_version: number
  readonly caller: string
  /** The claim's `due_at_ms`, which every settling write of an intent names. */
  readonly claimed_until: string
  readonly timer_key: string | null
  readonly scheduled_at: string
  /** Cancelled by a turn: settled with what is known, never attempted again. */
  readonly cancelled: boolean
  /** An earlier attempt of the effect may have applied the call. */
  readonly maybe_applied: boolean
  readonly candidates: number
  readonly work: string | null
}

interface ClaimedEffect extends ClaimedRow {
  readonly exhausted: boolean
}

/** The `ClaimedRow` columns of the outbox row aliased `o`. */
const claimedColumns = (sql: SqlClient.SqlClient) =>
  sql`o.kind, o.routing_key::text AS routing_key, o.intent_id, o.attempts, o.last_error,
    o.ambiguous, o.tenant_id, o.actor_type, o.actor_id, o.target_type, o.target_id, o.command,
    o.payload, o.payload_version, o.caller, o.due_at_ms::text AS claimed_until, o.timer_key,
    o.scheduled_at_ms::text AS scheduled_at, o.cancelled_at_ms IS NOT NULL AS cancelled,
    o.maybe_applied`

/**
 * The due-work probe: up to `limit` due rows of `kind` from one
 * `(bucket, kind, due_at_ms)` index range per bucket, so its cost follows due
 * rows of one kind, not stored actors or future timers. It takes no locks; a
 * claim locks only the rows it takes from it. `only` filters inside each
 * bucket's probe, so due rows the caller cannot claim never fill the
 * per-bucket limit ahead of rows it can.
 */
export const candidates = ({
  sql,
  kind,
  now,
  limit,
  only = sql.literal(""),
}: {
  readonly sql: SqlClient.SqlClient
  readonly kind: "intent" | "effect" | "feed" | "control"
  readonly now: Statement.Fragment
  readonly limit: number
  readonly only?: Statement.Fragment
}) =>
  sql`SELECT o.routing_key, o.intent_id, o.actor_type, o.command
    FROM generate_series(${BUCKETS.first}::int, ${BUCKETS.last}::int) AS b(bucket)
    CROSS JOIN LATERAL (
      SELECT routing_key, intent_id, due_at_ms, actor_type, command FROM actor_outbox
      WHERE actor_outbox.bucket = b.bucket AND actor_outbox.kind = ${kind}
        AND actor_outbox.due_at_ms <= ${now} ${only}
      ORDER BY actor_outbox.due_at_ms LIMIT ${limit}
    ) o`

/** Intents to claim in one statement: up to `limit` free delivery slots. */
export interface IntentClaim {
  readonly limit: number
  readonly leaseMs: number
  readonly maxBackoffMs: number
  /** Due candidates probed before locking; defaults to twice `limit`. */
  readonly probe?: number | undefined
  /** Actor types registered here; `$cron:` ticks of any other type are left for their runners. */
  readonly cronActors?: ReadonlyArray<string> | undefined
}

/** Effects to claim in one statement: up to `permits`, only for local executors. */
interface EffectClaim {
  readonly permits: number
  readonly leaseMs: number
  readonly executors: ReadonlyArray<LocalExecutor>
  /** Due candidates probed before locking; defaults to twice `permits`. */
  readonly probe?: number | undefined
}

/**
 * Claims due intents and due effects in one autocommit statement. `now` is
 * the outbox clock: the database's statement start time plus the test
 * offset, which is never earlier than a row committed before the claim was
 * sent. A pass therefore costs one round trip whatever it claims.
 *
 * `SKIP LOCKED` passes over rows another runner is claiming, and each claim
 * moves the row's `due_at_ms` past its lease, so no runner scans it again
 * until the lease ends. An intent whose settle dies therefore waits
 * `max(lease, backoff(attempts))` instead of sorting ahead of newer work. An
 * effect with no executor on this runner is never claimed here; it stays due
 * for a runner that has one. The two kinds never share a row, so the two
 * updates are disjoint. A kind that claims nothing although its probe found
 * candidates returns one `skipped-*` row with the candidate count, so the
 * relay can widen the next probe past rows other transactions hold locked.
 * Subscription work rides in the same statement, so a pass stays one round
 * trip.
 */
const claimDue = ({
  sql,
  now,
  intents,
  effects,
  subscriptions,
}: {
  readonly sql: SqlClient.SqlClient
  readonly now: Statement.Fragment
  readonly intents?: IntentClaim | undefined
  readonly effects?: EffectClaim | undefined
  readonly subscriptions?: SubscriptionClaim | undefined
}) => {
  const parts: Array<Statement.Fragment> = []
  const results: Array<Statement.Fragment> = []

  if (intents !== undefined) {
    const { limit, leaseMs, maxBackoffMs, probe = 2 * limit, cronActors = [] } = intents
    const local = cronActors.length === 0 ? sql`` : sql` OR actor_type IN ${sql.in(cronActors)}`
    parts.push(sql`intent_candidates AS (
        ${candidates({
          sql,
          kind: "intent",
          now,
          limit: probe,
          only: sql`AND (timer_key IS NULL OR left(timer_key, 6) <> ${CRON_PREFIX}${local})`,
        })}
        ORDER BY o.due_at_ms LIMIT ${probe}
      ),
      intent_locked AS (
        SELECT o.routing_key, o.intent_id FROM actor_outbox o
        JOIN intent_candidates USING (routing_key, intent_id)
        WHERE o.kind = 'intent' AND o.due_at_ms <= ${now}
        ORDER BY o.due_at_ms LIMIT ${limit}
        FOR UPDATE OF o SKIP LOCKED
      ),
      intent_claimed AS (
        UPDATE actor_outbox o SET attempts = o.attempts + 1,
          due_at_ms = ${now} + greatest(${leaseMs}::bigint,
            least(1000 * power(2, least(o.attempts, 31)), ${maxBackoffMs}::bigint))::bigint
        FROM intent_locked c
        WHERE o.routing_key = c.routing_key AND o.intent_id = c.intent_id
        RETURNING ${claimedColumns(sql)},
          (SELECT count(*) FROM intent_candidates)::int AS candidates, false AS exhausted,
          NULL::text AS work
      )`)
    results.push(sql`SELECT * FROM intent_claimed`, skipped(sql, "intent"))
  }

  if (effects !== undefined && effects.executors.length > 0) {
    const { permits, leaseMs, executors, probe = 2 * permits } = effects
    parts.push(sql`mine (actor_type, command, max_attempts) AS (
        VALUES ${sql.csv(
          executors.map(
            ({ actor, effect, registered }) =>
              sql`(${actor}::text, ${effect}::text, ${registered.attempts}::int)`,
          ),
        )}
      ),
      effect_candidates AS (
        ${candidates({
          sql,
          kind: "effect",
          now,
          limit: probe,
          only: sql.literal("AND (actor_type, command) IN (SELECT actor_type, command FROM mine)"),
        })}
        ORDER BY o.due_at_ms LIMIT ${probe}
      ),
      effect_locked AS (
        SELECT o.routing_key, o.intent_id, o.attempts AS previous, m.max_attempts
        FROM actor_outbox o
        JOIN effect_candidates USING (routing_key, intent_id)
        JOIN mine m ON m.actor_type = o.actor_type AND m.command = o.command
        WHERE o.kind = 'effect' AND o.due_at_ms <= ${now}
        ORDER BY o.due_at_ms LIMIT ${permits}
        FOR UPDATE OF o SKIP LOCKED
      ),
      effect_claimed AS (
        ${claimEffects(sql, now, leaseMs, sql`effect_locked`, sql`(SELECT count(*) FROM effect_candidates)::int`)}
      )`)
    results.push(sql`SELECT *, NULL::text AS work FROM effect_claimed`, skipped(sql, "effect"))
  }

  if (subscriptions !== undefined) {
    parts.push(...subscriptions.parts)

    for (const result of subscriptions.results)
      results.push(sql`SELECT 'work'::text, NULL::text, NULL::text, 0, NULL::text, false,
          NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, 0,
          NULL::text, NULL::text, NULL::text, NULL::text, false, false, 0, false,
          claimed.work
        FROM (${result}) AS claimed`)
  }

  if (results.length === 0) return Effect.succeed([] as ReadonlyArray<ClaimedEffect>)

  return sql<ClaimedEffect>`WITH ${sql.csv(parts)}
    ${sql.join(" UNION ALL ", false)(results)}`
}

/**
 * Claims the effect rows `locked` names. A cancelled row is claimed only to
 * be settled, so it keeps its attempts; any other row starts its next attempt
 * and runs, unless its last attempt already ended without an outcome or an
 * attempt's failure was final, either of which exhausts it. `maybe_applied`
 * then covers every attempt before this one.
 * RETURNING sees the updated row, so exhaustion is judged on the attempts
 * before this claim.
 */
const claimEffects = (
  sql: SqlClient.SqlClient,
  now: Statement.Fragment,
  leaseMs: number,
  locked: Statement.Fragment,
  candidateCount: Statement.Fragment,
) => {
  const attempting = sql`o.cancelled_at_ms IS NULL AND o.attempts < c.max_attempts
    AND NOT o.final_failure`

  return sql`UPDATE actor_outbox o SET
      due_at_ms = ${now} + ${leaseMs}::bigint,
      attempts = CASE WHEN ${attempting} THEN o.attempts + 1 ELSE o.attempts END,
      ambiguous = CASE WHEN ${attempting} THEN true ELSE o.ambiguous END,
      maybe_applied = CASE WHEN ${attempting}
        THEN o.maybe_applied OR (o.attempts > 0 AND o.ambiguous) ELSE o.maybe_applied END,
      last_error = CASE WHEN ${attempting}
        THEN 'Attempt ' || (o.attempts + 1) || ' ended without reporting an outcome'
        ELSE o.last_error END,
      running = ${attempting},
      waiting = false
    FROM ${locked} c
    WHERE o.routing_key = c.routing_key AND o.intent_id = c.intent_id
    RETURNING ${claimedColumns(sql)}, ${candidateCount} AS candidates,
      o.cancelled_at_ms IS NULL
        AND (c.previous >= c.max_attempts OR o.final_failure) AS exhausted`
}

/** One effect type of one actor whose attempts run under a per-actor cap. */
interface CappedGroup {
  readonly routing_key: string
  readonly tenant_id: string
  readonly actor_type: string
  readonly actor_id: string
  readonly command: string
}

/** A due group, with the due rows the probe read: at `limit` or more it may have hidden others. */
interface DueGroup extends CappedGroup {
  readonly due_rows: number
}

/**
 * The actors with due rows of capped effects this runner executes, oldest
 * first; at most `limit`. Like the uncapped probe, it reads one index range
 * per bucket and takes no locks.
 */
const cappedGroups = ({
  sql,
  now,
  executors,
  limit,
}: {
  readonly sql: SqlClient.SqlClient
  readonly now: Statement.Fragment
  readonly executors: ReadonlyArray<LocalExecutor>
  readonly limit: number
}) =>
  sql<DueGroup>`WITH mine (actor_type, command) AS (
      VALUES ${sql.csv(
        executors.map(({ actor, effect }) => sql`(${actor}::text, ${effect}::text)`),
      )}
    ),
    due AS (
      ${candidates({
        sql,
        kind: "effect",
        now,
        limit,
        only: sql.literal("AND (actor_type, command) IN (SELECT actor_type, command FROM mine)"),
      })}
    )
    SELECT o.routing_key::text AS routing_key, o.tenant_id, o.actor_type, o.actor_id, o.command,
      (SELECT count(*) FROM due)::int AS due_rows
    FROM actor_outbox o JOIN due USING (routing_key, intent_id)
    GROUP BY o.routing_key, o.tenant_id, o.actor_type, o.actor_id, o.command
    ORDER BY min(o.due_at_ms) LIMIT ${limit}`

const groupRow = (sql: SqlClient.SqlClient, group: CappedGroup) =>
  sql`o.routing_key = ${BigInt(group.routing_key)} AND o.tenant_id = ${group.tenant_id}
    AND o.actor_type = ${group.actor_type} AND o.actor_id = ${group.actor_id}
    AND o.command = ${group.command} AND o.kind = 'effect'`

/** The advisory lock that serializes every runner's claims of one capped group. */
const groupLock = (sql: SqlClient.SqlClient, group: CappedGroup) =>
  sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
    group.tenant_id,
    group.actor_type,
    group.actor_id,
    group.command,
  ])}, 0))`

/**
 * Claims one capped group's effects in its own transaction, under the
 * group's advisory lock, so claims on every runner see each other's running
 * rows. It settles cancelled rows whose attempt ended, starts the oldest rows
 * by `(ready_at_ms, intent_id)` while fewer than `cap` attempts hold a live
 * lease, and moves the group's other due rows out of the due range as
 * waiting, so they never fill a probe ahead of other actors' work. A waiting
 * row becomes due again when an attempt of its group settles, or after one
 * lease.
 */
const claimCapped = ({
  sql,
  now,
  group,
  cap,
  maxAttempts,
  permits,
  leaseMs,
}: {
  readonly sql: SqlClient.SqlClient
  readonly now: Statement.Fragment
  readonly group: CappedGroup
  readonly cap: number
  readonly maxAttempts: number
  readonly permits: number
  readonly leaseMs: number
}) =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* groupLock(sql, group)
      const inGroup = groupRow(sql, group)

      return yield* sql<ClaimedEffect>`WITH live AS (
          SELECT count(*)::int AS n FROM actor_outbox o
          WHERE ${inGroup} AND o.running AND o.due_at_ms > ${now}
        ),
        settle AS (
          SELECT o.routing_key, o.intent_id, o.attempts AS previous, ${maxAttempts}::int AS max_attempts
          FROM actor_outbox o
          WHERE ${inGroup} AND o.cancelled_at_ms IS NOT NULL AND o.due_at_ms <= ${now}
          ORDER BY o.due_at_ms, o.intent_id
          LIMIT ${permits}::int
          FOR UPDATE OF o SKIP LOCKED
        ),
        next AS (
          SELECT o.routing_key, o.intent_id, o.attempts AS previous, ${maxAttempts}::int AS max_attempts
          FROM actor_outbox o
          WHERE ${inGroup} AND o.cancelled_at_ms IS NULL
            AND (o.due_at_ms <= ${now} OR (o.waiting AND NOT o.running))
          ORDER BY o.ready_at_ms, o.intent_id
          LIMIT greatest(0, least(${cap}::int - (SELECT n FROM live),
            ${permits}::int - (SELECT count(*)::int FROM settle)))
          FOR UPDATE OF o SKIP LOCKED
        ),
        locked AS (SELECT * FROM settle UNION ALL SELECT * FROM next),
        claimed AS (${claimEffects(sql, now, leaseMs, sql`locked`, sql`0`)}),
        deferred AS (
          UPDATE actor_outbox o SET waiting = true, running = false,
            due_at_ms = ${now} + ${leaseMs}::bigint
          WHERE ${inGroup} AND o.cancelled_at_ms IS NULL AND o.due_at_ms <= ${now}
            AND o.intent_id NOT IN (SELECT intent_id FROM next)
            AND o.intent_id IN (
              SELECT o.intent_id FROM actor_outbox o
              WHERE ${inGroup} AND o.cancelled_at_ms IS NULL AND o.due_at_ms <= ${now}
              FOR UPDATE OF o SKIP LOCKED
            )
          RETURNING 1
        )
        SELECT * FROM claimed`
    }),
  )

/**
 * Makes the oldest waiting row of `group` due now, after one of its attempts
 * settled. It takes the group's lock like a claim, so it never overlaps one:
 * a claim's `SKIP LOCKED` would pass over the row this update holds and start
 * a younger row ahead of it, breaking perform order. The lock also means no
 * claim is taking the row while the update reads it. The outer guard refuses
 * a row that is running by the time the update reaches it, so a wake never
 * moves a claimed attempt's lease end to now, which would stop the cap
 * counting an attempt that still runs.
 */
export const wakeWaiting = ({
  sql,
  group,
  at,
}: {
  readonly sql: SqlClient.SqlClient
  readonly group: CappedGroup
  readonly at: number
}) =>
  sql.withTransaction(
    Effect.andThen(
      groupLock(sql, group),
      sql`UPDATE actor_outbox SET due_at_ms = least(due_at_ms, ${at}), waiting = false
        WHERE waiting AND NOT running AND cancelled_at_ms IS NULL
          AND (routing_key, intent_id) IN (
            SELECT o.routing_key, o.intent_id FROM actor_outbox o
            WHERE ${groupRow(sql, group)} AND o.waiting AND NOT o.running
              AND o.cancelled_at_ms IS NULL
            ORDER BY o.ready_at_ms, o.intent_id LIMIT 1
            FOR UPDATE OF o SKIP LOCKED
          ) RETURNING 1`,
    ),
  )

/** One row reporting `kind`'s candidates when its claim took none of them. */
const skipped = (sql: SqlClient.SqlClient, kind: "intent" | "effect") => {
  const claimed = sql.literal(`${kind}_claimed`)
  const found = sql.literal(`${kind}_candidates`)

  return sql`SELECT ${`skipped-${kind}`}::text, NULL, NULL, 0, NULL, false, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, false, false, (SELECT count(*) FROM ${found})::int,
      false, NULL::text
    WHERE NOT EXISTS (SELECT 1 FROM ${claimed}) AND EXISTS (SELECT 1 FROM ${found})`
}

/** The outbox clock inside a statement: its start time on the database plus the test offset. */
export const outboxNow = ({
  sql,
  offsetMillis,
}: {
  readonly sql: SqlClient.SqlClient
  readonly offsetMillis: number
}) =>
  sql`(floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint + ${offsetMillis}::bigint)`

/** The intent half of `claimDue` at a fixed `now`, as a statement to inspect. */
export const claimIntents = ({
  sql,
  now,
  ...intents
}: IntentClaim & { readonly sql: SqlClient.SqlClient; readonly now: number }) =>
  claimDue({
    sql,
    now: sql`${now}::bigint`,
    intents,
  }) as Statement.Statement<ClaimedEffect>

/** The widest probe, as a multiple of twice the free capacity. */
const MAX_WIDEN = 64

/**
 * The next probe multiple: doubled when a claim left capacity free although
 * it found more due candidates than it took, which happens when other
 * transactions hold the earliest rows locked; reset otherwise.
 */
const widened = (
  current: number,
  rows: ReadonlyArray<ClaimedRow>,
  kind: "intent" | "effect",
  capacity: number,
) => {
  const taken = rows.filter((row) => row.kind === kind)
  const found = (taken[0] ?? rows.find((row) => row.kind === `skipped-${kind}`))?.candidates ?? 0

  return taken.length < capacity && found > taken.length ? Math.min(current * 2, MAX_WIDEN) : 1
}

/** Logs a non-interrupt failure of the effect under `message` and completes with `void`; an interruption stays one. */
const logFailure =
  (message: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A | void, never, R> =>
    Effect.catchCause(self, (cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.logError(message, cause),
    )

/**
 * The outbox relay of one runner among any number sharing the database. Each
 * pass claims only as many due intents as it has free delivery slots and only
 * as many effects as its executor pool has permits, then starts each one at
 * once, so no claimed row waits locally while its lease runs down. A pass runs
 * uninterruptibly under a lock so every row a claim returns reaches a fiber
 * that can release it. A claim that saw more due candidates than it took
 * makes each freed slot claim again instead of waiting for the poll, and one
 * that left capacity free although it found more candidates doubles the next
 * probe. When both capped and uncapped effects are due, passes alternate which
 * claims first, so a steady stream of either can't take every permit.
 *
 * An intent is delivered as a direct command whose command id is the intent
 * id, and its row is deleted only after the receiver's receipt has committed.
 * A crash leaves the claim in place until its lease ends; any runner then
 * redelivers, and the receipt deduplicates. A row that cannot form a request,
 * a delivery that fails, and a defect outcome back off and retry with no retry
 * limit; the logged warning and `attempts` are the operator signal. A declared
 * failure is a committed receipt, so only a missing receipt retries. An
 * interrupted delivery makes its row due at once.
 *
 * An effect attempt runs on the pool, outside the pass, and renews its claim
 * every `cancelCheckMs` (at most a third of the lease) while it runs, which
 * also picks up a cancellation committed on another runner; a local one
 * signals the attempt directly. The lease is measured on this runner from when
 * the last claim or renewal was sent, so the database's lease can only end
 * later, and an attempt that outlives it is interrupted, or never started,
 * since another runner may hold the row and a started call can't be undone. A
 * failed renewal retries at the next interval, and a renewal never shortens a
 * deadline, so it can't undo a test clock's lease shift. The attempt is raced
 * against its renewals, which are stopped and awaited before any settling
 * write, so a late renewal can't overwrite a failure's backoff with a fresh
 * lease.
 *
 * The first success of any attempt turns the row into an intent to its
 * `onSuccess` route; exhausting retries turns it into one to `onDeadLetter`.
 * The route is then delivered like any intent, so it commits once per effect
 * id however often the executor ran. A success of a capped effect waits while
 * a newer attempt's lease is live, so it does not free the slot early, and a
 * settled attempt of a capped effect wakes the oldest waiting row of its
 * actor. Failures and dead letters name the attempt they settle, so a stale
 * attempt changes nothing, and a failure is recorded before its dead letter so
 * a failed dead-letter transaction is retried with this attempt's cause. A
 * final failure is never followed by another attempt. An attempt that never
 * started applied nothing, so the row stays as ambiguous as its earlier
 * attempts left it (`maybe_applied`). A running attempt is registered before
 * the pass releases its lock and until its outcome is written, so every clock
 * jump after the claim moves its lease. A committed terminal settle closes the
 * effect's progress; a retryable one leaves it open. A dead letter is recorded
 * even when its row's request is unreadable, since only the fault hook needs
 * the request.
 *
 * A cancelled effect is claimed only to be settled, with what is known: `Failed`
 * only when no attempt can have applied the call, otherwise `Unknown`,
 * because interrupting a started call does not undo it. A result `onSuccess`
 * rejects still reaches `onCancelled` if the effect was cancelled, and a
 * success that lands after the row was cancelled is reported as the
 * cancellation's outcome. A success no settle matched is recorded as an
 * ambiguous dead letter instead of routing a second outcome. A dead letter
 * that loses to a cancellation settles the row as cancelled instead.
 *
 * Subscription work runs in its own slots, so a subscription backlog never
 * delays intents, timers, or effects; expansion work starts the rows it leased
 * without a claim pass; `schedules` names the cron actors whose ticks this
 * runner claims. The returned handle: `run` loops passes on a jittered
 * poll and `wake`; `drain` waits for in-flight work, which may stage more,
 * then claims again until a claim finds nothing while nothing was running
 * (work runs only on fibers a pass starts, so none running means nothing can
 * stage rows after that claim read), failing if deliveries keep staging due
 * work, and counting toward that limit only rounds that drained every due row; `stop` ends claims and
 * interrupts deliveries at once, since a delivery only waits on a turn its
 * receiver's owner finishes or rolls back on its own, and the receiver's
 * receipt answers a redelivery of work that did commit; `interruptAttempts`
 * interrupts running attempts and returns how many, leaving their claims and
 * `ambiguous` marks because the provider may have applied the call, so another
 * runner takes the effect over once the lease ends; `attemptsIdle` waits for
 * attempts to end; `extendLeases` moves running attempts' leases with a jump of
 * the outbox clock, as the renewals during that time would have, holding the
 * pass lock so no claim reads the clock between the moved leases and the jump;
 * `cancelled` makes running attempts check for cancellation now. Closing the
 * scope stops further claims, after taking the lock so a pass in progress hands
 * its rows to fibers first and they are interrupted and released.
 */
export const outboxRelay = Effect.fnUntraced(function* (
  deliver: (request: Request) => Effect.Effect<Outcome, ActorError>,
  executors: () => ReadonlyArray<LocalExecutor>,
  settings: RelaySettings,
  subscriptions?: {
    /** Feed, control, and subscription-delivery slots, each; separate from intent slots. */
    readonly concurrency: number
    readonly claim: (slots: SubscriptionSlots) => SubscriptionClaim | undefined
    readonly decode: (work: string) => Effect.Effect<SubscriptionWork>
    readonly run: (
      work: SubscriptionWork,
      handoff: Handoff,
    ) => Effect.Effect<void, SubscriptionError>
  },
  schedules: () => ReadonlyMap<string, CronSchedule> = () => new Map(),
) {
  const sql = yield* SqlClient.SqlClient
  const services = yield* Effect.context<SqlClient.SqlClient>()
  const lock = Semaphore.makeUnsafe(1)
  const signals = yield* Queue.sliding<void>(1)
  const deliveries = yield* FiberSet.make<unknown, unknown>()
  const attempts = yield* FiberSet.make<unknown, unknown>()

  const subscriptionWork = {
    feed: yield* FiberSet.make<unknown, unknown>(),
    control: yield* FiberSet.make<unknown, unknown>(),
    subscription: yield* FiberSet.make<unknown, unknown>(),
  }

  const hooks = yield* TurnHooks
  const progress = yield* progressPool()
  const ended = new Set<string>()

  const ticks = cronTicks({
    sql,
    crypto: yield* Crypto.Crypto,
    schedules,
    retryWindowMs: settings.retryWindowMs,
  })

  const startWork = (work: SubscriptionWork): Effect.Effect<void> =>
    subscriptions === undefined
      ? Effect.void
      : FiberSet.run(
          subscriptionWork[work.kind],
          subscriptions
            .run(work, handoff)
            .pipe(
              logFailure("Subscription relay work failed"),
              Effect.ensuring(freed("subscriptions")),
            ),
        ).pipe(Effect.asVoid)

  const handoff: Handoff = {
    free: Effect.map(
      FiberSet.size(subscriptionWork.subscription),
      (running) => (subscriptions?.concurrency ?? 0) - running,
    ),
    start: startWork,
  }

  const more = { intents: false, effects: false, subscriptions: false }
  let cappedTurn = false
  const widen = { intents: 1, effects: 1 }
  let stopping = false

  const running = new Map<
    string,
    {
      readonly routingKey: bigint
      readonly attempt: number
      readonly lease: { until: number }
    }
  >()

  const backoffMs = (attempts: number) =>
    Math.min(1000 * 2 ** Math.max(attempts - 1, 0), settings.maxBackoffMs)

  const requestOf = (row: ClaimedRow, target: "receiver" | "sender") =>
    Schema.decodeEffect(CallerJson)(row.caller).pipe(
      Effect.flatMap((caller) =>
        Schema.decodeEffect(Request)({
          ref:
            target === "receiver"
              ? {
                  tenant: row.tenant_id,
                  actor: row.target_type,
                  id: row.target_id,
                }
              : {
                  tenant: row.tenant_id,
                  actor: row.actor_type,
                  id: row.actor_id,
                },
          caller,
          command: row.command,
          commandId: row.intent_id,
          payload: row.payload,
        }),
      ),
    )

  const deliverIntent = Effect.fnUntraced(function* (row: ClaimedRow) {
    const routingKey = BigInt(row.routing_key)

    const claim = sql`routing_key = ${routingKey} AND intent_id = ${row.intent_id}
      AND kind = 'intent' AND due_at_ms = ${BigInt(row.claimed_until)}`

    const retryLater = (reason: string, cause: unknown) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("Outbox delivery failed; retrying with backoff", cause).pipe(
          Effect.annotateLogs({
            actor: row.target_type,
            id: row.target_id,
            tenant: row.tenant_id,
            command: row.command,
            commandId: row.intent_id,
            reason,
          }),
        )
        yield* sql`UPDATE actor_outbox SET due_at_ms = ${(yield* databaseTime) + backoffMs(row.attempts)}
          WHERE ${claim}`
        yield* tally(Metrics.relayRetried, { kind: "intent" }, 1)
      })

    return yield* Effect.gen(function* () {
      const tick = ticks.isTick(row)
      const route = tick ? yield* ticks.settleUnfired(row, claim, backoffMs(row.attempts)) : row

      if (route === undefined) return

      const decoded = yield* requestOf({ ...row, ...route }, "receiver").pipe(Effect.result)

      if (Result.isFailure(decoded)) return yield* retryLater("UnreadableRow", decoded.failure)

      const request = decoded.success
      yield* hooks.at("afterClaim", request)

      const delivered = yield* deliver(request).pipe(Effect.result)

      if (Result.isFailure(delivered))
        return yield* retryLater(delivered.failure.reason._tag, delivered.failure)

      if (Outcome.guards.Defect(delivered.success))
        return yield* retryLater("Defect", delivered.success.cause)

      yield* hooks.at("beforeOutboxDelete", request)

      if (tick) yield* ticks.settleFired(row, claim)
      else yield* sql`DELETE FROM actor_outbox WHERE ${claim}`

      yield* tally(Metrics.relayDelivered, { kind: "intent" }, 1)
    }).pipe(
      Effect.withSpan(
        SpanNames.relayIntent,
        {
          kind: "producer",
          attributes: {
            "actor.type": row.target_type,
            "actor.tenant": row.tenant_id,
            "actor.id": row.target_id,
            "command.name": row.command,
            "command.id": row.intent_id,
            "relay.attempt": row.attempts,
            "relay.timer": row.timer_key !== null,
          },
        },
        { captureStackTrace: false },
      ),
      Effect.onInterrupt(() =>
        Effect.gen(function* () {
          yield* sql`UPDATE actor_outbox SET due_at_ms = ${yield* databaseTime} WHERE ${claim}`
        }).pipe(Effect.ignore),
      ),
    )
  })

  let cancelChecks = Deferred.makeUnsafe<void>()

  const cancelled = Effect.sync(() => {
    const previous = cancelChecks
    cancelChecks = Deferred.makeUnsafe<void>()
    Deferred.doneUnsafe(previous, Exit.void)
  })

  const renewEveryMs = Math.min(
    settings.cancelCheckMs ?? settings.executorLeaseMs / 3,
    settings.executorLeaseMs / 3,
  )

  const groupOf = (row: ClaimedRow): CappedGroup => ({
    routing_key: row.routing_key,
    tenant_id: row.tenant_id,
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    command: row.command,
  })

  const runAttempt = Effect.fnUntraced(function* (
    row: ClaimedEffect,
    registered: RegisteredEffect,
    claimedAt: bigint,
    claimSignal: Deferred.Deferred<void>,
  ) {
    const routingKey = BigInt(row.routing_key)

    const annotate = Effect.annotateLogs({
      actor: row.actor_type,
      id: row.actor_id,
      tenant: row.tenant_id,
      effect: row.command,
      effectId: row.intent_id,
    })

    const effectRow = sql`routing_key = ${routingKey} AND intent_id = ${row.intent_id}
      AND kind = 'effect'`

    const attemptRow = (attempts: number) => sql`${effectRow} AND attempts = ${attempts}`

    const settleTo = (
      route: { readonly command: string; readonly payload: string } | undefined,
      guard: typeof effectRow,
    ) =>
      Effect.gen(function* () {
        const at = yield* databaseTime

        const settled =
          route === undefined
            ? yield* sql`DELETE FROM actor_outbox WHERE ${guard} RETURNING 1`
            : yield* sql`UPDATE actor_outbox SET kind = 'intent', command = ${route.command},
                payload = ${route.payload}, payload_version = 0, due_at_ms = ${at}, scheduled_at_ms = ${at},
                attempts = 0, last_error = NULL, ambiguous = false, running = false,
                timer_key = NULL
              WHERE ${guard} RETURNING 1`

        if (route !== undefined && settled.length > 0) yield* Queue.offer(signals, undefined)

        if (settled.length > 0) ended.add(row.intent_id)

        return settled.length > 0
      })

    const exhaust = (attempts: number, cause: string, ambiguous: boolean, cancelled: boolean) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const letter = {
            effectId: row.intent_id,
            attempts,
            cause,
            ambiguous,
          }

          if (
            !(yield* settleTo(
              yield* registered.deadLetter(row.payload, row.payload_version, letter),
              sql`${attemptRow(attempts)} AND cancelled_at_ms IS ${sql.literal(
                cancelled ? "NOT NULL" : "NULL",
              )}`,
            ))
          )
            return false

          yield* Effect.logWarning("Effect dead-lettered after its last attempt", cause).pipe(
            annotate,
          )
          yield* tally(Metrics.deadLetters, { actor_type: row.actor_type, effect: row.command }, 1)
          yield* sql`INSERT INTO actor_dead_letters (routing_key, effect_id, tenant_id, actor_type,
              actor_id, effect, payload, payload_version, attempts, cause, ambiguous, dead_at_ms)
            VALUES (${routingKey}, ${row.intent_id}, ${row.tenant_id}, ${row.actor_type},
              ${row.actor_id}, ${row.command}, ${row.payload}, ${row.payload_version}, ${attempts},
              ${cause}, ${ambiguous}, ${yield* databaseTime})`

          const request = yield* requestOf(row, "sender").pipe(Effect.option)

          if (Option.isSome(request)) yield* hooks.at("beforeDeadLetterCommit", request.value)

          return true
        }),
      )

    /**
     * Settles a cancelled effect that has no result. It is `Failed` only when
     * no attempt can have applied the call; otherwise `Unknown`. Without an
     * `onCancelled` route, an unknown outcome is dead-lettered as ambiguous
     * and a failed one is dropped with a log line.
     */
    const settleCancelled = (attempts: number, known: "Failed" | "Unknown", cause: string) =>
      Effect.gen(function* () {
        const guard = sql`${attemptRow(attempts)} AND cancelled_at_ms IS NOT NULL`
        const ambiguous = known === "Unknown"

        if (registered.routesCancelled) {
          const route = yield* registered.cancelled(row.payload, row.payload_version, {
            effectId: row.intent_id,
            attempts,
            outcome: { _tag: known, cause },
            ambiguous,
          })

          if (route !== undefined) return yield* settleTo(route, guard)
        }

        if (ambiguous) return yield* exhaust(attempts, cause, true, true)

        const dropped = yield* settleTo(undefined, guard)

        if (dropped)
          yield* Effect.logInfo("Cancelled effect dropped after a failed attempt", cause).pipe(
            Effect.annotateLogs({ attempt: attempts }),
            annotate,
          )

        return dropped
      })

    const cancelledCause = (attempts: number) =>
      `Cancelled while attempt ${attempts} was running; the provider may have applied it`

    const exhaustUnlessCancelled = (attempts: number, cause: string, ambiguous: boolean) =>
      Effect.gen(function* () {
        if (yield* exhaust(attempts, cause, ambiguous, false)) return

        const [cancelled] = yield* sql<{ maybe_applied: boolean }>`SELECT maybe_applied
          FROM actor_outbox WHERE ${attemptRow(attempts)} AND cancelled_at_ms IS NOT NULL`

        if (cancelled !== undefined)
          yield* settleCancelled(
            attempts,
            ambiguous || cancelled.maybe_applied ? "Unknown" : "Failed",
            cause,
          )
      })

    if (row.cancelled) {
      if (row.attempts === 0) return yield* settleTo(undefined, sql`${attemptRow(0)}`)

      return yield* settleCancelled(
        row.attempts,
        row.ambiguous || row.maybe_applied ? "Unknown" : "Failed",
        row.ambiguous || row.maybe_applied
          ? (row.last_error ?? cancelledCause(row.attempts))
          : (row.last_error ?? "Failed before it was cancelled"),
      )
    }

    if (row.exhausted)
      return yield* exhaustUnlessCancelled(
        row.attempts,
        row.last_error ?? "No attempt reported",
        row.ambiguous,
      )

    const attempt = row.attempts
    const request = yield* requestOf(row, "sender").pipe(Effect.orDie)
    const ref = ActorRef.make(request.ref)
    const lease = running.get(row.intent_id)?.lease ?? { until: Number(row.claimed_until) }
    const leaseNanos = BigInt(settings.executorLeaseMs) * 1_000_000n
    let confirmed = claimedAt

    yield* hooks.at("afterClaim", request)
    yield* hooks.at("beforeExecute", request)

    if ((yield* Clock.currentTimeNanos) - confirmed >= leaseNanos)
      return yield* Effect.logWarning("Effect attempt outlived its lease before it started").pipe(
        Effect.annotateLogs({ attempt }),
        annotate,
      )

    let signal = claimSignal

    const renewals = Effect.gen(function* () {
      while (true) {
        yield* Deferred.await(signal).pipe(
          Effect.timeoutOrElse({ duration: renewEveryMs, orElse: () => Effect.void }),
        )
        signal = cancelChecks
        const sent = yield* Clock.currentTimeNanos

        const renewed = yield* Effect.gen(function* () {
          yield* hooks.at("beforeRenew", request)

          return yield* sql<{ cancelled: boolean; due_at_ms: string }>`UPDATE actor_outbox
              SET due_at_ms = greatest(due_at_ms, ${(yield* databaseTime) + settings.executorLeaseMs})
              WHERE ${attemptRow(attempt)}
              RETURNING cancelled_at_ms IS NOT NULL AS cancelled, due_at_ms::text AS due_at_ms`.pipe(
            Effect.uninterruptible,
          )
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("Effect lease renewal failed", cause).pipe(
                  annotate,
                  Effect.as(undefined),
                ),
          ),
        )

        if (renewed === undefined) continue

        if (renewed.length === 0) return "lost" as const
        confirmed = sent
        lease.until = Number(renewed[0]!.due_at_ms)

        if (renewed[0]!.cancelled) return "cancelled" as const
      }
    })

    const deadline = Effect.gen(function* () {
      while (true) {
        const left = confirmed + leaseNanos - (yield* Clock.currentTimeNanos)

        if (left <= 0n) return "deadline" as const
        yield* Effect.sleep(Number(left / 1_000_000n) + 1)
      }
    })

    const slot = yield* progress.open({
      ref,
      effectId: row.intent_id,
      effect: row.command,
      attempt,
      everyMs: registered.progressEveryMs,
      leaseUntil: () => lease.until,
    })

    return yield* Effect.gen(function* () {
      const outcome = yield* registered
        .execute(row.payload, row.payload_version, {
          effectId: row.intent_id,
          attempt,
          principal: principal(request.caller),
          ref,
          reporting: slot.active,
          report: slot.offer,
        })
        .pipe(
          Effect.withSpan(
            SpanNames.effect(row.actor_type, row.command),
            {
              kind: "client",
              attributes: {
                "actor.type": row.actor_type,
                "actor.tenant": row.tenant_id,
                "actor.id": row.actor_id,
                "effect.name": row.command,
                "effect.id": row.intent_id,
                "effect.attempt": attempt,
              },
            },
            { captureStackTrace: false },
          ),
          Effect.result,
          Effect.raceFirst(renewals),
          Effect.raceFirst(deadline),
          Effect.ensuring(slot.close),
        )

      if (outcome === "lost")
        return yield* Effect.logWarning("Effect attempt lost its lease").pipe(
          Effect.annotateLogs({ attempt }),
          annotate,
        )

      if (outcome === "deadline")
        return yield* Effect.logWarning("Effect attempt outlived its lease; interrupted").pipe(
          Effect.annotateLogs({ attempt }),
          annotate,
        )

      if (outcome === "cancelled") {
        yield* Effect.logInfo("Effect attempt interrupted by its cancellation").pipe(
          Effect.annotateLogs({ attempt }),
          annotate,
        )

        return yield* settleCancelled(attempt, "Unknown", cancelledCause(attempt))
      }

      const recordLate = (routes: {
        readonly cancelled?: { readonly command: string } | undefined
      }) =>
        Effect.gen(function* () {
          const late = yield* sql`UPDATE actor_dead_letters SET ambiguous = true
          WHERE routing_key = ${routingKey} AND effect_id = ${row.intent_id} RETURNING 1`

          if (late.length > 0)
            return yield* Effect.logWarning("Effect succeeded after it was dead-lettered").pipe(
              Effect.annotateLogs({ attempt }),
              annotate,
            )

          const reported = routes.cancelled?.command

          if (registered.routesCancelled && reported !== undefined) {
            const recorded = yield* sql`INSERT INTO actor_dead_letters (routing_key, effect_id,
              tenant_id, actor_type, actor_id, effect, payload, payload_version, attempts, cause,
              ambiguous, dead_at_ms)
            SELECT ${routingKey}, ${row.intent_id}, ${row.tenant_id}, ${row.actor_type},
              ${row.actor_id}, ${row.command}, ${row.payload}, ${row.payload_version}, ${attempt},
              'Succeeded after it was cancelled', true, ${yield* databaseTime}
            WHERE EXISTS (
              SELECT 1 FROM actor_outbox WHERE ${sql`routing_key = ${routingKey}`}
                AND intent_id = ${row.intent_id} AND kind = 'intent' AND command = ${reported}
              UNION ALL
              SELECT 1 FROM actor_receipts WHERE routing_key = ${routingKey}
                AND tenant_id = ${row.tenant_id} AND actor_type = ${row.actor_type}
                AND actor_id = ${row.actor_id} AND command_id = ${row.intent_id}
                AND command = ${reported}
            )
            ON CONFLICT (routing_key, effect_id) DO UPDATE SET ambiguous = true
            RETURNING 1`

            if (recorded.length > 0)
              yield* Effect.logWarning("Effect succeeded after its cancellation settled").pipe(
                Effect.annotateLogs({ attempt }),
                annotate,
              )
          }
        })

      const settleSuccess = (
        route: { readonly command: string; readonly payload: string } | undefined,
        guard: typeof effectRow,
      ) =>
        registered.perActor === undefined
          ? settleTo(route, guard)
          : Effect.gen(function* () {
              while (true) {
                const newer = (at: number) =>
                  sql`(attempts > ${attempt} AND running AND due_at_ms > ${at})`

                if (yield* settleTo(route, sql`${guard} AND NOT ${newer(yield* databaseTime)}`))
                  return true

                const held = yield* sql<{ live: boolean }>`SELECT ${newer(
                  yield* databaseTime,
                )} AS live FROM actor_outbox WHERE ${guard}`

                if (held.length === 0) return false

                if (held[0]!.live) yield* Effect.sleep(renewEveryMs)
              }
            })

      const rejected = Result.isSuccess(outcome) ? outcome.success.rejected : undefined

      if (rejected !== undefined && registered.routesCancelled && Result.isSuccess(outcome)) {
        yield* hooks.at("afterExecute", request)

        if (
          yield* settleSuccess(
            outcome.success.cancelled,
            sql`${effectRow} AND cancelled_at_ms IS NOT NULL`,
          )
        )
          return
      }

      if (Result.isSuccess(outcome) && rejected === undefined) {
        yield* hooks.at("afterExecute", request)
        const routes = outcome.success

        if (yield* settleSuccess(routes.success, sql`${effectRow} AND cancelled_at_ms IS NULL`))
          return yield* tally(Metrics.relayDelivered, { kind: "effect" }, 1)

        if (
          yield* settleSuccess(
            registered.routesCancelled ? routes.cancelled : routes.success,
            sql`${effectRow} AND cancelled_at_ms IS NOT NULL`,
          )
        )
          return

        return yield* recordLate(routes)
      }

      const failure = Result.isFailure(outcome) ? outcome.failure : rejected

      if (failure === undefined) return

      const { cause, final, notStarted } = failure
      const last = final === true || attempt >= registered.attempts
      const { baseMs, maxMs } = registered.backoff

      const recorded = yield* sql<{
        cancelled: boolean
        maybe_applied: boolean
        ambiguous: boolean
      }>`UPDATE actor_outbox
        SET last_error = ${cause},
          ambiguous = ${notStarted === true ? sql`maybe_applied` : sql`${failure.ambiguous}`},
          running = false, final_failure = ${final === true},
          due_at_ms = ${(yield* databaseTime) + Math.min(baseMs * 2 ** (attempt - 1), maxMs)}
        WHERE ${attemptRow(attempt)}
        RETURNING cancelled_at_ms IS NOT NULL AS cancelled, maybe_applied, ambiguous`

      const ambiguous = recorded[0]?.ambiguous ?? failure.ambiguous

      if (recorded.length === 0 && rejected !== undefined && Result.isSuccess(outcome))
        return yield* recordLate(outcome.success)

      if (
        recorded[0]?.cancelled === true &&
        rejected !== undefined &&
        registered.routesCancelled &&
        Result.isSuccess(outcome) &&
        (yield* settleTo(
          outcome.success.cancelled,
          sql`${attemptRow(attempt)} AND cancelled_at_ms IS NOT NULL`,
        ))
      )
        return

      if (recorded[0]?.cancelled === true)
        return yield* settleCancelled(
          attempt,
          ambiguous || recorded[0].maybe_applied ? "Unknown" : "Failed",
          cause,
        )

      if (last) return yield* exhaustUnlessCancelled(attempt, cause, ambiguous)

      yield* Effect.logWarning("Effect attempt failed; retrying with backoff", cause).pipe(
        Effect.annotateLogs({ attempt, ambiguous }),
        annotate,
      )
      yield* tally(Metrics.relayRetried, { kind: "effect" }, 1)
    }).pipe(Effect.ensuring(progress.forget(row.intent_id)))
  })

  const settleAttempt = (
    row: ClaimedEffect,
    registered: RegisteredEffect,
    claimedAt: bigint,
    claimSignal: Deferred.Deferred<void>,
  ) => {
    const attempt = runAttempt(row, registered, claimedAt, claimSignal).pipe(
      Effect.tap(() =>
        ended.delete(row.intent_id)
          ? requestOf(row, "sender").pipe(
              Effect.flatMap((request) =>
                progress.closed({
                  ref: ActorRef.make(request.ref),
                  effectId: row.intent_id,
                  effect: row.command,
                  attempt: row.attempts,
                  everyMs: registered.progressEveryMs,
                }),
              ),
              Effect.ignore,
            )
          : Effect.void,
      ),
      Effect.ensuring(Effect.sync(() => ended.delete(row.intent_id))),
    )

    return registered.perActor === undefined
      ? attempt
      : attempt.pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              const woke = yield* wakeWaiting({ sql, group: groupOf(row), at: yield* databaseTime })

              if (woke.length > 0) yield* Queue.offer(signals, undefined)
            }).pipe(Effect.ignore),
          ),
        )
  }

  const freed = (kind: "intents" | "effects" | "subscriptions") =>
    Effect.suspend(() => (more[kind] ? Queue.offer(signals, undefined) : Effect.void))

  const inFlight = Effect.gen(function* () {
    return (
      (yield* FiberSet.size(deliveries)) +
      (yield* FiberSet.size(attempts)) +
      (yield* FiberSet.size(subscriptionWork.feed)) +
      (yield* FiberSet.size(subscriptionWork.control)) +
      (yield* FiberSet.size(subscriptionWork.subscription))
    )
  })

  const pass = lock
    .withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (stopping) return { claimed: 0, backlog: false, quiet: true }

          const quiet = (yield* inFlight) === 0

          const slots = Math.min(
            settings.deliveryConcurrency - (yield* FiberSet.size(deliveries)),
            settings.passLimit,
          )

          const all = executors()
          const local = all.filter(({ registered }) => registered.perActor === undefined)
          const capped = all.filter(({ registered }) => registered.perActor !== undefined)
          const permits = settings.executorConcurrency - (yield* FiberSet.size(attempts))
          const claimedAt = yield* Clock.currentTimeNanos
          const claimSignal = cancelChecks
          const clock = yield* FrameworkClock

          const workSlots =
            subscriptions === undefined
              ? undefined
              : {
                  feed: subscriptions.concurrency - (yield* FiberSet.size(subscriptionWork.feed)),
                  control:
                    subscriptions.concurrency - (yield* FiberSet.size(subscriptionWork.control)),
                  subscription:
                    subscriptions.concurrency -
                    (yield* FiberSet.size(subscriptionWork.subscription)),
                }

          const now = outboxNow({ sql, offsetMillis: clock.offsetMillis() })

          const claimGroups = (limit: number) =>
            Effect.gen(function* () {
              const claimed: Array<ClaimedEffect> = []
              const groups = yield* cappedGroups({ sql, now, executors: capped, limit })

              for (const group of groups) {
                const left = limit - claimed.length

                if (left <= 0) break

                const { registered } = capped.find(
                  ({ actor, effect }) => actor === group.actor_type && effect === group.command,
                )!

                claimed.push(
                  ...(yield* claimCapped({
                    sql,
                    now,
                    group,
                    cap: registered.perActor!,
                    maxAttempts: registered.attempts,
                    permits: left,
                    leaseMs: settings.executorLeaseMs,
                  })),
                )
              }

              const backlog = groups.length === limit || (groups[0]?.due_rows ?? 0) >= limit

              return { claimed, backlog }
            })

          const cappedFirst = capped.length > 0 && local.length > 0 && cappedTurn

          if (capped.length > 0 && local.length > 0) cappedTurn = !cappedTurn

          const early =
            cappedFirst && permits > 0
              ? yield* claimGroups(permits)
              : { claimed: [], backlog: false }

          const localPermits = permits - early.claimed.length

          const rows = yield* claimDue({
            sql,
            now,
            intents:
              slots > 0
                ? {
                    limit: slots,
                    leaseMs: settings.claimLeaseMs(),
                    maxBackoffMs: settings.maxBackoffMs,
                    probe: 2 * slots * widen.intents,
                    cronActors: [...schedules().keys()],
                  }
                : undefined,
            effects:
              localPermits > 0 && local.length > 0
                ? {
                    permits: localPermits,
                    leaseMs: settings.executorLeaseMs,
                    executors: local,
                    probe: 2 * localPermits * widen.effects,
                  }
                : undefined,
            subscriptions: workSlots === undefined ? undefined : subscriptions!.claim(workSlots),
          })

          const intents = rows.filter((row) => row.kind === "intent")
          const uncapped = rows.filter((row) => row.kind === "effect")

          const late =
            !cappedFirst && capped.length > 0 && localPermits - uncapped.length > 0
              ? yield* claimGroups(localPermits - uncapped.length)
              : { claimed: [], backlog: false }

          const effects = [...early.claimed, ...uncapped, ...late.claimed]
          const cappedBacklog = early.backlog || late.backlog

          if (slots > 0) {
            more.intents = intents.length > 0 && intents[0]!.candidates > intents.length
            widen.intents = widened(widen.intents, rows, "intent", slots)
          }

          if (permits > 0 && all.length > 0) {
            more.effects =
              cappedBacklog || (uncapped.length > 0 && uncapped[0]!.candidates > uncapped.length)
            widen.effects = widened(widen.effects, rows, "effect", localPermits)
          }

          let claimedWork = 0

          if (subscriptions !== undefined && workSlots !== undefined) {
            const work = yield* Effect.forEach(
              rows.filter((row) => row.kind === "work"),
              (row) => subscriptions.decode(row.work!),
            )

            claimedWork = work.length
            more.subscriptions = (["feed", "control", "subscription"] as const).some(
              (kind) =>
                workSlots[kind] > 0 &&
                work.filter((item) => item.kind === kind).length >= workSlots[kind],
            )

            for (const item of work) yield* startWork(item)
          }

          for (const row of intents)
            yield* FiberSet.run(
              deliveries,
              deliverIntent(row).pipe(
                logFailure("Outbox relay crashed settling a row"),
                Effect.ensuring(freed("intents")),
              ),
            )

          for (const row of effects) {
            const registered = all.find(
              ({ actor, effect }) => actor === row.actor_type && effect === row.command,
            )!.registered

            running.set(row.intent_id, {
              routingKey: BigInt(row.routing_key),
              attempt: row.attempts,
              lease: { until: Number(row.claimed_until) },
            })

            yield* FiberSet.run(
              attempts,
              settleAttempt(row, registered, claimedAt, claimSignal).pipe(
                Effect.ensuring(Effect.sync(() => running.delete(row.intent_id))),
                logFailure("Effect attempt crashed before it settled"),
                Effect.ensuring(freed("effects")),
              ),
            )
          }

          return {
            claimed: intents.length + effects.length + claimedWork,
            backlog: more.intents || more.effects || more.subscriptions,
            quiet,
          }
        }),
      ),
    )
    .pipe(Effect.provideContext(services))

  const run = Effect.gen(function* () {
    while (true) {
      const jitter = 0.9 + 0.2 * (yield* Random.next)
      yield* Queue.take(signals).pipe(Effect.timeoutOption(settings.pollMs * jitter))
      yield* pass.pipe(logFailure("Outbox relay pass failed"))
    }
  })

  const idle = Effect.gen(function* () {
    yield* FiberSet.awaitEmpty(deliveries)
    yield* FiberSet.awaitEmpty(attempts)
    yield* FiberSet.awaitEmpty(subscriptionWork.feed)
    yield* FiberSet.awaitEmpty(subscriptionWork.control)
    yield* FiberSet.awaitEmpty(subscriptionWork.subscription)
  })

  const drain = Effect.gen(function* () {
    for (let rounds = 0; rounds < DRAIN_ROUNDS;) {
      yield* idle
      const { claimed, backlog, quiet } = yield* pass

      if (claimed === 0 && quiet) return

      if (claimed > 0 && !backlog) rounds++
    }

    return yield* Effect.die(new Error("Outbox did not settle; intents keep producing due work"))
  }).pipe(Effect.orDie)

  yield* Effect.addFinalizer(() =>
    lock.withPermit(
      Effect.sync(() => {
        stopping = true
      }),
    ),
  )

  const extendLeases = (millis: number, jump: Effect.Effect<void>) =>
    lock
      .withPermit(
        Effect.forEach(
          [...running],
          ([intentId, { routingKey, attempt, lease }]) =>
            sql`UPDATE actor_outbox SET due_at_ms = due_at_ms + ${millis}
            WHERE routing_key = ${routingKey} AND intent_id = ${intentId}
              AND kind = 'effect' AND attempts = ${attempt}`.pipe(
              Effect.tap(
                Effect.sync(() => {
                  lease.until += millis
                }),
              ),
            ),
          { discard: true },
        ).pipe(Effect.andThen(jump)),
      )
      .pipe(Effect.orDie)

  const stop = lock
    .withPermit(
      Effect.sync(() => {
        stopping = true
      }),
    )
    .pipe(
      Effect.andThen(FiberSet.clear(deliveries)),
      Effect.andThen(FiberSet.clear(subscriptionWork.feed)),
      Effect.andThen(FiberSet.clear(subscriptionWork.control)),
      Effect.andThen(FiberSet.clear(subscriptionWork.subscription)),
    )

  const interruptAttempts = Effect.flatMap(FiberSet.size(attempts), (running) =>
    FiberSet.clear(attempts).pipe(Effect.as(running)),
  )

  return {
    run,
    drain,
    stop,
    attemptsIdle: FiberSet.awaitEmpty(attempts),
    interruptAttempts,
    extendLeases,
    wake: Queue.offer(signals, undefined).pipe(Effect.asVoid),
    cancelled,
  }
})
