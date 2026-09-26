import { Cause, Clock, Effect, FiberSet, Queue, Random, Result, Schema, Semaphore } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { ActorError } from "../../errors/actor.ts"
import { Outcome, type RegisteredEffect, Request } from "../../handles/actors.ts"
import { ActorRef, principal } from "../../identity/caller.ts"
import { TurnHooks } from "./hooks.ts"
import { BUCKETS, CallerJson, outboxTime } from "./outbox.ts"

/** A drain that keeps finding due work after this many rounds is a delivery loop. */
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
  sql`o.routing_key::text AS routing_key, o.intent_id, o.attempts, o.last_error, o.ambiguous,
    o.tenant_id, o.actor_type, o.actor_id, o.target_type, o.target_id, o.command, o.payload,
    o.caller, o.due_at_ms::text AS claimed_until`

/**
 * The due-work probe: one `(bucket, kind, due_at_ms)` index range per bucket,
 * so its cost follows due rows of one kind, not stored actors or future timers.
 * It takes no locks; a claim locks only the rows it takes from it.
 */
const candidates = (
  sql: SqlClient.SqlClient,
  kind: "intent" | "effect",
  now: number,
  limit: number,
) =>
  sql`SELECT o.routing_key, o.intent_id, o.actor_type, o.command
    FROM generate_series(${BUCKETS.first}::int, ${BUCKETS.last}::int) AS b(bucket)
    CROSS JOIN LATERAL (
      SELECT routing_key, intent_id, due_at_ms, actor_type, command FROM actor_outbox
      WHERE actor_outbox.bucket = b.bucket AND actor_outbox.kind = ${kind}
        AND actor_outbox.due_at_ms <= ${now}
      ORDER BY actor_outbox.due_at_ms LIMIT ${limit}
    ) o`

/**
 * Claims up to `limit` due intents. `SKIP LOCKED` passes over rows another
 * runner is claiming, and the claim moves each row's `due_at_ms` past the
 * lease, so no runner scans it again until the lease ends. A row whose settle
 * dies therefore waits `max(lease, backoff(attempts))` instead of sorting
 * ahead of newer work.
 */
export const claimIntents = ({
  sql,
  now,
  limit,
  leaseMs,
  maxBackoffMs,
}: {
  readonly sql: SqlClient.SqlClient
  readonly now: number
  readonly limit: number
  readonly leaseMs: number
  readonly maxBackoffMs: number
}) =>
  sql<ClaimedRow>`WITH candidates AS (
      ${candidates(sql, "intent", now, 2 * limit)}
      ORDER BY o.due_at_ms LIMIT ${2 * limit}
    ),
    claimed AS (
      SELECT o.routing_key, o.intent_id FROM actor_outbox o
      JOIN candidates USING (routing_key, intent_id)
      WHERE o.kind = 'intent' AND o.due_at_ms <= ${now}
      ORDER BY o.due_at_ms LIMIT ${limit}
      FOR UPDATE OF o SKIP LOCKED
    )
    UPDATE actor_outbox o SET attempts = o.attempts + 1,
      due_at_ms = ${now} + greatest(${leaseMs}::bigint,
        least(1000 * power(2, least(o.attempts, 20)), ${maxBackoffMs}::bigint))::bigint
    FROM claimed c
    WHERE o.routing_key = c.routing_key AND o.intent_id = c.intent_id
    RETURNING ${claimedColumns(sql)}, (SELECT count(*) FROM candidates)::int AS candidates`

/**
 * Claims up to `permits` due effects that this runner has executors for, as
 * the next attempt of each. An effect with no executor here is never
 * claimed here; it stays due for a runner that has one.
 */
