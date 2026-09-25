import { Cause, Effect, Queue, Result, Schema, Semaphore } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { ActorError } from "../../errors/actor.ts"
import { Outcome, type RegisteredEffect, Request } from "../../handles/actors.ts"
import { ActorRef, principal } from "../../identity/caller.ts"
import { TurnHooks } from "./hooks.ts"
import { BUCKETS, CallerJson, outboxTime } from "./outbox.ts"

/** Durable polling is the correctness path; a post-commit wake only shortens it. */
const POLL_INTERVAL = "1 second"

export const PASS_LIMIT = 256

/** A drain that keeps finding due work after this many passes is a delivery loop. */
const DRAIN_PASSES = 100

/** An executor attempt keeps its row out of scans this long: its timeout plus margin. */
const EXECUTION_LEASE_MS = 60_000

/** How long an effect waits when this process registers no executor for it. */
const UNREGISTERED_DELAY_MS = 60_000

const backoffMs = (attempts: number) => 1000 * 2 ** Math.min(attempts, 8)

interface DueIntent {
  readonly routing_key: string
  readonly intent_id: string
  readonly kind: "intent" | "effect"
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
}

/**
 * The due-work scan: one `(bucket, due_at_ms)` index probe per owned bucket,
 * so its cost follows due rows, not stored actors or future timers.
 */
export const scanDue = ({
  sql,
  now,
  limit,
}: {
  readonly sql: SqlClient.SqlClient
  readonly now: number
  readonly limit: number
}) =>
  sql<DueIntent>`SELECT o.routing_key::text AS routing_key, o.intent_id, o.kind, o.attempts,
      o.last_error, o.ambiguous, o.tenant_id, o.actor_type, o.actor_id,
      o.target_type, o.target_id, o.command, o.payload, o.caller
    FROM generate_series(${BUCKETS.first}::int, ${BUCKETS.last}::int) AS b(bucket)
    CROSS JOIN LATERAL (
      SELECT * FROM actor_outbox
      WHERE actor_outbox.bucket = b.bucket AND actor_outbox.due_at_ms <= ${now}
      ORDER BY actor_outbox.due_at_ms LIMIT ${limit}
    ) o
    ORDER BY o.due_at_ms LIMIT ${limit}`

