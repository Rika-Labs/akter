import { Crypto, Effect, Schema } from "effect"
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
