import {
  Cause,
  Clock,
  Effect,
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
import { progressPool } from "../effects/progress.ts"
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
  readonly candidates: number
}

interface ClaimedEffect extends ClaimedRow {
  readonly exhausted: boolean
}

const claimedColumns = (sql: SqlClient.SqlClient) =>
  sql`o.kind, o.routing_key::text AS routing_key, o.intent_id, o.attempts, o.last_error,
    o.ambiguous, o.tenant_id, o.actor_type, o.actor_id, o.target_type, o.target_id, o.command,
    o.payload, o.caller, o.due_at_ms::text AS claimed_until`

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
      -- RETURNING sees the updated row, so exhaustion is judged on the attempts before this claim.
      effect_claimed AS (
        UPDATE actor_outbox o SET
          due_at_ms = ${now} + ${leaseMs}::bigint,
          attempts = CASE WHEN o.attempts < c.max_attempts THEN o.attempts + 1 ELSE o.attempts END,
          ambiguous = CASE WHEN o.attempts < c.max_attempts THEN true ELSE o.ambiguous END,
          last_error = CASE WHEN o.attempts < c.max_attempts
            THEN 'Attempt ' || (o.attempts + 1) || ' ended without reporting an outcome'
            ELSE o.last_error END
        FROM effect_locked c
        WHERE o.routing_key = c.routing_key AND o.intent_id = c.intent_id
        RETURNING ${claimedColumns(sql)},
          (SELECT count(*) FROM effect_candidates)::int AS candidates,
          c.previous >= c.max_attempts AS exhausted
      )`)
    results.push(sql`SELECT * FROM effect_claimed`, skipped(sql, "effect"))
  }

  if (results.length === 0) return Effect.succeed([] as ReadonlyArray<ClaimedEffect>)

  return sql<ClaimedEffect>`WITH ${sql.csv(parts)}
    ${sql.join(" UNION ALL ", false)(results)}`
}

/** One row reporting `kind`'s candidates when its claim took none of them. */
const skipped = (sql: SqlClient.SqlClient, kind: "intent" | "effect") => {
  const claimed = sql.literal(`${kind}_claimed`)
  const found = sql.literal(`${kind}_candidates`)

  return sql`SELECT ${`skipped-${kind}`}::text, NULL, NULL, 0, NULL, false, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, (SELECT count(*) FROM ${found})::int, false
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
  const progress = yield* progressPool()

  // Set when a claim saw more due candidates than it took: a freed slot then
  // claims again instead of waiting for the poll.
  const more = { intents: false, effects: false }
  // How many times the base probe the next claim reads; doubled while a claim
  // leaves free capacity although it found more candidates than it took.
  const widen = { intents: 1, effects: 1 }
  let stopping = false

  // Attempts this runner is executing, keyed by effect id, with the attempt that holds each lease.
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
                attempts = 0, last_error = NULL, ambiguous = false
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
            return false

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

          return true
        }),
      )

    // A terminal settle closes the effect's progress; a retryable one leaves it open.
    const closeAfter = <E, R>(attempts: number, settle: Effect.Effect<boolean, E, R>) =>
      Effect.tap(settle, (settled) =>
        settled
          ? requestOf(row, "sender").pipe(
              Effect.flatMap((request) =>
                progress.closed({
                  ref: ActorRef.make(request.ref),
                  effectId: row.intent_id,
                  effect: row.command,
                  attempt: attempts,
                  everyMs: registered.progressEveryMs,
                }),
              ),
              Effect.ignore,
            )
          : Effect.void,
      )

    // The last attempt ended without an outcome, or its dead letter failed after recording one.
    if (row.exhausted)
      return yield* closeAfter(
        row.attempts,
        exhaust(row.attempts, row.last_error ?? "No attempt reported", row.ambiguous),
      )

    const attempt = row.attempts
    const request = yield* requestOf(row, "sender").pipe(Effect.orDie)
    const ref = ActorRef.make(request.ref)
    const lease = running.get(row.intent_id)?.lease ?? { until: Number(row.claimed_until) }
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
        yield* Effect.sleep(settings.executorLeaseMs / 3)
        const sent = yield* Clock.currentTimeNanos

        // A renewal that fails is retried at the next interval; the deadline
        // interrupts the attempt if none gets through in time.
        const renewed = yield* Effect.gen(function* () {
          yield* hooks.at("beforeRenew", request)

          // Never shortens a deadline, so a renewal can't undo a test clock's lease shift.
          return yield* sql`UPDATE actor_outbox
              SET due_at_ms = greatest(due_at_ms, ${(yield* databaseTime) + settings.executorLeaseMs})
              WHERE ${attemptRow(attempt)} RETURNING due_at_ms::text AS due_at_ms`.pipe(
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
      // Racing stops and awaits the renewal fiber before any settling write, so
      // a late renewal can't overwrite a failure's backoff with a fresh lease.
      const outcome = yield* registered
        .execute(row.payload, {
          effectId: row.intent_id,
          attempt,
          principal: principal(request.caller),
          ref,
          reporting: slot.active,
          report: slot.offer,
        })
        .pipe(
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

      if (Result.isSuccess(outcome)) {
        yield* hooks.at("afterExecute", request)

        // The first success of any attempt wins; the row stops being an effect.
        if (yield* closeAfter(attempt, settleTo(outcome.success, effectRow))) return

        const late = yield* sql`UPDATE actor_dead_letters SET ambiguous = true
          WHERE routing_key = ${routingKey} AND effect_id = ${row.intent_id} RETURNING 1`

        if (late.length > 0)
          yield* Effect.logWarning("Effect succeeded after it was dead-lettered").pipe(
            Effect.annotateLogs({ attempt }),
            annotate,
          )

        return
      }

      const { cause, ambiguous, final } = outcome.failure
      const last = final === true || attempt >= registered.attempts
      const { baseMs, maxMs } = registered.backoff

      // The outcome is recorded first, so a failed dead-letter transaction is
      // retried with this attempt's cause rather than the claim's.
      yield* sql`UPDATE actor_outbox SET last_error = ${cause}, ambiguous = ${ambiguous},
          due_at_ms = ${(yield* databaseTime) + Math.min(baseMs * 2 ** (attempt - 1), maxMs)}
        WHERE ${attemptRow(attempt)}`

      if (last) return yield* closeAfter(attempt, exhaust(attempt, cause, ambiguous))

      yield* Effect.logWarning("Effect attempt failed; retrying with backoff", cause).pipe(
        Effect.annotateLogs({ attempt, ambiguous }),
        annotate,
      )
    }).pipe(Effect.ensuring(progress.forget(row.intent_id)))
  })

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

          const local = executors()
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
              permits > 0
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

          if (slots > 0) {
            more.intents = intents.length > 0 && intents[0]!.candidates > intents.length
            widen.intents = widened(widen.intents, rows, "intent", slots)
          }

          if (permits > 0 && local.length > 0) {
            more.effects = effects.length > 0 && effects[0]!.candidates > effects.length
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
            const registered = local.find(
              ({ actor, effect }) => actor === row.actor_type && effect === row.command,
            )!.registered

            // Registered before the lock is released and until the outcome is
            // written, so every clock jump after the claim moves this lease.
            running.set(row.intent_id, {
              routingKey: BigInt(row.routing_key),
              attempt: row.attempts,
              lease: { until: Number(row.claimed_until) },
            })

            yield* FiberSet.run(
              attempts,
              runAttempt(row, registered, claimedAt).pipe(
                Effect.ensuring(Effect.sync(() => running.delete(row.intent_id))),
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
  // as the renewals during that time would have. Holding the pass lock means
  // no claim reads the clock between the moved leases and the jump, and a pass
  // in progress registers its rows first.
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

  return {
    run,
    drain,
    extendLeases,
    wake: Queue.offer(signals, undefined).pipe(Effect.asVoid),
  }
})