const logFailure =
  (message: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A | void, never, R> =>
    Effect.catchCause(self, (cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.logError(message, cause),
    )

/**
 * The outbox relay of a single runner, which owns every bucket. It delivers
 * each due intent as a direct command whose command id is the intent id, and
 * deletes the row only after the receiver's receipt has committed. A crash
 * anywhere leaves the row for the next pass; the receipt deduplicates.
 *
 * A due effect row runs its executor, then turns into an intent to its
 * `onSuccess` route, or to `onDeadLetter` once retries are exhausted, in the
 * same statement that records the outcome. The route is then delivered like
 * any intent, so it commits once per effect id however often the executor ran.
 */
export const outboxRelay = Effect.fnUntraced(function* (
  deliver: (request: Request) => Effect.Effect<Outcome, ActorError>,
  executor: (actor: string, effect: string) => RegisteredEffect | undefined,
) {
  const sql = yield* SqlClient.SqlClient
  const services = yield* Effect.context<SqlClient.SqlClient>()
  const lock = Semaphore.makeUnsafe(1)
  const signals = yield* Queue.sliding<void>(1)

  const settle = Effect.fnUntraced(function* (row: DueIntent, now: number) {
    const routingKey = BigInt(row.routing_key)

    const retryLater = (reason: string, cause: unknown) =>
      Effect.gen(function* () {
        // Retries have no limit yet; this warning and `attempts` are the operator signal.
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
        yield* sql`UPDATE actor_outbox SET attempts = attempts + 1,
            due_at_ms = ${now} + (1000 * power(2, least(attempts, 8)))::bigint
          WHERE routing_key = ${routingKey} AND intent_id = ${row.intent_id}`
      })

    // A row that cannot form a request backs off like a failed delivery instead of dying on every pass.
    const decoded = yield* Schema.decodeEffect(CallerJson)(row.caller).pipe(
      Effect.flatMap((caller) =>
        Schema.decodeEffect(Request)({
          ref: { tenant: row.tenant_id, actor: row.target_type, id: row.target_id },
          caller,
          command: row.command,
          commandId: row.intent_id,
          payload: row.payload,
        }),
      ),
      Effect.result,
    )

    if (Result.isFailure(decoded)) return yield* retryLater("UnreadableRow", decoded.failure)

    const request = decoded.success

    const delivered = yield* deliver(request).pipe(Effect.result)

    if (Result.isFailure(delivered))
      return yield* retryLater(delivered.failure.reason._tag, delivered.failure)

    // A declared failure is a committed receipt too; only a missing receipt retries.
    if (Outcome.guards.Defect(delivered.success))
      return yield* retryLater("Defect", delivered.success.cause)

    yield* (yield* TurnHooks).at("beforeOutboxDelete", request)
    yield* sql`DELETE FROM actor_outbox WHERE routing_key = ${routingKey} AND intent_id = ${row.intent_id}`
  })

  const settleEffect = Effect.fnUntraced(function* (row: DueIntent, now: number) {
    const routingKey = BigInt(row.routing_key)
    const hooks = yield* TurnHooks

    const annotate = Effect.annotateLogs({
      actor: row.actor_type,
      id: row.actor_id,
      tenant: row.tenant_id,
      effect: row.command,
      effectId: row.intent_id,
    })

    // Every write names the attempt it settles, so a stale attempt changes nothing.
    const attemptRow = (attempts: number) =>
      sql`routing_key = ${routingKey} AND intent_id = ${row.intent_id} AND kind = 'effect' AND attempts = ${attempts}`

    // The row becomes an intent to `route`, or goes when there is none.
    const settleTo = (
      route: { readonly command: string; readonly payload: string } | undefined,
      attempts: number,
    ) =>
      Effect.gen(function* () {
        const at = yield* outboxTime

        const settled =
          route === undefined
            ? yield* sql`DELETE FROM actor_outbox WHERE ${attemptRow(attempts)} RETURNING 1`
            : yield* sql`UPDATE actor_outbox SET kind = 'intent', command = ${route.command},
                payload = ${route.payload}, due_at_ms = ${at}, attempts = 0, last_error = NULL,
                ambiguous = false
              WHERE ${attemptRow(attempts)} RETURNING 1`

        if (route !== undefined && settled.length > 0) yield* Queue.offer(signals, undefined)

        return settled.length > 0
      })

    const registered = executor(row.actor_type, row.command)

    if (registered === undefined) {
      yield* Effect.logWarning("No executor registered for a due effect; retrying later").pipe(
        annotate,
      )

      return yield* sql`UPDATE actor_outbox SET due_at_ms = ${now + UNREGISTERED_DELAY_MS}
        WHERE ${attemptRow(row.attempts)}`
    }

    const exhaust = (attempts: number, cause: string, ambiguous: boolean) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const letter = { effectId: row.intent_id, attempts, cause, ambiguous }

          if (!(yield* settleTo(yield* registered.deadLetter(row.payload, letter), attempts)))
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

    // A crashed attempt left its claim behind: its outcome is still unknown.
    if (row.attempts >= registered.attempts)
      return yield* exhaust(row.attempts, row.last_error ?? "No attempt reported", row.ambiguous)

    const attempt = row.attempts + 1

    // Claiming records the attempt before the provider can see it, so a crash
    // during the call is counted and reported as an unknown outcome.
    const claimed = yield* sql`UPDATE actor_outbox SET attempts = ${attempt},
        due_at_ms = ${now + EXECUTION_LEASE_MS}, ambiguous = true,
        last_error = ${`Attempt ${attempt} ended without reporting an outcome`}
      WHERE ${attemptRow(row.attempts)} RETURNING 1`

    if (claimed.length === 0) return

    const caller = yield* Schema.decodeEffect(CallerJson)(row.caller).pipe(Effect.orDie)
    const ref = ActorRef.make({ tenant: row.tenant_id, actor: row.actor_type, id: row.actor_id })

    const request = Request.make({
      ref,
      caller,
      command: row.command,
      commandId: row.intent_id,
      payload: row.payload,
    })

    yield* hooks.at("beforeExecute", request)

    const outcome = yield* registered
      .execute(row.payload, {
        effectId: row.intent_id,
        attempt,
        principal: principal(caller),
        ref,
      })
      .pipe(Effect.result)

    if (Result.isSuccess(outcome)) {
      yield* hooks.at("afterExecute", request)

      return yield* settleTo(outcome.success, attempt)
    }

    const { cause, ambiguous } = outcome.failure

    if (attempt >= registered.attempts) return yield* exhaust(attempt, cause, ambiguous)

    yield* Effect.logWarning("Effect attempt failed; retrying with backoff", cause).pipe(
      Effect.annotateLogs({ attempt, ambiguous }),
      annotate,
    )
    yield* sql`UPDATE actor_outbox SET last_error = ${cause}, ambiguous = ${ambiguous},
        due_at_ms = ${(yield* outboxTime) + backoffMs(attempt - 1)}
      WHERE ${attemptRow(attempt)}`
  })

  const pass = lock
    .withPermit(
      Effect.gen(function* () {
        const now = yield* outboxTime
        const due = yield* scanDue({ sql, now, limit: PASS_LIMIT })

        const settled = yield* Effect.forEach(
          due,
          (row) =>
            (row.kind === "effect" ? settleEffect(row, now) : settle(row, now)).pipe(
              Effect.as(true),
              logFailure("Outbox relay crashed settling a row"),
            ),
          { concurrency: 16 },
        )

        // A row whose settle died is still due; only deleted or rescheduled rows are progress.
        return { due: due.length, settled: settled.filter((done) => done === true).length }
      }),
    )
    .pipe(Effect.provideContext(services))

  const run = Effect.gen(function* () {
    let backlog = false

    while (true) {
      // A full pass that settled every row means more are already due, so waiting would cap the
      // relay at one pass per poll. Rows that died unsettled are rescanned at once, so any such
      // row sends the loop back to waiting instead of spinning on it.
      if (!backlog) yield* Queue.take(signals).pipe(Effect.timeoutOption(POLL_INTERVAL))
      const result = yield* pass.pipe(logFailure("Outbox relay pass failed"))
      backlog = result !== undefined && result.settled === PASS_LIMIT
    }
  })

  const drain = Effect.gen(function* () {
    for (let passes = 0; passes < DRAIN_PASSES; passes++) if ((yield* pass).due === 0) return

    return yield* Effect.die(new Error("Outbox did not settle; intents keep producing due work"))
  }).pipe(Effect.orDie)

  return { run, drain, wake: Queue.offer(signals, undefined).pipe(Effect.asVoid) }
})
