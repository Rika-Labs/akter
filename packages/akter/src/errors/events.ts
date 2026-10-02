import { Schema } from "effect"

/** The cursor is malformed or ahead of every event this actor has committed. */
export class UnknownCursor extends Schema.TaggedError<UnknownCursor>()("UnknownCursor", {
  cursor: Schema.String,
}) {}

/**
 * Events after the cursor were pruned, so replay cannot be continuous; the
 * reader must resynchronize from state instead of resuming.
 */
export class RetentionGap extends Schema.TaggedError<RetentionGap>()("RetentionGap", {
  cursor: Schema.String,
}) {}
