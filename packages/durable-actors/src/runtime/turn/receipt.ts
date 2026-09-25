import { Crypto, Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { ActorError, CommandConflict, Unauthorized } from "../../errors/actor.ts"
import { Outcome, type Request } from "../../handles/actors.ts"
import { callerKey } from "../../identity/caller.ts"

export const OutcomeJson = Schema.fromJsonString(Outcome)

/** SHA-256 over Postgres's JSONB text normalization of a payload, as stored in receipts. */
export const hashCanonical = Effect.fnUntraced(function* (canonical: string) {
  const bytes = yield* (yield* Crypto.Crypto)
    .digest("SHA-256", new TextEncoder().encode(canonical))
    .pipe(Effect.orDie)

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
})

export const payloadHash = Effect.fnUntraced(function* (payload: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ canonical: string }>`SELECT ${payload}::jsonb::text AS canonical`

  return yield* hashCanonical(rows[0]!.canonical)
})

export interface StoredReceipt {
  readonly caller_key: string
  readonly command: string
  readonly payload_hash: string
  readonly outcome: string
}

/** Access and conflict rules for a retained receipt, shared by admission and replay. */
export const checkReceipt = Effect.fnUntraced(function* (
  request: Request,
  hash: string,
  receipt: StoredReceipt,
) {
  if (receipt.caller_key !== callerKey(request.caller)) {
    return yield* ActorError.make({ reason: Unauthorized.make({ code: "receipt_access_denied" }) })
  }

  if (receipt.command !== request.command || receipt.payload_hash !== hash) {
    return yield* ActorError.make({
      reason: CommandConflict.make({ commandId: request.commandId }),
    })
  }

  return yield* Schema.decodeEffect(OutcomeJson)(receipt.outcome).pipe(Effect.orDie)
})

/**
 * Reads the database clock, the canonical payload, and any retained receipt
 * outside a turn in one statement, so external admission costs one round trip
 * before delivery. The receipt is only released after the identity and access
 * checks that follow.
 */
export const readAdmission = Effect.fnUntraced(function* (request: Request, routingKey: bigint) {
  const sql = yield* SqlClient.SqlClient

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
    now: Number(row.now),
    hash: yield* hashCanonical(row.canonical),
    receipt: row.outcome === null ? undefined : (row as StoredReceipt),
  }
})
