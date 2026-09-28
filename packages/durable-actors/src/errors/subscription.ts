import { Schema } from "effect"

/**
 * Why the relay could not deliver or register a subscription: a route that
 * failed, a source with no recorded placement, or a declaration this runner
 * lacks. It backs the row off with `last_error` rather than skipping it.
 */
export class SubscriptionFailure extends Schema.TaggedError<SubscriptionFailure>()(
  "SubscriptionFailure",
  { message: Schema.String },
) {}
