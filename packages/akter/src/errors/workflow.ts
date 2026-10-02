import { Schema } from "effect"

/**
 * The execution id is not a `w1.` id, is malformed, or names another tenant,
 * actor, or workflow member than the one it is used with.
 */
export class InvalidExecutionId extends Schema.TaggedError<InvalidExecutionId>()(
  "InvalidExecutionId",
  { executionId: Schema.String },
) {}

/** A workflow key is empty or longer than 256 UTF-8 bytes. */
export class InvalidExecutionKey extends Schema.TaggedError<InvalidExecutionKey>()(
  "InvalidExecutionKey",
  { bytes: Schema.Int },
) {}

/**
 * An activity's actor call would be sent past its derived command id's expiry
 * bound, where the receiver's receipt may be pruned; the call is not sent and
 * its outcome is unknown.
 */
export class ActivityOutcomeUnknown extends Schema.TaggedError<ActivityOutcomeUnknown>()(
  "ActivityOutcomeUnknown",
  { executionId: Schema.String, step: Schema.String },
) {}
