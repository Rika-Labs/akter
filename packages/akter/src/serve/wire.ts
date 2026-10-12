import { Effect, Schema } from "effect"
import { HttpServerResponse } from "effect/http"
import { type ActorError, Reason } from "../contract/errors.ts"
import { ErrorEnvelope } from "../rpc/group.ts"

const encodeEnvelope = Schema.encodeEffect(ErrorEnvelope)

/**
 * The HTTP status of a refusal answered before the RPC handler runs: `401` for credentials,
 * `403` for a refused origin or access, `429` for quotas and a full mailbox, `503` while the
 * runner or the auth provider is unavailable, `400` for input.
 */
export const statusOf = (reason: Reason): number =>
  Reason.match(reason, {
    Unauthorized: ({ code }) => {
      if (code === "reauthorization_unavailable") return 503
      return code === "access_denied" || code === "outcome_access_denied" ? 403 : 401
    },
    QuotaExceeded: () => 429,
    MailboxFull: () => 429,
    ActorUnavailable: () => 503,
    ShardMoved: () => 503,
    RunnerAtCapacity: () => 503,
    Timeout: () => 503,
    SessionEnded: () => 503,
    TransportError: () => 503,
    InvalidInput: () => 400,
    CommandExpired: () => 400,
    InvalidCommandId: () => 400,
  })

/** `retry-after` in whole seconds, rounded up. */
export const retryAfterSeconds = (milliseconds: number) => String(Math.ceil(milliseconds / 1000))

/**
 * The HTTP response for a refusal before the RPC handler: its status, the `ActorError`
 * envelope as JSON, `retry-after` when the error has a retry delay, and
 * `www-authenticate: Bearer` for credential failures.
 */
export const refusalResponse = (error: ActorError) => {
  const headers: Record<string, string> = {}
  const retryAfter = Reason.guards.QuotaExceeded(error.reason)
    ? error.reason.retryAfter
    : error.retryAfter
  if (retryAfter !== undefined) headers["retry-after"] = retryAfterSeconds(retryAfter)
  const status = statusOf(error.reason)
  if (status === 401) headers["www-authenticate"] = "Bearer"
  return Effect.map(Effect.orDie(encodeEnvelope(error)), (body) =>
    HttpServerResponse.jsonUnsafe(body, { status, headers }),
  )
}
