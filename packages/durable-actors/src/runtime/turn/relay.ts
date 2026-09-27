import {
  Cause,
  Clock,
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
import { Outcome, type RegisteredEffect, Request } from "../../handles/actors.ts"
import { ActorRef, principal } from "../../identity/caller.ts"
import { TurnHooks } from "./hooks.ts"
import { databaseTime, FrameworkClock } from "./admission.ts"
import { BUCKETS, CallerJson } from "./outbox.ts"

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
  /**
   * How often a running attempt renews its claim and checks for a
   * cancellation committed on another runner; at most a third of the lease.
   */
  readonly cancelCheckMs?: number | undefined
}

/** An executor this runner has, by actor type and effect tag. */
export interface LocalExecutor {
  readonly actor: string
  readonly effect: string
  readonly registered: RegisteredEffect
}

interface ClaimedRow {
  /** `skipped-*` rows claim nothing; they report a probe whose candidates were all taken or locked. */
  readonly kind: "intent" | "effect" | "skipped-intent" | "skipped-effect"
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
  readonly caller: string
  /** The claim's `due_at_ms`, which every settling write of an intent names. */
  readonly claimed_until: string
  /** Cancelled by a turn: settled with what is known, never attempted again. */
  readonly cancelled: boolean
  /** An earlier attempt of the effect may have applied the call. */
  readonly maybe_applied: boolean
  readonly candidates: number
}

interface ClaimedEffect extends ClaimedRow {
  readonly exhausted: boolean
}

const claimedColumns = (sql: SqlClient.SqlClient) =>
  sql`o.kind, o.routing_key::text AS routing_key, o.intent_id, o.attempts, o.last_error,
    o.ambiguous, o.tenant_id, o.actor_type, o.actor_id, o.target_type, o.target_id, o.command,
    o.payload, o.caller, o.due_at_ms::text AS claimed_until,
    o.cancelled_at_ms IS NOT NULL AS cancelled, o.maybe_applied`

/**
 * The due-work probe: one `(bucket, kind, due_at_ms)` index range per bucket,
 * so its cost follows due rows of one kind, not stored actors or future timers.
 * It takes no locks; a claim locks only the rows it takes from it.
 */
const candidates = (
  sql: SqlClient.SqlClient,
  kind: "intent" | "effect",
  now: Statement.Fragment,
  limit: number,
  only: ReturnType<typeof sql.literal> = sql.literal(""),
) =>
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
}

