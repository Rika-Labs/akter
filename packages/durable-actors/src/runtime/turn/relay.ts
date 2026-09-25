import { Cause, Effect, Queue, Result, Schema, Semaphore } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { ActorError } from "../../errors/actor.ts"
import { Outcome, Request } from "../../handles/actors.ts"
import { TurnHooks } from "./hooks.ts"
import { BUCKETS, CallerJson, outboxTime } from "./outbox.ts"

/** Durable polling is the correctness path; a post-commit wake only shortens it. */
const POLL_INTERVAL = "1 second"

export const PASS_LIMIT = 256

/** A drain that keeps finding due work after this many passes is a delivery loop. */
const DRAIN_PASSES = 100

interface DueIntent {
  readonly routing_key: string
  readonly intent_id: string
  readonly tenant_id: string
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
  sql<DueIntent>`SELECT o.routing_key::text AS routing_key, o.intent_id, o.tenant_id,
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
 */
export const outboxRelay = Effect.fnUntraced(function* (
  deliver: (request: Request) => Effect.Effect<Outcome, ActorError>,
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

  const pass = lock
    .withPermit(
      Effect.gen(function* () {
        const now = yield* outboxTime
        const due = yield* scanDue({ sql, now, limit: PASS_LIMIT })

        const settled = yield* Effect.forEach(
          due,
          (row) =>
            settle(row, now).pipe(
              Effect.as(true),
              logFailure("Outbox relay crashed delivering an intent"),
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
