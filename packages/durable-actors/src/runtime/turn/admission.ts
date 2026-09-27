import { Context, Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { ActorError, CommandExpired, InvalidCommandId } from "../../errors/actor.ts"
import type { Request } from "../../handles/actors.ts"
import { CommandId, commandTimes } from "../../identity/command.ts"
import { hashCanonical, type StoredReceipt } from "./receipt.ts"

/**
 * Shifts the framework clock: command ids, their expiry, timers, event
 * timestamps, and retention all read database time plus this offset. Only
 * `ActorTest.advance` moves it, so every one of them moves together.
 */
export const FrameworkClock = Context.Reference<{ readonly offsetMillis: () => number }>(
  "durable-actors/FrameworkClock",
  { defaultValue: () => ({ offsetMillis: () => 0 }) },
)

/** The database clock as the framework sees it, in epoch milliseconds. */
export const databaseTime = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const clock = yield* FrameworkClock

  const rows = yield* sql<{
    now: string
  }>`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now`

  return Number(rows[0]!.now) + clock.offsetMillis()
})

const decodeCommandId = Schema.decodeEffect(CommandId)

// A versioned id this runner can't read: `v<n>.` for any n other than 1.
const OTHER_VERSION = /^v(?!1\.)\d{1,9}\./

export const checkIdentity = Effect.fnUntraced(function* (
  id: string,
  windowMs: number,
  now: number,
) {
  const invalid = (code: InvalidCommandId["code"]) =>
    ActorError.make({ reason: InvalidCommandId.make({ commandId: id, code }) })

  yield* decodeCommandId(id).pipe(
    Effect.mapError(() => invalid(OTHER_VERSION.test(id) ? "version" : "malformed")),
  )
  const { issuedAt, expiresAt } = commandTimes(id)

  if (expiresAt - issuedAt !== windowMs) return yield* invalid("window")

  if (issuedAt > now) return yield* invalid("future")

  if (now >= expiresAt)
    return yield* ActorError.make({ reason: CommandExpired.make({ commandId: id }) })
})

/**
 * Reads the database clock, the canonical payload, and any retained receipt
 * outside a turn in one statement, so external admission costs one round trip
 * before delivery. The receipt is only released after the identity and access
 * checks that follow.
 */
export const readAdmission = Effect.fnUntraced(function* (request: Request, routingKey: bigint) {
  const sql = yield* SqlClient.SqlClient
  const clock = yield* FrameworkClock

  const row = (yield* sql<
    { now: string; canonical: string } & { [K in keyof StoredReceipt]: StoredReceipt[K] | null }
  >`
    SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now,
      ${request.payload}::jsonb::text AS canonical,
      r.caller_key, r.command, r.payload_hash, r.outcome
    FROM (VALUES (1)) AS one (x)
    LEFT JOIN actor_receipts r ON r.routing_key = ${routingKey} AND r.tenant_id = ${request.ref.tenant}
      AND r.actor_type = ${request.ref.actor} AND r.actor_id = ${request.ref.id}
      AND r.command_id = ${request.commandId}`)[0]!

  return {
    now: Number(row.now) + clock.offsetMillis(),
    hash: yield* hashCanonical(row.canonical),
    receipt: row.outcome === null ? undefined : (row as StoredReceipt),
  }
})
