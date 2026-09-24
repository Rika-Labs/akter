import { Cause, Effect, Queue, Result, Schema, Semaphore } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { ActorError } from "../../errors/actor.ts"
import { Outcome, Request } from "../../handles/actors.ts"
import { ActorRef } from "../../identity/caller.ts"
import { TurnHooks } from "./hooks.ts"
import { BUCKETS, CallerJson, outboxTime } from "./outbox.ts"

/** Durable polling is the correctness path; a post-commit wake only shortens it. */
const POLL_INTERVAL = "1 second"

const PASS_LIMIT = 256

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

    const request = Request.make({
      ref: ActorRef.make({ tenant: row.tenant_id, actor: row.target_type, id: row.target_id }),
      caller: yield* Schema.decodeEffect(CallerJson)(row.caller).pipe(Effect.orDie),
      command: row.command,
      commandId: row.intent_id,
      payload: row.payload,
    })

    const delivered = yield* deliver(request).pipe(Effect.result)

    // A declared failure is a committed receipt too; only a missing receipt retries.
    if (Result.isSuccess(delivered) && !Outcome.guards.Defect(delivered.success)) {
      yield* (yield* TurnHooks).at("beforeOutboxDelete", request)
      yield* sql`DELETE FROM actor_outbox WHERE routing_key = ${routingKey} AND intent_id = ${row.intent_id}`

      return
    }

    yield* Effect.logWarning("Outbox delivery failed; retrying with backoff").pipe(
      Effect.annotateLogs({
        actor: row.target_type,
        id: row.target_id,
        tenant: row.tenant_id,
        command: row.command,
        commandId: row.intent_id,
      }),
    )
    yield* sql`UPDATE actor_outbox SET attempts = attempts + 1,
        due_at_ms = ${now} + (1000 * power(2, least(attempts, 8)))::bigint
      WHERE routing_key = ${routingKey} AND intent_id = ${row.intent_id}`
  })

  const pass = lock
    .withPermit(
      Effect.gen(function* () {
        const now = yield* outboxTime
        const due = yield* scanDue({ sql, now, limit: PASS_LIMIT })

        yield* Effect.forEach(
          due,
          (row) => settle(row, now).pipe(logFailure("Outbox relay crashed delivering an intent")),
          { concurrency: 16, discard: true },
        )

        return due.length
      }),
    )
    .pipe(Effect.provideContext(services))

  const run = Effect.gen(function* () {
    while (true) {
      yield* Queue.take(signals).pipe(Effect.timeoutOption(POLL_INTERVAL))
      yield* pass.pipe(logFailure("Outbox relay pass failed"))
    }
  })

  const drain = Effect.gen(function* () {
    for (let passes = 0; passes < DRAIN_PASSES; passes++) if ((yield* pass) === 0) return

    return yield* Effect.die(new Error("Outbox did not settle; intents keep producing due work"))
  }).pipe(Effect.orDie)

  return { run, drain, wake: Queue.offer(signals, undefined).pipe(Effect.asVoid) }
})