/** Effects to claim in one statement: up to `permits`, only for local executors. */
export interface EffectClaim {
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
 */
export const claimDue = ({
  sql,
  now,
  intents,
  effects,
}: {
  readonly sql: SqlClient.SqlClient
  readonly now: Statement.Fragment
  readonly intents?: IntentClaim | undefined
  readonly effects?: EffectClaim | undefined
}) => {
  const parts: Array<Statement.Fragment> = []
  const results: Array<Statement.Fragment> = []

  if (intents !== undefined) {
    const { limit, leaseMs, maxBackoffMs, probe = 2 * limit } = intents
    parts.push(sql`intent_candidates AS (
        ${candidates(sql, "intent", now, probe)}
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
          (SELECT count(*) FROM intent_candidates)::int AS candidates, false AS exhausted
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
        ${candidates(
          sql,
          "effect",
          now,
          probe,
          // Filtered inside each bucket's probe, so due rows no runner here can
          // execute never fill the per-bucket limit ahead of rows it can.
          sql.literal("AND (actor_type, command) IN (SELECT actor_type, command FROM mine)"),
        )}
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
    results.push(sql`SELECT * FROM effect_claimed`, skipped(sql, "effect"))
  }

  if (results.length === 0) return Effect.succeed([] as ReadonlyArray<ClaimedEffect>)

  return sql<ClaimedEffect>`WITH ${sql.csv(parts)}
    ${sql.join(" UNION ALL ", false)(results)}`
}

/**
 * Claims the effect rows `locked` names. A cancelled row is claimed only to
 * be settled, so it keeps its attempts; any other row starts its next attempt
 * and runs, unless its last attempt already ended without an outcome, which
 * exhausts it. `maybe_applied` then covers every attempt before this one.
 * RETURNING sees the updated row, so exhaustion is judged on the attempts
 * before this claim.
 */
const claimEffects = (
  sql: SqlClient.SqlClient,
  now: Statement.Fragment,
  leaseMs: number,
  locked: Statement.Fragment,
  candidates: Statement.Fragment,
) => {
  const attempting = sql`o.cancelled_at_ms IS NULL AND o.attempts < c.max_attempts`

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
    RETURNING ${claimedColumns(sql)}, ${candidates} AS candidates,
      o.cancelled_at_ms IS NULL AND c.previous >= c.max_attempts AS exhausted`
}

/** One effect type of one actor whose attempts run under a per-actor cap. */
export interface CappedGroup {
  readonly routing_key: string
  readonly tenant_id: string
  readonly actor_type: string
  readonly actor_id: string
  readonly command: string
}

/**
 * The actors with due rows of capped effects this runner executes, oldest
 * first; at most `limit`. Like the uncapped probe, it reads one index range
 * per bucket and takes no locks.
 */
export const cappedGroups = ({
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
  sql<CappedGroup>`WITH mine (actor_type, command) AS (
      VALUES ${sql.csv(
        executors.map(({ actor, effect }) => sql`(${actor}::text, ${effect}::text)`),
      )}
    ),
    due AS (
      ${candidates(
        sql,
        "effect",
        now,
        limit,
        sql.literal("AND (actor_type, command) IN (SELECT actor_type, command FROM mine)"),
      )}
    )
    SELECT o.routing_key::text AS routing_key, o.tenant_id, o.actor_type, o.actor_id, o.command
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
export const claimCapped = ({
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
          FOR UPDATE OF o SKIP LOCKED
        ),
        next AS (
          SELECT o.routing_key, o.intent_id, o.attempts AS previous, ${maxAttempts}::int AS max_attempts
          FROM actor_outbox o
          WHERE ${inGroup} AND o.cancelled_at_ms IS NULL
            AND (o.due_at_ms <= ${now} OR (o.waiting AND NOT o.running))
          ORDER BY coalesce(o.ready_at_ms, o.due_at_ms), o.intent_id
          LIMIT greatest(0, least(${cap}::int - (SELECT n FROM live), ${permits}::int))
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

/** Makes the oldest waiting row of `group` due now, after one of its attempts settled. */
const wakeWaiting = (sql: SqlClient.SqlClient, group: CappedGroup, at: number) =>
  sql`UPDATE actor_outbox SET due_at_ms = least(due_at_ms, ${at}), waiting = false
    WHERE (routing_key, intent_id) IN (
      SELECT o.routing_key, o.intent_id FROM actor_outbox o
      WHERE ${groupRow(sql, group)} AND o.waiting AND o.cancelled_at_ms IS NULL
      ORDER BY coalesce(o.ready_at_ms, o.due_at_ms), o.intent_id LIMIT 1
    ) RETURNING 1`

/** One row reporting `kind`'s candidates when its claim took none of them. */
const skipped = (sql: SqlClient.SqlClient, kind: "intent" | "effect") => {
  const claimed = sql.literal(`${kind}_claimed`)
  const found = sql.literal(`${kind}_candidates`)

  return sql`SELECT ${`skipped-${kind}`}::text, NULL, NULL, 0, NULL, false, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, false, false, (SELECT count(*) FROM ${found})::int, false
    WHERE NOT EXISTS (SELECT 1 FROM ${claimed}) AND EXISTS (SELECT 1 FROM ${found})`
}

/** The outbox clock inside a statement: its start time on the database plus the test offset. */
const outboxNow = (sql: SqlClient.SqlClient, offsetMillis: number) =>
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
 * once, so no claimed row waits locally while its lease runs down.
 *
 * An intent is delivered as a direct command whose command id is the intent
 * id, and its row is deleted only after the receiver's receipt has committed.
 * A crash leaves the claim in place until its lease ends; any runner then
 * redelivers, and the receipt deduplicates.
 *
 * An effect attempt runs on the pool, outside the pass, and renews its claim
 * while it runs. The first success of any attempt turns the row into an intent
 * to its `onSuccess` route; exhausting retries turns it into one to
 * `onDeadLetter`. The route is then delivered like any intent, so it commits
 * once per effect id however often the executor ran.
 */
export const outboxRelay = Effect.fnUntraced(function* (
  deliver: (request: Request) => Effect.Effect<Outcome, ActorError>,
  executors: () => ReadonlyArray<LocalExecutor>,
  settings: RelaySettings,
) {
  const sql = yield* SqlClient.SqlClient
  const services = yield* Effect.context<SqlClient.SqlClient>()
  const lock = Semaphore.makeUnsafe(1)
  const signals = yield* Queue.sliding<void>(1)
  const deliveries = yield* FiberSet.make<unknown, unknown>()
  const attempts = yield* FiberSet.make<unknown, unknown>()
  const hooks = yield* TurnHooks

  // Set when a claim saw more due candidates than it took: a freed slot then
  // claims again instead of waiting for the poll.
  const more = { intents: false, effects: false }
  // How many times the base probe the next claim reads; doubled while a claim
  // leaves free capacity although it found more candidates than it took.
  const widen = { intents: 1, effects: 1 }
  let stopping = false
  // Attempts this runner is executing, keyed by effect id, with the attempt that holds each lease.
  const running = new Map<string, { readonly routingKey: bigint; readonly attempt: number }>()

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
        // Intents have no retry limit; this warning and `attempts` are the operator signal.
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
      })

    return yield* Effect.gen(function* () {
      // A row that cannot form a request backs off like a failed delivery instead of dying on every claim.
      const decoded = yield* requestOf(row, "receiver").pipe(Effect.result)

      if (Result.isFailure(decoded)) return yield* retryLater("UnreadableRow", decoded.failure)

      const request = decoded.success
      yield* hooks.at("afterClaim", request)

      const delivered = yield* deliver(request).pipe(Effect.result)

      if (Result.isFailure(delivered))
        return yield* retryLater(delivered.failure.reason._tag, delivered.failure)

      // A declared failure is a committed receipt too; only a missing receipt retries.
      if (Outcome.guards.Defect(delivered.success))
        return yield* retryLater("Defect", delivered.success.cause)

      yield* hooks.at("beforeOutboxDelete", request)
      yield* sql`DELETE FROM actor_outbox WHERE ${claim}`
    }).pipe(
      // An interrupted delivery (shutdown) makes its row due at once; a receiver
      // that already committed it replays the receipt on redelivery.
      Effect.onInterrupt(() =>
        Effect.gen(function* () {
          yield* sql`UPDATE actor_outbox SET due_at_ms = ${yield* databaseTime} WHERE ${claim}`
        }).pipe(Effect.ignore),
      ),
    )
  })

  // Running attempts wait on this between renewals; a local commit that
  // cancelled a running effect completes it, so they check at once.
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

    // Failures and dead letters name the attempt they settle, so a stale attempt changes nothing.
    const attemptRow = (attempts: number) => sql`${effectRow} AND attempts = ${attempts}`

    // The row becomes an intent to `route`, or goes when there is none.
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
                payload = ${route.payload}, due_at_ms = ${at}, scheduled_at_ms = ${at},
                attempts = 0, last_error = NULL, ambiguous = false, running = false,
                timer_key = NULL
              WHERE ${guard} RETURNING 1`

        if (route !== undefined && settled.length > 0) yield* Queue.offer(signals, undefined)

        return settled.length > 0
      })

    const exhaust = (attempts: number, cause: string, ambiguous: boolean) =>
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
              yield* registered.deadLetter(row.payload, letter),
              attemptRow(attempts),
            ))
          )
            return

          yield* Effect.logWarning("Effect dead-lettered after its last attempt", cause).pipe(
            annotate,
          )
          yield* sql`INSERT INTO actor_dead_letters (routing_key, effect_id, tenant_id, actor_type,
              actor_id, effect, payload, attempts, cause, ambiguous, dead_at_ms)
            VALUES (${routingKey}, ${row.intent_id}, ${row.tenant_id}, ${row.actor_type},
              ${row.actor_id}, ${row.command}, ${row.payload}, ${attempts}, ${cause}, ${ambiguous},
              ${yield* databaseTime})`

          // Only the fault hook needs the request, so an unreadable one must not block the letter.
          const request = yield* requestOf(row, "sender").pipe(Effect.option)

          if (Option.isSome(request)) yield* hooks.at("beforeDeadLetterCommit", request.value)
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
          const route = yield* registered.cancelled(row.payload, {
            effectId: row.intent_id,
            attempts,
            outcome: { _tag: known, cause },
            ambiguous,
          })

          if (route !== undefined) return yield* settleTo(route, guard)
        }

        if (ambiguous) return yield* exhaust(attempts, cause, true).pipe(Effect.as(true))

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

    // A cancelled row whose attempt ended without settling it, or that was
    // backing off: never attempted again, only settled with what is known.
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

    // The last attempt ended without an outcome, or its dead letter failed after recording one.
    if (row.exhausted)
      return yield* exhaust(row.attempts, row.last_error ?? "No attempt reported", row.ambiguous)

    const attempt = row.attempts
    const request = yield* requestOf(row, "sender").pipe(Effect.orDie)
    const ref = ActorRef.make(request.ref)
    const leaseNanos = BigInt(settings.executorLeaseMs) * 1_000_000n
    // Measured on this runner from when the last claim or renewal was sent, so
    // the database's lease can only end later than this one.
    let confirmed = claimedAt

    yield* hooks.at("afterClaim", request)
    yield* hooks.at("beforeExecute", request)

    // Another runner may already hold the row, and a started call can't be undone.
    if ((yield* Clock.currentTimeNanos) - confirmed >= leaseNanos)
      return yield* Effect.logWarning("Effect attempt outlived its lease before it started").pipe(
        Effect.annotateLogs({ attempt }),
        annotate,
      )

    const renewals = Effect.gen(function* () {
      while (true) {
        yield* Deferred.await(cancelChecks).pipe(
          Effect.timeoutOrElse({ duration: renewEveryMs, orElse: () => Effect.void }),
        )
        const sent = yield* Clock.currentTimeNanos

        // A renewal that fails is retried at the next interval; the deadline
        // interrupts the attempt if none gets through in time.
        const renewed = yield* Effect.gen(function* () {
          yield* hooks.at("beforeRenew", request)

          // Never shortens a deadline, so a renewal can't undo a test clock's lease shift.
          return yield* sql<{ cancelled: boolean }>`UPDATE actor_outbox
              SET due_at_ms = greatest(due_at_ms, ${(yield* databaseTime) + settings.executorLeaseMs})
              WHERE ${attemptRow(attempt)}
              RETURNING cancelled_at_ms IS NOT NULL AS cancelled`.pipe(Effect.uninterruptible)
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

    running.set(row.intent_id, { routingKey, attempt })

    // The lease stays registered until the outcome is written, so a clock jump
    // between the call's return and its settle can't expire it and start a
    // second call.
    return yield* Effect.gen(function* () {
      // Racing stops and awaits the renewal fiber before any settling write, so
      // a late renewal can't overwrite a failure's backoff with a fresh lease.
      const outcome = yield* registered
        .execute(row.payload, {
          effectId: row.intent_id,
          attempt,
          principal: principal(request.caller),
          ref,
        })
        .pipe(Effect.result, Effect.raceFirst(renewals), Effect.raceFirst(deadline))

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

      // Interrupting a started call does not undo it, so its outcome is unknown.
      if (outcome === "cancelled") {
        yield* Effect.logInfo("Effect attempt interrupted by its cancellation").pipe(
          Effect.annotateLogs({ attempt }),
          annotate,
        )

        return yield* settleCancelled(attempt, "Unknown", cancelledCause(attempt))
      }

      if (Result.isSuccess(outcome)) {
        yield* hooks.at("afterExecute", request)
        const routes = outcome.success

        // The first success of any attempt wins; the row stops being an effect.
        if (yield* settleTo(routes.success, sql`${effectRow} AND cancelled_at_ms IS NULL`)) return

        // Cancelled meanwhile: the result is reported as the cancellation's outcome.
        if (
          yield* settleTo(
            registered.routesCancelled ? routes.cancelled : routes.success,
            sql`${effectRow} AND cancelled_at_ms IS NOT NULL`,
          )
        )
          return

        const late = yield* sql`UPDATE actor_dead_letters SET ambiguous = true
          WHERE routing_key = ${routingKey} AND effect_id = ${row.intent_id} RETURNING 1`

        if (late.length > 0)
          return yield* Effect.logWarning("Effect succeeded after it was dead-lettered").pipe(
            Effect.annotateLogs({ attempt }),
            annotate,
          )

        // A cancellation already reported without this result: keep an
        // ambiguous record of it instead of routing a second outcome.
        const reported = routes.cancelled?.command

        if (registered.routesCancelled && reported !== undefined) {
          const recorded = yield* sql`INSERT INTO actor_dead_letters (routing_key, effect_id,
              tenant_id, actor_type, actor_id, effect, payload, attempts, cause, ambiguous, dead_at_ms)
            SELECT ${routingKey}, ${row.intent_id}, ${row.tenant_id}, ${row.actor_type},
              ${row.actor_id}, ${row.command}, ${row.payload}, ${attempt},
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

        return
      }

      const { cause, ambiguous, final } = outcome.failure
      const last = final === true || attempt >= registered.attempts
      const { baseMs, maxMs } = registered.backoff

      // The outcome is recorded first, so a failed dead-letter transaction is
      // retried with this attempt's cause rather than the claim's.
      const recorded = yield* sql<{
        cancelled: boolean
        maybe_applied: boolean
      }>`UPDATE actor_outbox
        SET last_error = ${cause}, ambiguous = ${ambiguous}, running = false,
          due_at_ms = ${(yield* databaseTime) + Math.min(baseMs * 2 ** (attempt - 1), maxMs)}
        WHERE ${attemptRow(attempt)}
        RETURNING cancelled_at_ms IS NOT NULL AS cancelled, maybe_applied`

      if (recorded[0]?.cancelled === true)
        return yield* settleCancelled(
          attempt,
          ambiguous || recorded[0].maybe_applied ? "Unknown" : "Failed",
          cause,
        )

      if (last) return yield* exhaust(attempt, cause, ambiguous)

      yield* Effect.logWarning("Effect attempt failed; retrying with backoff", cause).pipe(
        Effect.annotateLogs({ attempt, ambiguous }),
        annotate,
      )
    }).pipe(Effect.ensuring(Effect.sync(() => running.delete(row.intent_id))))
  })

  // A settled attempt of a capped effect frees a slot for the oldest waiting row of its actor.
  const settleAttempt = (row: ClaimedEffect, registered: RegisteredEffect, claimedAt: bigint) =>
    registered.perActor === undefined
      ? runAttempt(row, registered, claimedAt)
      : runAttempt(row, registered, claimedAt).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              const woke = yield* wakeWaiting(sql, groupOf(row), yield* databaseTime)

              if (woke.length > 0) yield* Queue.offer(signals, undefined)
            }).pipe(Effect.ignore),
          ),
        )

  const freed = (kind: "intents" | "effects") =>
    Effect.suspend(() => (more[kind] ? Queue.offer(signals, undefined) : Effect.void))

  const inFlight = Effect.gen(function* () {
    return (yield* FiberSet.size(deliveries)) + (yield* FiberSet.size(attempts))
  })

  // Uninterruptible so every row a claim returns reaches a fiber that can release it.
  const pass = lock
    .withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (stopping) return { claimed: 0, backlog: false, quiet: true }

          // Work runs only on fibers a pass starts, so none running now means
          // nothing can stage rows after this claim reads.
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
          const clock = yield* FrameworkClock

          const rows = yield* claimDue({
            sql,
            now: outboxNow(sql, clock.offsetMillis()),
            intents:
              slots > 0
                ? {
                    limit: slots,
                    leaseMs: settings.claimLeaseMs(),
                    maxBackoffMs: settings.maxBackoffMs,
                    probe: 2 * slots * widen.intents,
                  }
                : undefined,
            effects:
              permits > 0 && local.length > 0
                ? {
                    permits,
                    leaseMs: settings.executorLeaseMs,
                    executors: local,
                    probe: 2 * permits * widen.effects,
                  }
                : undefined,
          })

          const intents = rows.filter((row) => row.kind === "intent")
          const effects = rows.filter((row) => row.kind === "effect")
          let cappedBacklog = false

          // Capped effects are claimed per actor, each under its group's lock,
          // with the permits the uncapped claim left.
          if (capped.length > 0 && permits - effects.length > 0) {
            const now = outboxNow(sql, clock.offsetMillis())
            const limit = permits - effects.length

            const groups = yield* cappedGroups({ sql, now, executors: capped, limit })
            cappedBacklog = groups.length === limit

            for (const group of groups) {
              const left = permits - effects.length

              if (left <= 0) break

              const { registered } = capped.find(
                ({ actor, effect }) => actor === group.actor_type && effect === group.command,
              )!

              effects.push(
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
          }

          if (slots > 0) {
            more.intents = intents.length > 0 && intents[0]!.candidates > intents.length
            widen.intents = widened(widen.intents, rows, "intent", slots)
          }

          if (permits > 0 && all.length > 0) {
            more.effects =
              cappedBacklog || (effects.length > 0 && effects[0]!.candidates > effects.length)
            widen.effects = widened(widen.effects, rows, "effect", permits)
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

            yield* FiberSet.run(
              attempts,
              settleAttempt(row, registered, claimedAt).pipe(
                logFailure("Effect attempt crashed before it settled"),
                Effect.ensuring(freed("effects")),
              ),
            )
          }

          return {
            claimed: intents.length + effects.length,
            backlog: more.intents || more.effects,
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
  })

  // Waits for in-flight work, which may stage more, then claims again; done
  // once a claim finds nothing while nothing was running.
  const drain = Effect.gen(function* () {
    for (let rounds = 0; rounds < DRAIN_ROUNDS;) {
      yield* idle
      const { claimed, backlog, quiet } = yield* pass

      if (claimed === 0 && quiet) return

      // A backlog larger than the free slots takes many rounds; only rounds
      // that drained every due row count toward the loop guard.
      if (claimed > 0 && !backlog) rounds++
    }

    return yield* Effect.die(new Error("Outbox did not settle; intents keep producing due work"))
  }).pipe(Effect.orDie)

  // Shutdown stops claims; interrupted deliveries release their rows in their interrupt handler.
  // Taking the lock lets a pass in progress hand its rows to fibers first, so they are interrupted and released.
  yield* Effect.addFinalizer(() =>
    lock.withPermit(
      Effect.sync(() => {
        stopping = true
      }),
    ),
  )

  // Moves this runner's running attempts' leases with a jump of the outbox clock,
  // as the renewals during that time would have.
  const extendLeases = (millis: number) =>
    Effect.forEach(
      [...running],
      ([intentId, { routingKey, attempt }]) =>
        sql`UPDATE actor_outbox SET due_at_ms = due_at_ms + ${millis}
          WHERE routing_key = ${routingKey} AND intent_id = ${intentId}
            AND kind = 'effect' AND attempts = ${attempt}`,
      { discard: true },
    ).pipe(Effect.orDie)

  return {
    run,
    drain,
    extendLeases,
    wake: Queue.offer(signals, undefined).pipe(Effect.asVoid),
    cancelled,
  }
})
