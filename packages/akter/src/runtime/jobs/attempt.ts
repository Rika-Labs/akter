import { Cause, Clock, Data, Deferred, Effect, Option, Result, Schema } from "effect"
import { SqlClient, type Statement } from "effect/sql"
import { ActorRef, principal } from "../../identity/caller.ts"
import type { JobFailure, JobRoute, RegisteredJob } from "../members.ts"
import { Request } from "../request.ts"
import { count as tally, Metrics } from "../telemetry/metrics.ts"
import { SpanNames } from "../telemetry/spans.ts"
import { databaseTime } from "../turn/admission.ts"
import { TurnHooks } from "../turn/hooks.ts"
import { CallerJson } from "../turn/outbox.ts"
import type { progressPool } from "./progress.ts"

/** A job row as a claim returned it. */
export interface ClaimedJob {
  readonly routing_key: string
  readonly intent_id: string
  readonly attempts: number
  readonly last_error: string | null
  readonly ambiguous: boolean
  readonly tenant_id: string
  readonly actor_type: string
  readonly actor_id: string
  readonly command: string
  readonly payload: string
  readonly payload_version: number
  readonly caller: string
  /** The claim's `due_at_ms`: the lease end the claim wrote. */
  readonly claimed_until: string
  /** Cancelled by a turn: settled with what is known, never attempted again. */
  readonly cancelled: boolean
  /** An earlier attempt may have applied the call. */
  readonly maybe_applied: boolean
  /** Its retries ran out, or an attempt's failure was final, before this claim. */
  readonly exhausted: boolean
}

/** One job type of one actor whose attempts run under a per-actor cap. */
export interface CappedGroup {
  readonly routing_key: string
  readonly tenant_id: string
  readonly actor_type: string
  readonly actor_id: string
  readonly command: string
}

/** The job rows of `group`, as the outbox row aliased `o`. */
export const groupRow = ({
  sql,
  group,
}: {
  readonly sql: SqlClient.SqlClient
  readonly group: CappedGroup
}) =>
  sql`o.routing_key = ${BigInt(group.routing_key)} AND o.tenant_id = ${group.tenant_id}
    AND o.actor_type = ${group.actor_type} AND o.actor_id = ${group.actor_id}
    AND o.command = ${group.command} AND o.kind = 'job'`

/** The actor's shard-local generation row serializes claims and wakes of its capped jobs. */
export const groupLock = ({
  sql,
  group,
}: {
  readonly sql: SqlClient.SqlClient
  readonly group: CappedGroup
}) =>
  sql`SELECT 1 FROM actor_generations
    WHERE routing_key = ${BigInt(group.routing_key)} AND tenant_id = ${group.tenant_id}
      AND actor_type = ${group.actor_type} AND actor_id = ${group.actor_id}
    FOR UPDATE`

/**
 * Makes the oldest waiting row of `group` due now, after one of its attempts
 * settled. It takes the group's lock like a claim, so it never overlaps one:
 * a claim's `SKIP LOCKED` would pass over the row this update holds and start
 * a younger row ahead of it, breaking enqueue order. The lock also means no
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
      groupLock({ sql, group }),
      sql`UPDATE actor_outbox SET due_at_ms = least(due_at_ms, ${at}), waiting = false
        WHERE waiting AND NOT running AND cancelled_at_ms IS NULL
          AND (routing_key, intent_id) IN (
            SELECT o.routing_key, o.intent_id FROM actor_outbox o
            WHERE ${groupRow({ sql, group })} AND o.waiting AND NOT o.running
              AND o.cancelled_at_ms IS NULL
            ORDER BY o.ready_at_ms, o.intent_id LIMIT 1
            FOR UPDATE OF o SKIP LOCKED
          ) RETURNING 1`,
    ),
  )

/**
 * What one claim of a job reported, decided from the executor's exit and the
 * claim alone, before the row is written. `Rejected` is a result the
 * `onSuccess` route cannot accept: the provider applied the call, so it is
 * final and ambiguous. `Interrupted` is an attempt stopped by its
 * cancellation; `Unattempted` a cancelled or exhausted row claimed only to
 * be settled.
 */
