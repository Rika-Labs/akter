import { Crypto, Effect, Schema } from "effect"
import { ActorError, CommandConflict, Unauthorized } from "../../errors/actor.ts"
import { Outcome, type Request } from "../../handles/actors.ts"
import { callerKey } from "../../identity/caller.ts"

const OutcomeJson = Schema.fromJsonString(Outcome)

const encodeOutcomeJson = Schema.encodeEffect(OutcomeJson)

/** Encodes an outcome to the JSON text a receipt stores. */
export const encodeOutcome = (outcome: Outcome) => encodeOutcomeJson(outcome)

const decodeOutcome = Schema.decodeEffect(OutcomeJson)

const utf8 = new TextEncoder()

/** SHA-256 over Postgres's JSONB text normalization of a payload, as stored in receipts. */
export const hashCanonical = Effect.fnUntraced(function* (canonical: string) {
  const bytes = yield* (yield* Crypto.Crypto)
    .digest("SHA-256", utf8.encode(canonical))
    .pipe(Effect.orDie)

  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex")
})

/** A retained `actor_receipts` row as read back: the admission facts a replay checks and the encoded outcome it returns. */
export interface StoredReceipt {
  readonly caller_key: string
  readonly command: string
  readonly payload_hash: string
  readonly outcome: string
}

/**
 * Access and conflict rules for a retained receipt, shared by admission and
 * replay. Fails with `ActorError` `Unauthorized` when the caller differs and
 * `CommandConflict` when the command or payload hash differs; otherwise it
 * returns the stored outcome. A stored outcome that cannot be decoded is a defect.
 */
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

  return yield* decodeOutcome(receipt.outcome).pipe(Effect.orDie)
})
