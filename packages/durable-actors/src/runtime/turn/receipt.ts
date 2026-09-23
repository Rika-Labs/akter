import { Crypto, Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { ActorError, CommandConflict, Unauthorized } from "../../errors/actor.ts"
import { Outcome, type Request } from "../../handles/actors.ts"
import { callerKey } from "../../identity/caller.ts"

export const OutcomeJson = Schema.fromJsonString(Outcome)

export const payloadHash = Effect.fnUntraced(function* (payload: string) {
  const crypto = yield* Crypto.Crypto
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ canonical: string }>`SELECT ${payload}::jsonb::text AS canonical`

  const bytes = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(rows[0]!.canonical))
    .pipe(Effect.orDie)

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
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

/** Reads a retained receipt outside a turn, before delivering to the actor. */
export const resolveReceipt = Effect.fnUntraced(function* (
  request: Request,
  hash: string,
  routingKey: bigint,
) {
  const sql = yield* SqlClient.SqlClient

  const rows = yield* sql<StoredReceipt>`
    SELECT caller_key, command, payload_hash, outcome FROM actor_receipts
    WHERE routing_key = ${routingKey} AND tenant_id = ${request.ref.tenant}
      AND actor_type = ${request.ref.actor} AND actor_id = ${request.ref.id}
      AND command_id = ${request.commandId}`

  const receipt = rows[0]

  if (receipt === undefined) return undefined

  return yield* checkReceipt(request, hash, receipt)
})