export type Reported = Data.TaggedEnum<{
  Succeeded: { readonly success: JobRoute | undefined; readonly cancelled: JobRoute | undefined }
  Rejected: { readonly failure: JobFailure; readonly cancelled: JobRoute | undefined }
  Failed: { readonly failure: JobFailure }
  Interrupted: {}
  Unattempted: {}
}>

/** Constructors and matchers for `Reported`. */
export const Reported = Data.taggedEnum<Reported>()

/**
 * The one guarded write that ends a job row: it becomes an intent to `route`,
 * or goes when there is none, and with `letter` a dead letter commits in the
 * same transaction. `attempt` names the attempt the write settles, so a stale
 * attempt changes nothing; a success settles at any attempt, since the first
 * success of any attempt wins. `cancelled` is the cancellation state the row
 * must still have. A capped success waits while a newer attempt's lease is
 * live, so it does not free the slot early.
 */
interface Terminal {
  readonly route: JobRoute | undefined
  readonly attempt: number | undefined
  readonly cancelled: boolean
  readonly letter?: {
    readonly attempts: number
    readonly cause: string
    readonly ambiguous: boolean
  }
}

/**
 * How a pass handed a claimed row to its attempt: when the claim was sent,
 * the cancellation check current at the claim and a way to read the next one,
 * and the lease end the relay moves with clock jumps.
 */
interface Claim {
  readonly at: bigint
  readonly signal: Deferred.Deferred<void>
  readonly next: () => Deferred.Deferred<void>
  readonly lease: { until: number }
}

/** The settle-time state of a job row whose failure was just recorded. */
interface Recorded {
  readonly cancelled: boolean
  readonly maybe_applied: boolean
  readonly ambiguous: boolean
}

/** What a cancelled job without a result reports: `Failed` only when no attempt can have applied the call. */
const known = (ambiguous: boolean, maybeApplied: boolean) =>
  ambiguous || maybeApplied ? ("Unknown" as const) : ("Failed" as const)

const cancelledCause = (attempts: number) =>
  `Cancelled while attempt ${attempts} was running; the provider may have applied it`

/**
 * The job attempts of one runner's relay. `run` executes one claimed row and
 * settles it; the returned effect reports whether the row reached a terminal
 * settle, which closes the job's progress.
 *
 * An attempt renews its claim every `renewEveryMs` while it runs, which also
 * picks up a cancellation committed on another runner; `signal` is the local
 * cancellation check. The lease is measured on this runner from when the last
 * claim or renewal was sent, so the database's lease can only end later, and
 * an attempt that outlives it is interrupted, or never started, since another
 * runner may hold the row and a started call can't be undone. A failed
 * renewal retries at the next interval, and a renewal never shortens a
 * deadline. The attempt is raced against its renewals, which are stopped and
 * awaited before any settling write, so a late renewal can't overwrite a
 * failure's backoff with a fresh lease.
 *
 * Settling first classifies the exit as `Reported`, then applies guarded
 * writes in a fixed order until one takes: a success tries the uncancelled
 * row, then the cancelled one, and otherwise is late; a failure is recorded
 * at its attempt, then ends the row when it was final, the last, or
 * cancelled. A failure is recorded before its dead letter, so a failed
 * dead-letter transaction is retried with this attempt's cause and never
 * reruns the provider. A late success marks the dead letter ambiguous, or
 * records an ambiguous one when its cancellation already settled; it never
 * routes a second outcome. A dead letter that loses to a cancellation settles
 * the row as cancelled instead, and an attempt that never started keeps the
 * row as ambiguous as earlier attempts left it (`maybe_applied`).
 */
