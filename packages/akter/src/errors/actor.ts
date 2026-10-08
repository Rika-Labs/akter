import { Effect, Option, Random, Schema } from "effect"

/** A retry reused a command id with a different command or payload, so nothing ran. */
export class CommandConflict extends Schema.TaggedError<CommandConflict>()("CommandConflict", {
  commandId: Schema.String,
}) {}

/**
 * The command id passed its expiry and no receipt remains to replay, so the
 * command is not run. It says nothing about whether an earlier attempt
 * committed; retry only with a new operation, never a new id for the same one.
 */
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

const CREDENTIAL_CODES: ReadonlySet<string> = new Set([
  "missing_credentials",
  "invalid_credentials",
  "expired",
])

/**
 * `missing_credentials`, `invalid_credentials`, and `expired` come from a
 * served endpoint's auth provider; `access_denied` and `receipt_access_denied`
 * from an actor's `access` policy or the runtime's `authorize` hook.
 */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  code: Schema.Literals([
    "access_denied",
    "receipt_access_denied",
    "reauthorization_unavailable",
    "missing_credentials",
    "invalid_credentials",
    "expired",
  ]),
}) {
  /**
   * Whether the credential failed rather than the caller's permission: a
   * served `401` with a `Bearer` challenge, refused before any turn ran, which
   * a fresh credential can resolve. Every other code is a `403` decision.
   */
  get isCredential(): boolean {
    return CREDENTIAL_CODES.has(this.code)
  }
}

/** A schema issue at a path, without the offending value. */
const InputIssue = Schema.Struct({ path: Schema.String, message: Schema.String })

/**
 * A served request the boundary refused before any turn. Never in a typed
 * in-process handle's error channel. A served watch ends with `not_watchable`
 * when a rerun reads something no commit signal covers, such as its placement
 * group, and a watch request for a query not declared `watch: true` is refused
 * with it; an in-process watch dies with it instead.
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
    "unknown_content",
    "not_watchable",
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

/** The runtime could not run the command now, for example an unreachable owner or database; `cause` says why. Retry with the same command id. */
export class ActorUnavailable extends Schema.TaggedError<ActorUnavailable>()("ActorUnavailable", {
  cause: Schema.Defect(),
  /** Preserved across runner RPCs so a pre-turn refusal is not retried inside the receiving runtime. */
  overloaded: Schema.optionalKey(Schema.Boolean),
}) {}

/** The caller stopped waiting for a reply (`deliveryTimeout`, or `commandTimeout` for a query). The turn is not cancelled and may still commit, so retry with the same command id. */
export class Timeout extends Schema.TaggedError<Timeout>()("Timeout", {
  commandId: Schema.optionalKey(Schema.String),
}) {}

/** A command other than `policy.createdBy` reached an actor that does not exist yet; its handler did not run and no receipt was written. */
export class NotCreated extends Schema.TaggedError<NotCreated>()("NotCreated", {}) {}

/** The activation's mailbox holds `policy.mailboxCapacity` commands, so the command was not admitted. */
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

/**
 * The hosted organization reached one of its plan's hard caps. `cap` names it,
 * and `limit` and `used` are in that cap's units: cents for `spend`, open
 * connections for `connections`, compute unit-hours this period for
 * `compute`, and decimal gigabytes of pooled managed database storage for
 * `storage`. A `connections` refusal clears as connections close, so it is
 * retryable with the same command id after `retryAfterMs`; the others hold
 * until usage drops, the period resets or the plan changes.
 */
export class QuotaExceeded extends Schema.TaggedError<QuotaExceeded>()("QuotaExceeded", {
  organizationId: Schema.String,
  period: Schema.String,
  cap: Schema.Literals(["compute", "storage", "connections", "spend"]),
  limit: Schema.Finite,
  used: Schema.Finite,
  retryAfterMs: Schema.Finite,
}) {}

const RETRYABLE_SESSION_ENDS = new Set([
  "SlowConsumer",
  "HolderShutdown",
  "HolderLost",
  "OwnerLost",
  "ActivationEnded",
  "ActorUnavailable",
])

/**
 * A connection or stream ended. `resync` tells the client that frames may have
 * been lost, so it must replay events from its cursor after reconnecting.
 */
export class SessionEnded extends Schema.TaggedError<SessionEnded>()("SessionEnded", {
  cause: Schema.Literals([
    "ClientClosed",
    "ServerClosed",
    "SlowConsumer",
    "HolderShutdown",
    "HolderLost",
    "OwnerLost",
    "ActivationEnded",
    "ActorUnavailable",
    "Defect",
    "Terminated",
  ]),
  resync: Schema.Boolean,
  retryAfterMs: Schema.optional(Schema.Finite),
}) {
  get isRetryable(): boolean {
    return RETRYABLE_SESSION_ENDS.has(this.cause)
  }
}

/** Every reason an `ActorError` carries. */
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
  QuotaExceeded,
  SessionEnded,
  InvalidInput,
  TransportError,
])

/** One `Reason` value. */
export type Reason = typeof Reason.Type

/**
 * The runtime's own failure for a call: `reason` says which. Declared command
 * errors are never wrapped in it. `isRetryable` and `retryAfter` say whether
 * and when a retry with the same command id is safe.
 */
export class ActorError extends Schema.TaggedError<ActorError>()("ActorError", { reason: Reason }) {
  get isRetryable(): boolean {
    if (Schema.is(SessionEnded)(this.reason)) return this.reason.isRetryable

    if (Schema.is(Unauthorized)(this.reason))
      return this.reason.code === "reauthorization_unavailable"

    if (Schema.is(QuotaExceeded)(this.reason)) return this.reason.cap === "connections"

    if (isTransportError(this.reason)) return this.reason.retryable

    return isRetryableReason(this.reason)
  }

  /**
   * Milliseconds to wait before retrying with the same command id: 250 for
   * `ActorUnavailable`, 1,000 for `RunnerAtCapacity`, and 100 for
   * `MailboxFull`, each with ±50% jitter drawn once per error.
   */
  get retryAfter(): Option.Option<number> {
    if (Schema.is(QuotaExceeded)(this.reason)) return Option.some(this.reason.retryAfterMs)

    if (Schema.is(SessionEnded)(this.reason))
      return Option.fromUndefinedOr(this.reason.retryAfterMs)

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
  /** An `ActorError` whose reason is one of `Reasons`, for handle signatures that name what can occur. */
  export type Of<Reasons extends Reason["_tag"]> = [Reasons] extends [never]
    ? never
    : ActorError & { readonly reason: Extract<Reason, { readonly _tag: Reasons }> }
}
