import { Effect, Option, Random, Schema } from "effect"

export class CommandConflict extends Schema.TaggedError<CommandConflict>()("CommandConflict", {
  commandId: Schema.String,
}) {}

export class CommandExpired extends Schema.TaggedError<CommandExpired>()("CommandExpired", {
  commandId: Schema.String,
}) {}

/**
 * `malformed`: not a v1 id. `future`: issued after the database clock; the
 * same id is admissible once the clock passes it. `window`: its lifetime is
 * not the deployment's retry window. `version`: a protocol version this
 * runner doesn't serve. `neverAdmitted`, set only by a client, is true when
 * that client minted the id and every attempt it sent was refused before any
 * turn, so no attempt can have committed.
 */
export class InvalidCommandId extends Schema.TaggedError<InvalidCommandId>()("InvalidCommandId", {
  commandId: Schema.String,
  code: Schema.Literals(["malformed", "future", "window", "version"]),
  neverAdmitted: Schema.optionalKey(Schema.Boolean),
}) {}

/**
 * `missing_credentials`, `invalid_credentials`, and `expired` come from a
 * served endpoint's auth provider; `access_denied` and `receipt_access_denied`
 * from the runtime's `authorize` hook.
 */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  code: Schema.Literals([
    "access_denied",
    "receipt_access_denied",
    "missing_credentials",
    "invalid_credentials",
    "expired",
  ]),
}) {}

/** A schema issue at a path, without the offending value. */
export const InputIssue = Schema.Struct({ path: Schema.String, message: Schema.String })

/**
 * A served request the boundary refused before any turn. Never in a typed
 * in-process handle's error channel.
 */
export class InvalidInput extends Schema.TaggedError<InvalidInput>()("InvalidInput", {
  code: Schema.Literals([
    "decode",
    "missing_command_id",
    "too_large",
    "unsupported_media_type",
    "unsupported_protocol",
    "unknown_route",
    "unservable_id",
    "origin_not_allowed",
    "unknown_event",
    "too_many_filters",
  ]),
  issues: Schema.optionalKey(Schema.Array(InputIssue)),
}) {}

/**
 * Produced only by clients, for a response that is neither a success, a
 * declared failure, nor an `ActorError` envelope. `retryable` says whether a
 * retry with the same command id is safe.
 */
export class TransportError extends Schema.TaggedError<TransportError>()("TransportError", {
  code: Schema.Literals(["network", "status", "decode", "defect"]),
  status: Schema.optionalKey(Schema.Int),
  retryable: Schema.Boolean,
}) {}

export class ActorUnavailable extends Schema.TaggedError<ActorUnavailable>()("ActorUnavailable", {
  cause: Schema.Defect(),
}) {}

export class Timeout extends Schema.TaggedError<Timeout>()("Timeout", {
  commandId: Schema.optionalKey(Schema.String),
}) {}

export class NotCreated extends Schema.TaggedError<NotCreated>()("NotCreated", {}) {}

export class MailboxFull extends Schema.TaggedError<MailboxFull>()("MailboxFull", {}) {}

/**
 * The runner already holds its `maxResidentActors` activations and cannot
 * start another, so the command was not admitted. It says nothing about an
 * earlier attempt with the same command id, which may have committed.
 */
export class RunnerAtCapacity extends Schema.TaggedError<RunnerAtCapacity>()(
  "RunnerAtCapacity",
  {},
) {}

export const Reason = Schema.Union([
  CommandConflict,
  CommandExpired,
  InvalidCommandId,
  Unauthorized,
  ActorUnavailable,
  Timeout,
  NotCreated,
  MailboxFull,
  RunnerAtCapacity,
  InvalidInput,
  TransportError,
])

export type Reason = typeof Reason.Type

export class ActorError extends Schema.TaggedError<ActorError>()("ActorError", { reason: Reason }) {
  get isRetryable(): boolean {
    if (isTransportError(this.reason)) return this.reason.retryable

    return isRetryableReason(this.reason)
  }

  /**
   * Milliseconds to wait before retrying with the same command id: 250 for
   * `ActorUnavailable`, 1,000 for `RunnerAtCapacity`, and 100 for
   * `MailboxFull`, each with ±50% jitter drawn once per error.
   */
  get retryAfter(): Option.Option<number> {
    const nominal = NOMINAL_RETRY_AFTER[this.reason._tag]

    if (nominal === undefined) return Option.none()

    let value = jittered.get(this)

    if (value === undefined) {
      value = Math.round(nominal * Effect.runSync(Random.nextBetween(0.5, 1.5)))
      jittered.set(this, value)
    }

    return Option.some(value)
  }

  override get message(): string {
    return this.reason.message
  }
}

const isTransportError = Schema.is(TransportError)

const isRetryableReason = Schema.is(
  Schema.Union([ActorUnavailable, Timeout, MailboxFull, RunnerAtCapacity]),
)

const NOMINAL_RETRY_AFTER: Partial<Record<Reason["_tag"], number>> = {
  ActorUnavailable: 250,
  RunnerAtCapacity: 1_000,
  MailboxFull: 100,
}

const jittered = new WeakMap<ActorError, number>()

/** Fixes `retryAfter` to a server's already-jittered value, as a client rebuilds a served envelope. */
export const withRetryAfter =
  (retryAfterMs: number) =>
  (error: ActorError): ActorError => {
    if (NOMINAL_RETRY_AFTER[error.reason._tag] !== undefined) jittered.set(error, retryAfterMs)

    return error
  }

export namespace ActorError {
  export type Of<Reasons extends Reason["_tag"]> = [Reasons] extends [never]
    ? never
    : ActorError & { readonly reason: Extract<Reason, { readonly _tag: Reasons }> }
}