export const jobAttempts = Effect.fnUntraced(function* (options: {
  readonly progress: Effect.Success<ReturnType<typeof progressPool>>
  readonly leaseMs: number
  readonly renewEveryMs: number
  readonly wake: Effect.Effect<void>
}) {
  const sql = yield* SqlClient.SqlClient
  const hooks = yield* TurnHooks
  const { progress, leaseMs, renewEveryMs } = options

  const requestOf = (row: ClaimedJob) =>
    Schema.decodeEffect(CallerJson)(row.caller).pipe(
      Effect.flatMap((caller) =>
        Schema.decodeEffect(Request)({
          ref: { tenant: row.tenant_id, actor: row.actor_type, id: row.actor_id },
          caller,
          command: row.command,
          commandId: row.intent_id,
          payload: row.payload,
        }),
      ),
    )

  const run = Effect.fnUntraced(function* (
    row: ClaimedJob,
    registered: RegisteredJob,
    claim: Claim,
  ) {
    const routingKey = BigInt(row.routing_key)

    const annotate = Effect.annotateLogs({
      actor: row.actor_type,
      id: row.actor_id,
      tenant: row.tenant_id,
      job: row.command,
      jobId: row.intent_id,
    })

    const jobRow = sql`routing_key = ${routingKey} AND intent_id = ${row.intent_id}
      AND kind = 'job'`

    const guardOf = (attempt: number | undefined, cancelled: boolean) =>
      sql`${jobRow} ${attempt === undefined ? sql.literal("") : sql`AND attempts = ${attempt}`}
        AND cancelled_at_ms IS ${sql.literal(cancelled ? "NOT NULL" : "NULL")}`

    const write = (route: JobRoute | undefined, guard: Statement.Fragment) =>
      Effect.gen(function* () {
        const at = yield* databaseTime

        const settled =
          route === undefined
            ? yield* sql`DELETE FROM actor_outbox WHERE ${guard} RETURNING 1`
            : yield* sql`UPDATE actor_outbox SET kind = 'intent', command = ${route.command},
                payload = ${route.payload}, payload_version = 0, due_at_ms = ${at},
                scheduled_at_ms = ${at}, attempts = 0, last_error = NULL, ambiguous = false,
                running = false, timer_key = NULL
              WHERE ${guard} RETURNING 1`

        return settled.length > 0
      })

    /** A capped success retries while a newer attempt's lease is live and the row is still there. */
    const writeSuccess = (route: JobRoute | undefined, guard: Statement.Fragment, after: number) =>
      Effect.gen(function* () {
        while (true) {
          const newer = (at: number) => sql`(attempts > ${after} AND running AND due_at_ms > ${at})`

          if (yield* write(route, sql`${guard} AND NOT ${newer(yield* databaseTime)}`)) return true

          const held = yield* sql<{ live: boolean }>`SELECT ${newer(
            yield* databaseTime,
          )} AS live FROM actor_outbox WHERE ${guard}`

          if (held.length === 0) return false

          if (held[0]!.live) yield* Effect.sleep(renewEveryMs)
        }
      })

    const apply = (terminal: Terminal, after = row.attempts) =>
      Effect.gen(function* () {
        const guard = guardOf(terminal.attempt, terminal.cancelled)

        if (terminal.letter === undefined)
          return terminal.attempt === undefined && registered.perActor !== undefined
            ? yield* writeSuccess(terminal.route, guard, after)
            : yield* write(terminal.route, guard)

        const letter = terminal.letter

        return yield* sql.withTransaction(
          Effect.gen(function* () {
            if (!(yield* write(terminal.route, guard))) return false

            yield* Effect.logWarning("Job dead-lettered after its last attempt", letter.cause).pipe(
              annotate,
            )
            yield* tally(Metrics.deadLetters, { actor_type: row.actor_type, job: row.command }, 1)
            yield* sql`INSERT INTO actor_dead_letters (routing_key, job_id, tenant_id, actor_type,
                actor_id, job, payload, payload_version, attempts, cause, ambiguous, dead_at_ms)
              VALUES (${routingKey}, ${row.intent_id}, ${row.tenant_id}, ${row.actor_type},
                ${row.actor_id}, ${row.command}, ${row.payload}, ${row.payload_version},
                ${letter.attempts}, ${letter.cause}, ${letter.ambiguous}, ${yield* databaseTime})`

            const request = yield* requestOf(row).pipe(Effect.option)

            if (Option.isSome(request)) yield* hooks.at("beforeDeadLetterCommit", request.value)

            return true
          }),
        )
      }).pipe(
        Effect.tap((settled) =>
          settled && terminal.route !== undefined ? options.wake : Effect.void,
        ),
      )

    const deadLetter = (attempts: number, cause: string, ambiguous: boolean, cancelled: boolean) =>
      Effect.gen(function* () {
        const letter = { jobId: row.intent_id, attempts, cause, ambiguous }

        return yield* apply({
          route: yield* registered.deadLetter(row.payload, row.payload_version, letter),
          attempt: attempts,
          cancelled,
          letter,
        })
      })

    /**
     * Settles a cancelled job that has no result. Without an `onCancelled`
     * route, an unknown outcome is dead-lettered as ambiguous and a failed
     * one is dropped with a log line.
     */
    const settleCancelled = (attempts: number, outcome: "Failed" | "Unknown", cause: string) =>
      Effect.gen(function* () {
        const ambiguous = outcome === "Unknown"

        if (registered.routesCancelled) {
          const route = yield* registered.cancelled(row.payload, row.payload_version, {
            jobId: row.intent_id,
            attempts,
            outcome: { _tag: outcome, cause },
            ambiguous,
          })

          if (route !== undefined)
            return yield* apply({ route, attempt: attempts, cancelled: true })
        }

        if (ambiguous) return yield* deadLetter(attempts, cause, true, true)

        const dropped = yield* apply({ route: undefined, attempt: attempts, cancelled: true })

        if (dropped)
          yield* Effect.logInfo("Cancelled job dropped after a failed attempt", cause).pipe(
            Effect.annotateLogs({ attempt: attempts }),
            annotate,
          )

        return dropped
      })

    /** Dead-letters the row at `attempts` unless a cancellation took it first, which then settles it. */
    const exhaust = (attempts: number, cause: string, ambiguous: boolean) =>
      Effect.gen(function* () {
        if (yield* deadLetter(attempts, cause, ambiguous, false)) return true

        const [cancelled] = yield* sql<{ maybe_applied: boolean }>`SELECT maybe_applied
          FROM actor_outbox WHERE ${guardOf(attempts, true)}`

        return cancelled === undefined
          ? false
          : yield* settleCancelled(attempts, known(ambiguous, cancelled.maybe_applied), cause)
      })

    const warnAttempt = (message: string) =>
      Effect.logWarning(message).pipe(Effect.annotateLogs({ attempt: row.attempts }), annotate)

    /**
     * A success no settle matched: the row already ended. It marks the dead
     * letter ambiguous, or records an ambiguous one when the cancellation's
     * route already committed; it never routes a second outcome.
     */
    const late = (cancelledRoute: JobRoute | undefined) =>
      Effect.gen(function* () {
        const marked = yield* sql`UPDATE actor_dead_letters SET ambiguous = true
          WHERE routing_key = ${routingKey} AND job_id = ${row.intent_id} RETURNING 1`

        if (marked.length > 0) return yield* warnAttempt("Job succeeded after it was dead-lettered")

        const reported = cancelledRoute?.command

        if (!registered.routesCancelled || reported === undefined) return

        const recorded = yield* sql`INSERT INTO actor_dead_letters (routing_key, job_id,
            tenant_id, actor_type, actor_id, job, payload, payload_version, attempts, cause,
            ambiguous, dead_at_ms)
          SELECT ${routingKey}, ${row.intent_id}, ${row.tenant_id}, ${row.actor_type},
            ${row.actor_id}, ${row.command}, ${row.payload}, ${row.payload_version}, ${row.attempts},
            'Succeeded after it was cancelled', true, ${yield* databaseTime}
          WHERE EXISTS (
            SELECT 1 FROM actor_outbox WHERE routing_key = ${routingKey}
              AND intent_id = ${row.intent_id} AND kind = 'intent' AND command = ${reported}
            UNION ALL
            SELECT 1 FROM actor_receipts WHERE routing_key = ${routingKey}
              AND tenant_id = ${row.tenant_id} AND actor_type = ${row.actor_type}
              AND actor_id = ${row.actor_id} AND command_id = ${row.intent_id}
              AND command = ${reported}
          )
          ON CONFLICT (routing_key, job_id) DO UPDATE SET ambiguous = true
          RETURNING 1`

        if (recorded.length > 0) yield* warnAttempt("Job succeeded after its cancellation settled")
      })

    /** Records a failure at its attempt; undefined when a newer attempt or a settle took the row. */
    const record = (failure: JobFailure) =>
      Effect.gen(function* () {
        const attempt = row.attempts
        const { baseMs, maxMs } = registered.backoff

        const [recorded] = yield* sql<Recorded>`UPDATE actor_outbox
          SET last_error = ${failure.cause},
            ambiguous = ${failure.notStarted === true ? sql`maybe_applied` : sql`${failure.ambiguous}`},
            running = false, final_failure = ${failure.final === true},
            due_at_ms = ${(yield* databaseTime) + Math.min(baseMs * 2 ** (attempt - 1), maxMs)}
          WHERE ${jobRow} AND attempts = ${attempt}
          RETURNING cancelled_at_ms IS NOT NULL AS cancelled, maybe_applied, ambiguous`

        return recorded
      })

    /**
     * Records a failure, then ends the row when it was cancelled, final, or the
     * last attempt. A `rejected` result succeeded at the provider, so it goes to
     * `onCancelled` when the row was cancelled, and is late when no row took it.
     */
    const failed = (failure: JobFailure, cancelledRoute: JobRoute | undefined, rejected: boolean) =>
      Effect.gen(function* () {
        const attempt = row.attempts
        const routesResult = cancelledRoute !== undefined && registered.routesCancelled

        if (
          routesResult &&
          (yield* apply({ route: cancelledRoute, attempt: undefined, cancelled: true }))
        )
          return true

        const recorded = yield* record(failure)

        if (recorded === undefined) {
          if (rejected) yield* late(cancelledRoute)
          else
            yield* warnAttempt("Job attempt failed after a newer attempt or a settle took its row")

          return false
        }

        if (recorded.cancelled) {
          if (routesResult && (yield* apply({ route: cancelledRoute, attempt, cancelled: true })))
            return true

          return yield* settleCancelled(
            attempt,
            known(recorded.ambiguous, recorded.maybe_applied),
            failure.cause,
          )
        }

        if (failure.final === true || attempt >= registered.attempts)
          return yield* exhaust(attempt, failure.cause, recorded.ambiguous)

        yield* Effect.logWarning("Job attempt failed; retrying with backoff", failure.cause).pipe(
          Effect.annotateLogs({ attempt, ambiguous: recorded.ambiguous }),
          annotate,
        )
        yield* tally(Metrics.relayRetried, { kind: "job" }, 1)

        return false
      })

    const settle = Reported.$match({
      Unattempted: () => {
        const attempt = row.attempts

        if (row.cancelled && attempt === 0)
          return apply({ route: undefined, attempt: 0, cancelled: true })

        if (row.cancelled)
          return settleCancelled(
            attempt,
            known(row.ambiguous, row.maybe_applied),
            row.last_error ??
              (row.ambiguous || row.maybe_applied
                ? cancelledCause(attempt)
                : "Failed before it was cancelled"),
          )

        return exhaust(attempt, row.last_error ?? "No attempt reported", row.ambiguous)
      },
      Interrupted: () =>
        Effect.logInfo("Job attempt interrupted by its cancellation").pipe(
          Effect.annotateLogs({ attempt: row.attempts }),
          annotate,
          Effect.andThen(settleCancelled(row.attempts, "Unknown", cancelledCause(row.attempts))),
        ),
      Succeeded: ({ success, cancelled }) =>
        Effect.gen(function* () {
          if (yield* apply({ route: success, attempt: undefined, cancelled: false })) {
            yield* tally(Metrics.relayDelivered, { kind: "job" }, 1)

            return true
          }

          const route = registered.routesCancelled ? cancelled : success

          if (yield* apply({ route, attempt: undefined, cancelled: true })) return true

          yield* late(cancelled)

          return false
        }),
      Rejected: ({ failure, cancelled }) => failed(failure, cancelled, true),
      Failed: ({ failure }) => failed(failure, undefined, false),
    })

    if (row.cancelled || row.exhausted) return yield* settle(Reported.Unattempted())

    const attempt = row.attempts
    const request = yield* requestOf(row).pipe(Effect.orDie)
    const ref = ActorRef.make(request.ref)
    const leaseNanos = BigInt(leaseMs) * 1_000_000n
    let confirmed = claim.at

    yield* hooks.at("afterClaim", request)
    yield* hooks.at("beforeExecute", request)

    if ((yield* Clock.currentTimeNanos) - confirmed >= leaseNanos) {
      yield* warnAttempt("Job attempt outlived its lease before it started")

      return false
    }

    let signal = claim.signal

    const renewals = Effect.gen(function* () {
      while (true) {
        yield* Deferred.await(signal).pipe(
          Effect.timeoutOrElse({ duration: renewEveryMs, orElse: () => Effect.void }),
        )
        signal = claim.next()
        const sent = yield* Clock.currentTimeNanos

        const renewed = yield* Effect.gen(function* () {
          yield* hooks.at("beforeRenew", request)

          return yield* sql<{ cancelled: boolean; due_at_ms: string }>`UPDATE actor_outbox
              SET due_at_ms = greatest(due_at_ms, ${(yield* databaseTime) + leaseMs})
              WHERE ${jobRow} AND attempts = ${attempt}
              RETURNING cancelled_at_ms IS NOT NULL AS cancelled, due_at_ms::text AS due_at_ms`.pipe(
            Effect.uninterruptible,
          )
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("Job lease renewal failed", cause).pipe(
                  annotate,
                  Effect.as(undefined),
                ),
          ),
        )

        if (renewed === undefined) continue

        if (renewed.length === 0) return "lost" as const
        confirmed = sent
        claim.lease.until = Number(renewed[0]!.due_at_ms)

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
      jobId: row.intent_id,
      job: row.command,
      attempt,
      everyMs: registered.progressEveryMs,
      leaseUntil: () => claim.lease.until,
    })

    return yield* Effect.gen(function* () {
      const outcome = yield* registered
        .execute(row.payload, row.payload_version, {
          jobId: row.intent_id,
          attempt,
          principal: principal(request.caller),
          ref,
          reporting: slot.active,
          report: slot.offer,
        })
        .pipe(
          Effect.withSpan(
            SpanNames.job(row.actor_type, row.command),
            {
              kind: "client",
              attributes: {
                "actor.type": row.actor_type,
                "actor.tenant": row.tenant_id,
                "actor.id": row.actor_id,
                "job.name": row.command,
                "job.id": row.intent_id,
                "job.attempt": attempt,
              },
            },
            { captureStackTrace: false },
          ),
          Effect.result,
          Effect.raceFirst(renewals),
          Effect.raceFirst(deadline),
          Effect.ensuring(slot.close),
        )

      if (outcome === "lost") {
        yield* warnAttempt("Job attempt lost its lease")

        return false
      }

      if (outcome === "deadline") {
        yield* warnAttempt("Job attempt outlived its lease; interrupted")

        return false
      }

      if (outcome === "cancelled") return yield* settle(Reported.Interrupted())

      if (Result.isFailure(outcome))
        return yield* settle(Reported.Failed({ failure: outcome.failure }))

      const { success, cancelled, rejected } = outcome.success

      if (rejected === undefined || registered.routesCancelled)
        yield* hooks.at("afterExecute", request)

      return yield* settle(
        rejected === undefined
          ? Reported.Succeeded({ success, cancelled })
          : Reported.Rejected({ failure: rejected, cancelled }),
      )
    }).pipe(Effect.ensuring(progress.forget(row.intent_id)))
  })

  /**
   * Runs one claimed row and settles it. A terminal settle closes the job's
   * progress; a retryable one leaves it open. A settled attempt of a capped
   * job wakes the oldest waiting row of its actor.
   */
  return (row: ClaimedJob, registered: RegisteredJob, claim: Claim) => {
    const attempt = run(row, registered, claim).pipe(
      Effect.tap((terminal) =>
        terminal
          ? requestOf(row).pipe(
              Effect.flatMap((request) =>
                progress.closed({
                  ref: ActorRef.make(request.ref),
                  jobId: row.intent_id,
                  job: row.command,
                  attempt: row.attempts,
                  everyMs: registered.progressEveryMs,
                }),
              ),
              Effect.ignore,
            )
          : Effect.void,
      ),
    )

    return registered.perActor === undefined
      ? attempt
      : attempt.pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              const woke = yield* wakeWaiting({ sql, group: row, at: yield* databaseTime })

              if (woke.length > 0) yield* options.wake
            }).pipe(Effect.ignore),
          ),
        )
  }
})
