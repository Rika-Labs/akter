import { Schema } from "effect"
import { ActorRef, Caller } from "../identity/caller.ts"

/**
 * How a command or query ended, with its value or declared failure still
 * JSON-encoded. A defect carries only its cause and is never a declared error.
 */
export const Outcome = Schema.TaggedUnion({
  Success: { value: Schema.String },
  Failure: { value: Schema.String },
  Defect: { cause: Schema.Defect() },
  /**
   * A subscription delivery the subscriber settled without running its
   * handler; only the relay sees it, and it commits no receipt.
   */
  Acknowledged: {
    reason: Schema.Literals(["AlreadyApplied", "Stale", "Unsubscribed", "NotCreated"]),
  },
})

/** How a command or query ended: an encoded success or declared failure, or a defect. */
export type Outcome = typeof Outcome.Type

/**
 * A command's outcome, with the commit version its caller's later queries
 * wait for once the turn committed or replayed a receipt. A defect carries none.
 */
export const Executed = Schema.Struct({
  outcome: Outcome,
  version: Schema.optionalKey(Schema.String),
})

/** A command's outcome and the commit version its caller's later queries wait for. */
export type Executed = typeof Executed.Type

/**
 * What a subscription delivery carries beside its command id: the source-side
 * row it came from, the subscription's epoch, and the source position it
 * applies. Only the relay sets it; the subscriber's cursor row is checked and
 * advanced against it in the delivery's own turn.
 */
export const SubscriptionEnvelope = Schema.Struct({
  subscription: Schema.NonEmptyString,
  sourceType: Schema.NonEmptyString,
  sourceId: Schema.NonEmptyString,
  epoch: Schema.String,
  kind: Schema.Literals(["event", "gap", "rejected"]),
  /** An event's cursor, a gap's `resumeAfter`, or a rejected subscription's cursor. */
  position: Schema.String,
})

/** The relay's metadata for one subscription delivery. */
export type SubscriptionEnvelope = typeof SubscriptionEnvelope.Type

/**
 * One command or query addressed to an actor, with its encoded payload.
 * `commandId` is the operation's identity: a retry with the same id replays
 * the receipt instead of running again.
 */
export const Request = Schema.Struct({
  ref: ActorRef,
  caller: Caller,
  command: Schema.NonEmptyString,
  commandId: Schema.String,
  payload: Schema.String,
  /**
   * Set only by the runtime on external admission. Such a turn rejects an
   * expired id that has no receipt, so pruning a receipt while its retry
   * waits for the turn cannot run the command again.
   */
  external: Schema.optionalKey(Schema.Boolean),
  /**
   * The sender of the committed outbox row the relay claimed. The rest of
   * that row's delivery is this request's target, caller, command id,
   * command, and payload. Only the relay supplies this provenance, and
   * external admission rejects it rather than trusting a presented proof.
   */
  intent: Schema.optionalKey(ActorRef),
  delivery: Schema.optionalKey(SubscriptionEnvelope),
  /**
   * When the admitting runner sent the command to its owner, by that
   * runner's clock; the owner reports the wait as mailbox age. Not part of
   * the command's identity.
   */
  queuedAtMs: Schema.optionalKey(Schema.Finite),
  /**
   * Names one read attempt for the host's usage accounting; a watch reuses it
   * for every rerun. A host that supplies it must have bound it to an
   * authenticated assertion. Not part of the request's identity.
   */
  usageToken: Schema.optionalKey(Schema.NonEmptyString),
})

/** One command or query addressed to an actor. */
export type Request = typeof Request.Type
