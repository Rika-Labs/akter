import { Schema } from "effect"

/** The caller's credentials or permission refused the request. */
export const Unauthorized = Schema.TaggedStruct("Unauthorized", {
  code: Schema.Literals([
    "missing_credentials",
    "invalid_credentials",
    "expired",
    "access_denied",
    "outcome_access_denied",
    "reauthorization_unavailable",
  ]),
})

/** A schema issue at a path, without the offending value. */
export const InputIssue = Schema.Struct({ path: Schema.String, message: Schema.String })

/** The payload or parameters failed their schema; nothing was admitted. */
export const InvalidInput = Schema.TaggedStruct("InvalidInput", {
  code: Schema.Literals(["decode", "unknown_member", "too_large"]),
  issues: Schema.optionalKey(Schema.Array(InputIssue)),
})

/** The external command id's `expiresAt` is at or before admission time. */
export const CommandExpired = Schema.TaggedStruct("CommandExpired", { commandId: Schema.String })

/**
 * The external command id was refused before execution. `future` carries the owner's admission
 * time in `now`; `conflict` means the id was used with another member or payload.
 */
export const InvalidCommandId = Schema.TaggedStruct("InvalidCommandId", {
  commandId: Schema.String,
  code: Schema.Literals(["malformed", "version", "future", "window", "conflict"]),
  now: Schema.optionalKey(Schema.Finite),
})

/** The owner could not run the action now; retry with the same command id. */
export const ActorUnavailable = Schema.TaggedStruct("ActorUnavailable", {})

/** The shard is draining or was lost by its owner; retry with the same command id. */
export const ShardMoved = Schema.TaggedStruct("ShardMoved", {})

/** The caller stopped waiting; the action may still become durable. */
export const Timeout = Schema.TaggedStruct("Timeout", {
  commandId: Schema.optionalKey(Schema.String),
})

/** The actor's queue is full. */
export const MailboxFull = Schema.TaggedStruct("MailboxFull", {})

/** The shard's committer inbox or the runner's residency limit is full. */
export const RunnerAtCapacity = Schema.TaggedStruct("RunnerAtCapacity", {})

/** A store or plan limit refused the request. */
export const QuotaExceeded = Schema.TaggedStruct("QuotaExceeded", {
  limit: Schema.String,
  retryAfter: Schema.optionalKey(Schema.Finite),
})

/** A stream or session ended. */
export const SessionEnded = Schema.TaggedStruct("SessionEnded", {
  cause: Schema.Literals([
    "ClientClosed",
    "ServerClosed",
    "SlowConsumer",
    "OwnerMoved",
    "ActorUnavailable",
    "Defect",
    "Terminated",
  ]),
  resync: Schema.Boolean,
})

/** Produced only by clients when no valid envelope arrived. */
export const TransportError = Schema.TaggedStruct("TransportError", {
  code: Schema.Literals(["network", "status", "decode", "defect"]),
  status: Schema.optionalKey(Schema.Int),
  retrySafe: Schema.Boolean,
})

/** Every reason an `ActorError` carries. */
export const Reason = Schema.Union([
  Unauthorized,
  InvalidInput,
  CommandExpired,
  InvalidCommandId,
  ActorUnavailable,
  ShardMoved,
  Timeout,
  MailboxFull,
  RunnerAtCapacity,
  QuotaExceeded,
  SessionEnded,
  TransportError,
]).pipe(Schema.toTaggedUnion("_tag"))

/** Every reason an `ActorError` carries. */
export type Reason = typeof Reason.Type

const retryAfterMillis: Partial<Record<Reason["_tag"], number>> = {
  ActorUnavailable: 250,
  ShardMoved: 250,
  RunnerAtCapacity: 1_000,
  MailboxFull: 100,
}

/**
 * The framework's one error. Declared application errors are never wrapped in it; defects are
 * not reasons. `isRetryable` and `retryAfter` follow from the reason alone.
 */
export class ActorError extends Schema.TaggedError<ActorError>()("ActorError", {
  reason: Reason,
}) {
  /** True exactly for the reasons a same-id retry may resolve. */
  get isRetryable(): boolean {
    return Reason.match(this.reason, {
      Unauthorized: ({ code }) => code === "reauthorization_unavailable",
      InvalidInput: () => false,
      CommandExpired: () => false,
      InvalidCommandId: () => false,
      ActorUnavailable: () => true,
      ShardMoved: () => true,
      Timeout: () => true,
      MailboxFull: () => true,
      RunnerAtCapacity: () => true,
      QuotaExceeded: ({ retryAfter }) => retryAfter !== undefined,
      SessionEnded: ({ cause }) =>
        cause === "SlowConsumer" || cause === "OwnerMoved" || cause === "ActorUnavailable",
      TransportError: ({ retrySafe }) => retrySafe,
    })
  }

  /** The base wait before a retry in milliseconds, before the client's jitter. */
  get retryAfter(): number | undefined {
    return retryAfterMillis[this.reason._tag]
  }
}

/** Which defect ended an action: its staged work is discarded and the defect is its outcome. */
export const DefectKind = Schema.Literals([
  "SynchronousActionViolation",
  "StateTooLarge",
  "ReplayMismatch",
  "DecodeFailure",
  "Thrown",
])

/** Which defect ended an action. */
export type DefectKind = typeof DefectKind.Type

/**
 * A defect a caller observes as the outcome of its action. It is never an `ActorError` reason:
 * nothing it staged survived, and retrying the same command id returns the same defect.
 */
export class ActionDefect extends Schema.TaggedError<ActionDefect>()("ActionDefect", {
  kind: DefectKind,
  actor: Schema.String,
  member: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `${this.actor}.${this.member}: ${this.kind}: ${this.detail}`
  }
}