export const claimEffects = ({
  sql,
  now,
  permits,
  leaseMs,
  executors,
}: {
  readonly sql: SqlClient.SqlClient
  readonly now: number
  readonly permits: number
  readonly leaseMs: number
  readonly executors: ReadonlyArray<LocalExecutor>
}) =>
  sql<ClaimedEffect>`WITH mine (actor_type, command, max_attempts) AS (
      VALUES ${sql.csv(
        executors.map(
          ({ actor, effect, registered }) =>
            sql`(${actor}::text, ${effect}::text, ${registered.attempts}::int)`,
        ),
      )}
    ),
    candidates AS (
      ${candidates(sql, "effect", now, 2 * permits)}
      JOIN mine USING (actor_type, command)
      ORDER BY o.due_at_ms LIMIT ${2 * permits}
    ),
    claimed AS (
      SELECT o.routing_key, o.intent_id, o.attempts AS previous, m.max_attempts FROM actor_outbox o
      JOIN candidates USING (routing_key, intent_id)
      JOIN mine m ON m.actor_type = o.actor_type AND m.command = o.command
      WHERE o.kind = 'effect' AND o.due_at_ms <= ${now}
      ORDER BY o.due_at_ms LIMIT ${permits}
      FOR UPDATE OF o SKIP LOCKED
    )
    -- RETURNING sees the updated row, so exhaustion is judged on the attempts before this claim.
    UPDATE actor_outbox o SET
      due_at_ms = ${now} + ${leaseMs}::bigint,
      attempts = CASE WHEN o.attempts < c.max_attempts THEN o.attempts + 1 ELSE o.attempts END,
      ambiguous = CASE WHEN o.attempts < c.max_attempts THEN true ELSE o.ambiguous END,
      last_error = CASE WHEN o.attempts < c.max_attempts
        THEN 'Attempt ' || (o.attempts + 1) || ' ended without reporting an outcome'
        ELSE o.last_error END
    FROM claimed c
    WHERE o.routing_key = c.routing_key AND o.intent_id = c.intent_id
    RETURNING ${claimedColumns(sql)}, (SELECT count(*) FROM candidates)::int AS candidates,
      c.previous >= c.max_attempts AS exhausted`

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
  let stopping = false

  const backoffMs = (attempts: number) =>
    Math.min(1000 * 2 ** Math.max(attempts - 1, 0), settings.maxBackoffMs)

  const requestOf = (row: ClaimedRow, target: "receiver" | "sender") =>
    Schema.decodeEffect(CallerJson)(row.caller).pipe(
      Effect.flatMap((caller) =>
        Schema.decodeEffect(Request)({
          ref:
            target === "receiver"
              ? { tenant: row.tenant_id, actor: row.target_type, id: row.target_id }
              : { tenant: row.tenant_id, actor: row.actor_type, id: row.actor_id },
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
    let started = false

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
        yield* sql`UPDATE actor_outbox SET due_at_ms = ${(yield* outboxTime) + backoffMs(row.attempts)}
          WHERE ${claim}`
      })

    return yield* Effect.gen(function* () {
      // A row that cannot form a request backs off like a failed delivery instead of dying on every claim.
      const decoded = yield* requestOf(row, "receiver").pipe(Effect.result)

      if (Result.isFailure(decoded)) return yield* retryLater("UnreadableRow", decoded.failure)

      const request = decoded.success
      yield* hooks.at("afterClaim", request)
      started = true

      const delivered = yield* deliver(request).pipe(Effect.result)

      if (Result.isFailure(delivered))
        return yield* retryLater(delivered.failure.reason._tag, delivered.failure)

      // A declared failure is a committed receipt too; only a missing receipt retries.
      if (Outcome.guards.Defect(delivered.success))
        return yield* retryLater("Defect", delivered.success.cause)

      yield* hooks.at("beforeOutboxDelete", request)
      yield* sql`DELETE FROM actor_outbox WHERE ${claim}`
    }).pipe(
      // A row claimed but never handed to its receiver goes back at once on shutdown.
      Effect.onInterrupt(() =>
        started
          ? Effect.void
          : Effect.gen(function* () {
              yield* sql`UPDATE actor_outbox SET due_at_ms = ${yield* outboxTime} WHERE ${claim}`
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
        const at = yield* outboxTime

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
          const letter = { effectId: row.intent_id, attempts, cause, ambiguous }

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
              ${yield* outboxTime})`
        }),
      )

    // The last attempt ended without an outcome, or its dead letter failed after recording one.
    if (row.exhausted)
      return yield* exhaust(row.attempts, row.last_error ?? "No attempt reported", row.ambiguous)

    const attempt = row.attempts
    const request = yield* requestOf(row, "sender").pipe(Effect.orDie)
    const ref = ActorRef.make(request.ref)
    yield* hooks.at("afterClaim", request)
    yield* hooks.at("beforeExecute", request)

    const leaseNanos = BigInt(settings.executorLeaseMs) * 1_000_000n
    // Measured on this runner from when the last claim or renewal was sent, so
    // the database's lease can only end later than this one.
    let confirmed = claimedAt

    const renewals = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(settings.executorLeaseMs / 3)
        const sent = yield* Clock.currentTimeNanos
        yield* hooks.at("beforeRenew", request)

        const renewed = yield* sql`UPDATE actor_outbox
            SET due_at_ms = ${(yield* outboxTime) + settings.executorLeaseMs}
            WHERE ${attemptRow(attempt)} RETURNING 1`.pipe(Effect.uninterruptible, Effect.result)

        if (Result.isFailure(renewed)) {
          yield* Effect.logWarning("Effect lease renewal failed", renewed.failure).pipe(annotate)
          continue
        }

        if (renewed.success.length === 0) return "lost" as const
        confirmed = sent
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Effect lease renewal failed", cause).pipe(
              Effect.andThen(Effect.never),
            ),
      ),
    )

    const deadline = Effect.gen(function* () {
      while (true) {
        const left = confirmed + leaseNanos - (yield* Clock.currentTimeNanos)

        if (left <= 0n) return "deadline" as const
        yield* Effect.sleep(Number(left / 1_000_000n) + 1)
      }
    })

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

    if (Result.isSuccess(outcome)) {
      yield* hooks.at("afterExecute", request)

      // The first success of any attempt wins; the row stops being an effect.
      if (yield* settleTo(outcome.success, effectRow)) return

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
        due_at_ms = ${(yield* outboxTime) + Math.min(baseMs * 2 ** (attempt - 1), maxMs)}
      WHERE ${attemptRow(attempt)}`

    if (last) return yield* exhaust(attempt, cause, ambiguous)

    yield* Effect.logWarning("Effect attempt failed; retrying with backoff", cause).pipe(
      Effect.annotateLogs({ attempt, ambiguous }),
      annotate,
    )
  })

  const freed = (kind: "intents" | "effects") =>
    Effect.suspend(() => (more[kind] ? Queue.offer(signals, undefined) : Effect.void))

  const pass = lock
    .withPermit(
      Effect.gen(function* () {
        if (stopping) return 0

        let claimed = 0
        const slots = Math.min(
          settings.deliveryConcurrency - (yield* FiberSet.size(deliveries)),
          settings.passLimit,
        )

        if (slots > 0) {
          const rows = yield* claimIntents({
            sql,
            now: yield* outboxTime,
            limit: slots,
            leaseMs: settings.claimLeaseMs(),
            maxBackoffMs: settings.maxBackoffMs,
          })

          more.intents = rows.length > 0 && rows[0]!.candidates > rows.length
          claimed += rows.length

          for (const row of rows)
            yield* FiberSet.run(
              deliveries,
              deliverIntent(row).pipe(
                logFailure("Outbox relay crashed settling a row"),
                Effect.ensuring(freed("intents")),
              ),
            )
        }

        const local = executors()
        const permits = settings.executorConcurrency - (yield* FiberSet.size(attempts))

        if (permits > 0 && local.length > 0) {
          const claimedAt = yield* Clock.currentTimeNanos

          const rows = yield* claimEffects({
            sql,
            now: yield* outboxTime,
            permits,
            leaseMs: settings.executorLeaseMs,
            executors: local,
          })

          more.effects = rows.length > 0 && rows[0]!.candidates > rows.length
          claimed += rows.length

          for (const row of rows) {
            const registered = local.find(
              ({ actor, effect }) => actor === row.actor_type && effect === row.command,
            )!.registered

            yield* FiberSet.run(
              attempts,
              runAttempt(row, registered, claimedAt).pipe(
                logFailure("Effect attempt crashed before it settled"),
                Effect.ensuring(freed("effects")),
              ),
            )
          }
        }

        return claimed
      }),
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

  const inFlight = Effect.gen(function* () {
    return (yield* FiberSet.size(deliveries)) + (yield* FiberSet.size(attempts))
  })

  // Waits for in-flight work, which may stage more, then claims again; done
  // once a claim finds nothing and nothing is running.
  const drain = Effect.gen(function* () {
    for (let rounds = 0; rounds < DRAIN_ROUNDS;) {
      yield* idle
      const claimed = yield* pass

      if (claimed === 0 && (yield* inFlight) === 0) return
      if (claimed > 0) rounds++
    }

    return yield* Effect.die(new Error("Outbox did not settle; intents keep producing due work"))
  }).pipe(Effect.orDie)

  // Shutdown stops claims; unstarted intents release in their interrupt handler.
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      stopping = true
    }),
  )

  return {
    run,
    drain,
    wake: Queue.offer(signals, undefined).pipe(Effect.asVoid),
  }
})
